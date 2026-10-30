export type VoiceState = 'disconnected' | 'connecting' | 'reconnecting' | 'waiting' | 'connected' | 'error';
export type VoiceUpdate = { state: VoiceState; message: string; peers: string[]; sharingScreen: boolean; videoPeers: string[] };
export type ScreenShareSettings = { width: number; height: number; fps: number };

type Signal = { type: string; [key: string]: unknown };
const voiceProtocol = 'pulse-dtls-srtp-screen-v2';
type JoinOptions = { endpoint: string; room: string; friendId: string; authToken: string; voiceKey: ArrayBuffer };

export class VoiceClient {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private peers = new Map<string, RTCPeerConnection>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private videoSenders = new Map<string, RTCRtpSender>();
  private remoteVideos = new Map<string, MediaStream>();
  private screenStream?: MediaStream;
  private stopped = false;
  private peerNames = new Map<string, string>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private muted = false;
  private inputDeviceId = '';
  private outputDeviceId = '';
  private turnServers: RTCIceServer[] = [];
  private iceTransportPolicy: RTCIceTransportPolicy = 'all';
  private voiceKey?: ArrayBuffer;
  private joinOptions?: JoinOptions;
  private reconnectTimer?: number;
  private reconnectAttempts = 0;
  private currentState: VoiceState = 'disconnected';
  private currentMessage = 'Not connected';

  constructor(private onUpdate: (update: VoiceUpdate) => void) {}

  setPreferredAudioDevices(inputDeviceId: string, outputDeviceId: string) {
    this.inputDeviceId = inputDeviceId;
    this.outputDeviceId = outputDeviceId;
  }

  async setAudioInputDevice(deviceId: string) {
    if (deviceId === this.inputDeviceId) return;
    if (!this.stream) { this.inputDeviceId = deviceId; return; }
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      video: false,
    });
    const nextTrack = nextStream.getAudioTracks()[0];
    if (!nextTrack) { nextStream.getTracks().forEach(track => track.stop()); throw new Error('That microphone did not provide an audio track.'); }
    nextTrack.contentHint = 'speech';
    nextTrack.enabled = !this.muted;
    try {
      const senders = [...this.peers.values()].flatMap(peer => peer.getSenders().filter(sender => sender.track?.kind === 'audio'));
      await Promise.all(senders.map(sender => sender.replaceTrack(nextTrack)));
      const previousStream = this.stream;
      this.stream = nextStream;
      this.inputDeviceId = deviceId;
      previousStream.getTracks().forEach(track => track.stop());
    } catch (error) {
      nextStream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }

  async setAudioOutputDevice(deviceId: string) {
    const supportsOutputSelection = 'setSinkId' in HTMLMediaElement.prototype;
    if (deviceId && !supportsOutputSelection) throw new Error('Speaker selection is unavailable in this version of Windows WebView. Update Pulse and WebView2.');
    const mediaElements = [...this.audioElements.values()];
    const setSinkId = (audio: HTMLAudioElement, sinkId: string) => {
      const media = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      return media.setSinkId ? media.setSinkId(sinkId) : Promise.resolve();
    };
    await Promise.all(mediaElements.map(audio => setSinkId(audio, deviceId)));
    this.outputDeviceId = deviceId;
  }

  async join(endpoint: string, room: string, friendId: string, authToken: string, voiceKey: ArrayBuffer) {
    this.stopped = false;
    this.joinOptions = { endpoint, room, friendId, authToken, voiceKey };
    this.reconnectAttempts = 0;
    this.emit('connecting', 'Requesting microphone…');
    try {
      const parsedEndpoint = new URL(endpoint);
      if (parsedEndpoint.protocol !== 'wss:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname)) throw new Error('Use a secure wss:// voice address to protect your Pulse sign-in.');
      this.voiceKey = voiceKey;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this WebView. Update Microsoft Edge WebView2 and retry.');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : {}) },
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
    this.screenStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.screenStream = undefined;
    this.voiceKey = undefined;
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

  getLocalScreenStream() { return this.screenStream; }
  getRemoteScreenStream(peerId: string) { return this.remoteVideos.get(peerId); }

  async startScreenShare(settings: ScreenShareSettings) {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is unavailable. Update Pulse and Microsoft Edge WebView2.');
    if (this.screenStream) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) { stream.getTracks().forEach(item => item.stop()); throw new Error('The selected screen did not provide a video track.'); }
    try {
      await track.applyConstraints({ width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } });
      await Promise.all([...this.videoSenders.values()].map(sender => sender.replaceTrack(track)));
      this.screenStream = stream;
      track.onended = () => { void this.stopScreenShare(); };
      this.emitCurrent();
    } catch (error) {
      stream.getTracks().forEach(item => item.stop());
      throw new Error(error instanceof Error ? `Could not start screen sharing: ${error.message}` : 'Could not start screen sharing.');
    }
  }

  async updateScreenShareSettings(settings: ScreenShareSettings) {
    const track = this.screenStream?.getVideoTracks()[0];
    if (track) await track.applyConstraints({ width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: settings.fps, max: settings.fps } });
  }

  async stopScreenShare() {
    const stream = this.screenStream;
    if (!stream) return;
    const track = stream.getVideoTracks()[0]; if (track) track.onended = null;
    this.screenStream = undefined;
    await Promise.all([...this.videoSenders.values()].map(sender => sender.replaceTrack(null).catch(() => undefined)));
    stream.getTracks().forEach(item => item.stop());
    this.emitCurrent();
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
      this.remoteVideos.delete(id);
      this.videoSenders.delete(id);
      this.peerNames.delete(id);
      this.emit('waiting', 'They left voice. Waiting for someone to join…');
      return;
    }
    if (msg.type === 'offer') {
      const from = String(msg.from);
      const description = msg.description as RTCSessionDescriptionInit;
      if (!await this.verifyDescription(description, String(msg.voiceProof || ''))) { this.fail('Voice peer verification failed. Update both Pulse clients before calling.'); return; }
      const pc = this.makePeer(from);
      await this.preparePeerVideo(from);
      await pc.setRemoteDescription(description);
      await this.flushIce(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ type: 'answer', to: from, description: pc.localDescription, voiceProof: await this.signDescription(pc.localDescription!) });
      return;
    }
    if (msg.type === 'answer') {
      const from = String(msg.from);
      const pc = this.peers.get(from);
      const description = msg.description as RTCSessionDescriptionInit;
      if (!await this.verifyDescription(description, String(msg.voiceProof || ''))) { this.fail('Voice peer verification failed. Update both Pulse clients before calling.'); return; }
      if (pc) { await pc.setRemoteDescription(description); await this.flushIce(from, pc); }
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
    await this.preparePeerVideo(id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: 'offer', to: id, description: pc.localDescription, voiceProof: await this.signDescription(pc.localDescription!) });
  }

  private descriptionProofData(description: RTCSessionDescriptionInit) {
    const room = this.joinOptions?.room;
    if (!room || !description.sdp) throw new Error('Could not verify this voice connection.');
    const fingerprints = [...description.sdp.matchAll(/^a=fingerprint:[^\r\n]+$/gmi)].map(match => match[0].trim().toLowerCase()).sort();
    if (!fingerprints.length) throw new Error('This browser did not provide an encrypted voice fingerprint.');
    return new TextEncoder().encode(`${voiceProtocol}\n${room}\n${description.type}\n${fingerprints.join('\n')}`);
  }

  private async signDescription(description: RTCSessionDescriptionInit) {
    if (!this.voiceKey) throw new Error('Voice encryption key is unavailable.');
    const key = await crypto.subtle.importKey('raw', this.voiceKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const proof = new Uint8Array(await crypto.subtle.sign('HMAC', key, this.descriptionProofData(description)));
    return btoa(Array.from(proof, byte => String.fromCharCode(byte)).join(''));
  }

  private async verifyDescription(description: RTCSessionDescriptionInit, proof: string) {
    if (!this.voiceKey || !proof) return false;
    try {
      const key = await crypto.subtle.importKey('raw', this.voiceKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const signature = Uint8Array.from(atob(proof), character => character.charCodeAt(0));
      return await crypto.subtle.verify('HMAC', key, signature, this.descriptionProofData(description));
    } catch { return false; }
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
    this.remoteVideos.clear();
    this.videoSenders.clear();
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
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    this.videoSenders.set(id, videoTransceiver.sender);
    this.stream?.getAudioTracks().forEach(track => {
      pc.addTrack(track, this.stream!);
    });
    pc.onicecandidate = event => { if (event.candidate) this.send({ type: 'ice', to: id, candidate: event.candidate }); };
    pc.ontrack = event => {
      if (event.track.kind === 'video') {
        this.remoteVideos.set(id, new MediaStream([event.track]));
        event.track.onended = () => { this.remoteVideos.delete(id); this.emitCurrent(); };
        this.emitCurrent();
        return;
      }
      let audio = this.audioElements.get(id);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.volume = 1;
        audio.dataset.voicePeer = id;
        document.body.append(audio);
        this.audioElements.set(id, audio);
        const media = audio as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
        if (media.setSinkId) void media.setSinkId(this.outputDeviceId).catch(error => this.emit('connected', error instanceof Error ? `Could not select speaker: ${error.message}` : 'Could not select speaker.'));
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

  private async preparePeerVideo(id: string) {
    const track = this.screenStream?.getVideoTracks()[0]; const sender = this.videoSenders.get(id);
    if (track && sender && sender.track !== track) await sender.replaceTrack(track);
  }

  private send(message: object) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private emit(state: VoiceState, message: string) { this.currentState = state; this.currentMessage = message; this.onUpdate({ state, message, peers: [...this.peerNames.values()], sharingScreen: !!this.screenStream, videoPeers: [...this.remoteVideos.keys()] }); }
  private emitCurrent() { this.emit(this.currentState, this.currentMessage); }
  private fail(message: string) { if (this.stopped) return; this.emit('error', message); this.leave(); this.emit('error', message); }
}
