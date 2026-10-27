export type VoiceState = 'disconnected' | 'connecting' | 'waiting' | 'connected' | 'error';
export type VoiceUpdate = { state: VoiceState; message: string; peers: string[] };

type Signal = { type: string; [key: string]: unknown };

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

  constructor(private onUpdate: (update: VoiceUpdate) => void) {}

  async join(endpoint: string, room: string, name: string, token: string) {
    this.stopped = false;
    this.emit('connecting', 'Requesting microphone…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this WebView. Update Microsoft Edge WebView2 and retry.');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (this.stopped) { this.stream.getTracks().forEach(track => track.stop()); this.stream = undefined; return; }
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Signaling server timed out.')), 8000);
        socket.onopen = () => { window.clearTimeout(timer); resolve(); };
        socket.onerror = () => { window.clearTimeout(timer); reject(new Error(`Can’t reach voice server at ${endpoint}`)); };
      });
      if (this.stopped) return;
      socket.onmessage = event => { void this.handle(JSON.parse(String(event.data)) as Signal); };
      socket.onclose = () => { if (!this.stopped) this.fail('Voice server disconnected.'); };
      socket.send(JSON.stringify({ type: 'join', room, name, token }));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not join voice.');
    }
  }

  leave() {
    this.stopped = true;
    this.socket?.send(JSON.stringify({ type: 'leave' }));
    this.socket?.close();
    this.socket = undefined;
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.audioElements.forEach(audio => { audio.pause(); audio.srcObject = null; });
    this.audioElements.clear();
    this.peerNames.clear();
    this.pendingIce.clear();
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
    this.stream?.getAudioTracks().forEach(track => pc.addTrack(track, this.stream!));
    pc.onicecandidate = event => { if (event.candidate) this.send({ type: 'ice', to: id, candidate: event.candidate }); };
    pc.ontrack = event => {
      let audio = this.audioElements.get(id);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
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

  private send(message: object) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private emit(state: VoiceState, message: string) { this.onUpdate({ state, message, peers: [...this.peerNames.values()] }); }
  private fail(message: string) { if (this.stopped) return; this.emit('error', message); this.leave(); this.emit('error', message); }
}
