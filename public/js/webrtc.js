/**
 * SPINTALK — WebRTC Client
 * Подключается к серверу через Socket.io,
 * выполняет P2P видеосвязь через WebRTC.
 * 
 * Подключить в index.html после socket.io.min.js:
 * <script src="/socket.io/socket.io.js"></script>
 * <script src="js/webrtc.js"></script>
 */

'use strict';

class SpinTalkWebRTC {
  constructor() {
    this.socket = null;
    this.pc     = null;
    this.role   = null; // 'caller' | 'callee'
    this.mode   = null; // 'video' | 'text'

    this.ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // В продакшне добавьте TURN сервер:
      // { urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' }
    ];
  }

  // ── CONNECT TO SERVER ───────────────────────
  connect(serverURL = '') {
    this.socket = io(serverURL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    this.socket.on('connect', ()     => this._onConnect());
    this.socket.on('disconnect', ()  => this._onDisconnect());
    this.socket.on('banned',     d   => this._onBanned(d));
    this.socket.on('matched',    d   => this._onMatched(d));
    this.socket.on('partner:left', d => this._onPartnerLeft(d));
    this.socket.on('signal',     d   => this._onSignal(d));
    this.socket.on('message',    d   => this._onMessage(d));
    this.socket.on('status',     d   => this._onStatus(d));
    this.socket.on('terminated', d   => this._onTerminated(d));

    return this;
  }

  // ── FIND PARTNER ────────────────────────────
  find({ mode = 'video', interests = [] } = {}) {
    this.mode = mode;
    this._closePeer();
    this.socket?.emit('find', { mode, interests });
  }

  // ── SKIP ────────────────────────────────────
  skip() {
    this._closePeer();
    this.socket?.emit('skip');
  }

  // ── SEND MESSAGE ────────────────────────────
  sendMessage(text) {
    if (!text?.trim()) return;
    this.socket?.emit('message', { text: text.trim() });
  }

  // ── REPORT ──────────────────────────────────
  report({ type, description }) {
    this.socket?.emit('report', { type, description });
  }

  // ── DESTROY ─────────────────────────────────
  destroy() {
    this._closePeer();
    this.socket?.disconnect();
    this.socket = null;
  }

  // ── PRIVATE: SOCKET EVENTS ──────────────────
  _onConnect() {
    console.log('[SpinTalk] Connected to server');
    this.onConnect?.();
  }

  _onDisconnect() {
    console.log('[SpinTalk] Disconnected');
    this._closePeer();
    this.onDisconnect?.();
  }

  _onBanned({ reason }) {
    console.warn('[SpinTalk] Banned:', reason);
    this.onBanned?.({ reason });
  }

  async _onMatched({ role, mode, chatId }) {
    console.log(`[SpinTalk] Matched! role=${role} mode=${mode} chatId=${chatId}`);
    this.role   = role;
    this.mode   = mode;

    this.onMatched?.({ role, mode, chatId });

    if (mode === 'video') {
      await this._createPeerConnection();
      if (role === 'caller') await this._createOffer();
    }
  }

  _onPartnerLeft({ reason }) {
    console.log('[SpinTalk] Partner left:', reason);
    this._closePeer();
    this.onPartnerLeft?.({ reason });
  }

  async _onSignal(data) {
    if (!this.pc) await this._createPeerConnection();

    try {
      if (data.type === 'offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.socket.emit('signal', this.pc.localDescription);
      } else if (data.type === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        await this.pc.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (err) {
      console.error('[SpinTalk] Signal error:', err);
    }
  }

  _onMessage({ text, ts }) {
    this.onMessage?.({ text, ts });
  }

  _onStatus({ state, position }) {
    this.onStatus?.({ state, position });
  }

  _onTerminated({ reason }) {
    this._closePeer();
    this.onTerminated?.({ reason });
  }

  // ── PRIVATE: WEBRTC ─────────────────────────
  async _createPeerConnection() {
    if (this.pc) this._closePeer();

    this.pc = new RTCPeerConnection({ iceServers: this.ICE_SERVERS });

    // Add local tracks
    if (window.state?.localStream) {
      window.state.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, window.state.localStream);
      });
    }

    // Receive remote stream
    this.pc.ontrack = (e) => {
      const remoteVideo = document.getElementById('remote-video');
      if (remoteVideo && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        this.onRemoteStream?.(e.streams[0]);
      }
    };

    // ICE candidates
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket?.emit('signal', e.candidate);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[SpinTalk] ICE state:', this.pc?.iceConnectionState);
      if (this.pc?.iceConnectionState === 'failed') {
        this.pc.restartIce();
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'connected')     this.onPeerConnected?.();
      if (s === 'disconnected')  this._closePeer();
      if (s === 'failed')        this._closePeer();
    };
  }

  async _createOffer() {
    try {
      const offer = await this.pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);
      this.socket?.emit('signal', this.pc.localDescription);
    } catch (err) {
      console.error('[SpinTalk] Offer error:', err);
    }
  }

  _closePeer() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) remoteVideo.srcObject = null;
  }
}

// Export for use in app.js
window.SpinTalkWebRTC = SpinTalkWebRTC;
