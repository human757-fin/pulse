export type VoiceState = 'disconnected' | 'connecting' | 'reconnecting' | 'waiting' | 'connected' | 'error';
export type VoiceUpdate = { state: VoiceState; message: string; peers: string[] };

type Signal = { type: string; [key: string]: unknown };
const voiceProtocol = 'pulse-aesgcm-v1';
type JoinOptions = { endpoint: string; room: string; friendId: string; authToken: string; voiceKey: ArrayBuffer };

export class VoiceClient {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private peers = new Map<string, RTCPeerConnection>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private stopped = false;
  private peerNames = new Map<string, string>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private muted = false;
  private turnServers: RTCIceServer[] = [];
  private iceTransportPolicy: RTCIceTransportPolicy = 'all';
  private cryptoWorker?: Worker;
  private voiceKey?: ArrayBuffer;
  private joinOptions?: JoinOptions;
  private reconnectTimer?: number;
  private reconnectAttempts = 0;

  constructor(private onUpdate: (update: VoiceUpdate) => void) {}

  async join(endpoint: string, room: string, friendId: string, authToken: string, voiceKey: ArrayBuffer) {
    this.stopped = false;
    this.joinOptions = { endpoint, room, friendId, authToken, voiceKey };
    this.reconnectAttempts = 0;
    this.emit('connecting', 'Requesting microphone…');
    try {
      const Transform = (window as Window & { RTCRtpScriptTransform?: new (worker: Worker, options?: unknown) => unknown }).RTCRtpScriptTransform;
      if (!Transform || !('transform' in RTCRtpSender.prototype) || !('transform' in RTCRtpReceiver.prototype)) throw new Error('This browser cannot encrypt and decrypt Pulse voice. Update Microsoft Edge/WebView2 and retry.');
      const parsedEndpoint = new URL(endpoint);
      if (parsedEndpoint.protocol !== 'wss:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname)) throw new Error('Use a secure wss:// voice address to protect your Pulse sign-in.');
      this.voiceKey = voiceKey;
      this.cryptoWorker = new Worker(new URL('./voice-crypto-worker.ts', import.meta.url), { type: 'module' });
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this WebView. Update Microsoft Edge WebView2 and retry.');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.stream.getAudioTracks().forEach(track => { track.contentHint = 'speech'; });
      if (this.stopped) { this.stream.getTracks().forEach(track => track.stop()); this.stream = undefined; return; }
      await this.openSignaling();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not join voice.');
    }
  }

  leave() {
    this.stopped = true;
    this.joinOptions = undefined;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'leave' }));
    this.socket?.close();
    this.socket = undefined;
    this.clearPeers();
    this.cryptoWorker?.terminate(); this.cryptoWorker = undefined; this.voiceKey = undefined;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
    this.muted = false;
    this.emit('disconnected', 'Not connected');
  }

  toggleMute() {
    this.muted = !this.muted;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    return this.muted;
  }

  private async handle(msg: Signal) {
    if (msg.type === 'joined') {
      if (msg.voiceProtocol !== voiceProtocol) { this.fail('Voice versions do not match. Update Pulse on both devices and restart the Pulse server.'); return; }
      this.reconnectAttempts = 0;
      this.turnServers = (msg.iceServers as RTCIceServer[]) || [];
      this.iceTransportPolicy = msg.iceTransportPolicy === 'relay' && this.turnServers.length ? 'relay' : 'all';
      const peers = (msg.peers as Array<{ id: string; name: string }>) || [];
      for (const peer of peers) {
        this.peerNames.set(peer.id, peer.name);
        await this.makeOffer(peer.id);
      }
      this.emit('waiting', peers.length ? 'Connecting to your friend…' : 'Waiting for someone to join…');
      return;
    }
    if (msg.type === 'peer-joined') {
      this.peerNames.set(String(msg.id), String(msg.name));
      this.emit('waiting', `${String(msg.name)} joined · connecting…`);
      return;
    }
    if (msg.type === 'peer-left') {
      const id = String(msg.id);
      this.peers.get(id)?.close();
      this.peers.delete(id);
      const audio = this.audioElements.get(id);
      audio?.pause();
      this.audioElements.delete(id);
      this.peerNames.delete(id);
      this.emit('waiting', 'They left voice. Waiting for someone to join…');
      return;
    }
    if (msg.type === 'offer') {
      const from = String(msg.from);
      const pc = this.makePeer(from);
      await pc.setRemoteDescription(msg.description as RTCSessionDescriptionInit);
      await this.flushIce(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ type: 'answer', to: from, description: pc.localDescription });
      return;
    }
    if (msg.type === 'answer') {
      const from = String(msg.from);
      const pc = this.peers.get(from);
      if (pc) { await pc.setRemoteDescription(msg.description as RTCSessionDescriptionInit); await this.flushIce(from, pc); }
      return;
    }
    if (msg.type === 'ice') {
      const candidate = msg.candidate as RTCIceCandidateInit;
      const from = String(msg.from);
      const pc = this.peers.get(from);
      if (!pc?.remoteDescription) this.pendingIce.set(from, [...(this.pendingIce.get(from) || []), candidate]);
      else await pc.addIceCandidate(candidate).catch(() => undefined);
      return;
    }
    if (msg.type === 'error') this.fail(String(msg.message || 'Voice connection failed.'));
  }

  private async makeOffer(id: string) {
    const pc = this.makePeer(id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: 'offer', to: id, description: pc.localDescription });
  }

  private async openSignaling() {
    const options = this.joinOptions;
    if (!options || this.stopped) return;
    const socket = new WebSocket(options.endpoint);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let opened = false; let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true; socket.close(); reject(new Error('Signaling server timed out.'));
      }, 8000);
      socket.onopen = () => {
        opened = true; settled = true; window.clearTimeout(timer);
        if (this.stopped) { socket.close(); resolve(); return; }
        socket.onmessage = event => { void this.handle(JSON.parse(String(event.data)) as Signal).catch(error => this.fail(error instanceof Error ? error.message : 'Voice setup failed.')); };
        socket.send(JSON.stringify({ type: 'join', room: options.room, friendId: options.friendId, authToken: options.authToken, voiceProtocol }));
        resolve();
      };
      socket.onerror = () => {
        if (!opened && !settled) { settled = true; window.clearTimeout(timer); reject(new Error(`Can’t reach voice server at ${options.endpoint}`)); }
      };
      socket.onclose = () => {
        if (!opened && !settled) { settled = true; window.clearTimeout(timer); reject(new Error(`Voice server closed before connecting at ${options.endpoint}`)); }
        else if (!this.stopped) this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect() {
    if (this.stopped || !this.joinOptions || this.reconnectTimer !== undefined) return;
    this.socket = undefined;
    this.clearPeers();
    const delay = Math.min(15_000, 1000 * (2 ** this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.emit('reconnecting', 'Voice server restarted · reconnecting…');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSignaling().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private clearPeers() {
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.audioElements.forEach(audio => { audio.pause(); audio.srcObject = null; audio.remove(); });
    this.audioElements.clear();
    this.peerNames.clear();
    this.pendingIce.clear();
  }

  private async flushIce(id: string, pc: RTCPeerConnection) {
    const candidates = this.pendingIce.get(id) || [];
    this.pendingIce.delete(id);
    for (const candidate of candidates) await pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private makePeer(id: string) {
    const old = this.peers.get(id);
    if (old) return old;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...this.turnServers], iceTransportPolicy: this.iceTransportPolicy });
    this.peers.set(id, pc);
    this.stream?.getAudioTracks().forEach(track => {
      const sender = pc.addTrack(track, this.stream!);
      this.applyTransform(sender, 'encrypt');
    });
    pc.onicecandidate = event => { if (event.candidate) this.send({ type: 'ice', to: id, candidate: event.candidate }); };
    pc.ontrack = event => {
      try { this.applyTransform(event.receiver, 'decrypt'); }
      catch (error) { this.fail(error instanceof Error ? error.message : 'Could not decrypt incoming voice.'); return; }
      let audio = this.audioElements.get(id);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.volume = 1;
        audio.dataset.voicePeer = id;
        document.body.append(audio);
        this.audioElements.set(id, audio);
      }
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => this.emit('connected', 'Voice connected · click Pulse to hear audio'));
      this.emit('connected', `In voice with ${this.peerNames.get(id) || 'a friend'}`);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.emit('connected', `In voice with ${this.peerNames.get(id) || 'a friend'}`);
      if (pc.connectionState === 'failed') this.fail('Peer connection failed. Check network or TURN settings.');
    };
    return pc;
  }

  private applyTransform(endpoint: RTCRtpSender | RTCRtpReceiver, mode: 'encrypt' | 'decrypt') {
    const Transform = (window as Window & { RTCRtpScriptTransform?: new (worker: Worker, options?: unknown) => RTCRtpScriptTransform }).RTCRtpScriptTransform;
    if (!Transform || !this.cryptoWorker || !this.voiceKey) throw new Error('Encrypted voice is unavailable in this browser.');
    const rtpEndpoint = endpoint as (RTCRtpSender | RTCRtpReceiver) & { transform?: RTCRtpScriptTransform | null };
    const transform = new Transform(this.cryptoWorker, { mode, keyBytes: this.voiceKey });
    rtpEndpoint.transform = transform;
    if (rtpEndpoint.transform !== transform) throw new Error('This browser could not attach encrypted voice. Update Microsoft Edge/WebView2 and retry.');
  }

  private send(message: object) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private emit(state: VoiceState, message: string) { this.onUpdate({ state, message, peers: [...this.peerNames.values()] }); }
  private fail(message: string) { if (this.stopped) return; this.emit('error', message); this.leave(); this.emit('error', message); }
}
