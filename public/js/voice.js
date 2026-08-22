/**
 * Malha WebRTC ponto a ponto para voz, vídeo e compartilhamento de tela.
 *
 * Cada participante abre uma RTCPeerConnection com todos os outros do canal.
 * A negociação usa o padrão "perfect negotiation" para evitar colisões de
 * oferta, e cada peer anuncia quais MediaStreams são câmera e quais são tela.
 */

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

export class VoiceClient {
  constructor(socket) {
    this.socket = socket;
    this.channelId = null;
    this.selfId = null;

    this.micStream = null;      // áudio do microfone
    this.camStream = null;      // vídeo da câmera
    this.screenStream = null;   // vídeo da tela

    /** socketId -> { pc, user, state, polite, makingOffer, ignoreOffer, streams:Map, kinds:Map } */
    this.peers = new Map();

    this.state = { muted: false, deafened: false, video: false, screen: false, speaking: false };
    this.listeners = new Set();
    this.analysers = new Map();

    this._bindSocket();
  }

  /* ------------------------------------------------------------- eventos */

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  _bindSocket() {
    this.socket.on('webrtc:signal', async ({ from, data }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      await this._handleSignal(peer, data);
    });

    this.socket.on('voice:peer-joined', ({ channelId, socketId, user, state }) => {
      if (channelId !== this.channelId || socketId === this.selfId) return;
      // Quem já estava no canal aguarda a oferta de quem chegou.
      this._createPeer(socketId, user, state, false);
      this._emit();
    });

    this.socket.on('voice:peer-left', ({ channelId, socketId }) => {
      if (channelId !== this.channelId) return;
      this._destroyPeer(socketId);
      this._emit();
    });

    this.socket.on('voice:peer-state', ({ channelId, socketId, state }) => {
      if (channelId !== this.channelId) return;
      const peer = this.peers.get(socketId);
      if (peer) peer.state = { ...peer.state, ...state };
      this._emit();
    });
  }

  /* ---------------------------------------------------------- entrar/sair */

  get connected() { return !!this.channelId; }

  async join(channelId, { video = false } = {}) {
    if (this.channelId === channelId) return;
    if (this.channelId) this.leave();

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    this._watchSpeaking('self', this.micStream);

    const response = await new Promise((resolve) =>
      this.socket.emit('voice:join', { channelId, state: this.state }, resolve));

    if (!response?.ok) {
      this._stopStream(this.micStream);
      this.micStream = null;
      throw new Error(response?.error || 'Não foi possível entrar no canal de voz');
    }

    this.channelId = channelId;
    this.selfId = response.self.socketId;

    // Quem entra é quem inicia as ofertas para os que já estavam.
    for (const peer of response.peers) {
      this._createPeer(peer.socketId, peer.user, peer.state, true);
    }

    if (video) await this.setCamera(true);
    this._emit();
  }

  leave() {
    if (!this.channelId) return;
    this.socket.emit('voice:leave');
    for (const socketId of [...this.peers.keys()]) this._destroyPeer(socketId);

    this._stopStream(this.micStream);
    this._stopStream(this.camStream);
    this._stopStream(this.screenStream);
    this.micStream = this.camStream = this.screenStream = null;

    for (const ctx of this.analysers.values()) ctx.close?.();
    this.analysers.clear();

    this.channelId = null;
    this.selfId = null;
    this.state = { muted: false, deafened: false, video: false, screen: false, speaking: false };
    this._emit();
  }

  /* -------------------------------------------------------------- mídia  */

  toggleMute(force) {
    this.state.muted = force ?? !this.state.muted;
    for (const track of this.micStream?.getAudioTracks() || []) track.enabled = !this.state.muted;
    this._pushState();
    return this.state.muted;
  }

  toggleDeafen(force) {
    this.state.deafened = force ?? !this.state.deafened;
    if (this.state.deafened) this.toggleMute(true);
    this._pushState();
    return this.state.deafened;
  }

  async setCamera(on) {
    if (on && !this.camStream) {
      this.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
      });
      const track = this.camStream.getVideoTracks()[0];
      track.addEventListener('ended', () => this.setCamera(false));
      for (const peer of this.peers.values()) peer.pc.addTrack(track, this.camStream);
      this.state.video = true;
    } else if (!on && this.camStream) {
      this._removeStreamFromPeers(this.camStream);
      this._stopStream(this.camStream);
      this.camStream = null;
      this.state.video = false;
    }
    this._pushState();
    this._announceStreams();
    this._emit();
    return this.state.video;
  }

  async setScreen(on) {
    if (on && !this.screenStream) {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true
      });
      for (const track of this.screenStream.getTracks()) {
        track.addEventListener('ended', () => this.setScreen(false));
        for (const peer of this.peers.values()) peer.pc.addTrack(track, this.screenStream);
      }
      this.state.screen = true;
    } else if (!on && this.screenStream) {
      this._removeStreamFromPeers(this.screenStream);
      this._stopStream(this.screenStream);
      this.screenStream = null;
      this.state.screen = false;
    }
    this._pushState();
    this._announceStreams();
    this._emit();
    return this.state.screen;
  }

  _removeStreamFromPeers(stream) {
    const ids = new Set(stream.getTracks().map((t) => t.id));
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && ids.has(sender.track.id)) {
          try { peer.pc.removeTrack(sender); } catch { /* já removido */ }
        }
      }
    }
  }

  _stopStream(stream) {
    for (const track of stream?.getTracks() || []) track.stop();
  }

  _pushState() {
    if (this.channelId) this.socket.emit('voice:state', { state: this.state });
    this._emit();
  }

  /* ------------------------------------------------------------- peers   */

  _createPeer(socketId, user, state, initiator) {
    if (this.peers.has(socketId)) return this.peers.get(socketId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = {
      socketId, user, pc,
      state: state || {},
      polite: !initiator,
      makingOffer: false,
      ignoreOffer: false,
      streams: new Map(),   // streamId -> MediaStream
      kinds: new Map(),     // streamId -> 'cam' | 'screen'
      speaking: false
    };
    this.peers.set(socketId, peer);

    const send = (data) => this.socket.emit('webrtc:signal', { to: socketId, data });

    pc.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate }); };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send({ description: pc.localDescription });
      } catch (err) {
        console.warn('negotiationneeded', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0];
      if (!stream) return;
      peer.streams.set(stream.id, stream);
      stream.addEventListener('removetrack', () => {
        if (stream.getTracks().length === 0) {
          peer.streams.delete(stream.id);
          this._emit();
        }
      });
      if (track.kind === 'audio') this._watchSpeaking(socketId, stream, peer);
      track.addEventListener('ended', () => this._emit());
      this._emit();
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this._emit();
    };

    // Publica a mídia local para o novo peer.
    for (const track of this.micStream?.getTracks() || []) pc.addTrack(track, this.micStream);
    for (const track of this.camStream?.getTracks() || []) pc.addTrack(track, this.camStream);
    for (const track of this.screenStream?.getTracks() || []) pc.addTrack(track, this.screenStream);

    setTimeout(() => this._announceStreams(socketId), 300);
    return peer;
  }

  _destroyPeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    try { peer.pc.close(); } catch { /* já fechado */ }
    this.analysers.get(socketId)?.close?.();
    this.analysers.delete(socketId);
    this.peers.delete(socketId);
  }

  /** Informa aos outros quais streams são câmera e quais são tela. */
  _announceStreams(onlyTo = null) {
    const payload = {
      streams: {
        ...(this.camStream ? { [this.camStream.id]: 'cam' } : {}),
        ...(this.screenStream ? { [this.screenStream.id]: 'screen' } : {}),
        ...(this.micStream ? { [this.micStream.id]: 'mic' } : {})
      }
    };
    const targets = onlyTo ? [onlyTo] : [...this.peers.keys()];
    for (const socketId of targets) this.socket.emit('webrtc:signal', { to: socketId, data: payload });
  }

  async _handleSignal(peer, data) {
    const { pc } = peer;
    const send = (payload) => this.socket.emit('webrtc:signal', { to: peer.socketId, data: payload });

    if (data.streams) {
      for (const [streamId, kind] of Object.entries(data.streams)) peer.kinds.set(streamId, kind);
      this._emit();
      return;
    }

    try {
      if (data.description) {
        const offerCollision = data.description.type === 'offer'
          && (peer.makingOffer || pc.signalingState !== 'stable');

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          send({ description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) console.warn('ICE', err);
        }
      }
    } catch (err) {
      console.warn('sinalização', err);
    }
  }

  /* --------------------------------------------------- detecção de fala  */

  _watchSpeaking(key, stream, peer = null) {
    if (this.analysers.has(key)) return;
    if (!stream.getAudioTracks().length) return;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;

    const loop = () => {
      if (ctx.state === 'closed') return;
      analyser.getByteFrequencyData(data);
      const level = data.reduce((a, b) => a + b, 0) / data.length;
      const speaking = level > 12;

      if (speaking !== wasSpeaking) {
        wasSpeaking = speaking;
        if (peer) peer.speaking = speaking;
        else {
          this.state.speaking = speaking && !this.state.muted;
          this.socket.emit('voice:state', { state: { speaking: this.state.speaking } });
        }
        this._emit();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.analysers.set(key, ctx);
  }

  /* ----------------------------------------------------------- render    */

  /** Lista de "ladrilhos" para a grade de vídeo. */
  tiles(me) {
    const out = [];

    out.push({
      key: 'self',
      user: me,
      self: true,
      state: this.state,
      speaking: this.state.speaking,
      video: this.camStream || null,
      screen: this.screenStream || null
    });

    for (const peer of this.peers.values()) {
      let video = null;
      let screen = null;
      for (const [streamId, stream] of peer.streams) {
        const kind = peer.kinds.get(streamId);
        if (kind === 'screen') screen = stream;
        else if (kind === 'cam') video = stream;
        else if (!kind && stream.getVideoTracks().length) video ??= stream;
      }
      out.push({
        key: peer.socketId,
        user: peer.user,
        self: false,
        state: peer.state,
        speaking: peer.speaking,
        video,
        screen,
        audioStreams: [...peer.streams.values()].filter((s) => s.getAudioTracks().length)
      });
    }
    return out;
  }
}
