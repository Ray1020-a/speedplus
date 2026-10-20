/** Lobby over WebSocket (signaling only) + full-mesh WebRTC data channels for gameplay. */
export class Room {
  constructor(ice) {
    this.ice = ice;
    this.ws = null;
    this.id = null;
    this.code = null;
    this.roster = null;
    this.peers = new Map(); // id -> {pc, rel, unrel, open}
    this.on = {}; // roster, start, error, peerOpen, peerClose, data, closed
  }

  emit(ev, ...a) { this.on[ev]?.(...a); }

  open() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('無法連線到伺服器'));
      ws.onclose = () => this.emit('closed');
      ws.onmessage = (e) => this.onWs(JSON.parse(e.data));
    });
  }

  send(msg) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify(msg)); }

  async create(info) { await this.open(); return this.await(() => this.send({ t: 'create', ...info })); }
  async join(info) { await this.open(); return this.await(() => this.send({ t: 'join', ...info })); }
  await(fire) {
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      fire();
    });
  }

  onWs(m) {
    switch (m.t) {
      case 'error':
        if (this._pending) { this._pending.reject(new Error(m.msg)); this._pending = null; this.ws.close(); } else this.emit('error', m.msg);
        break;
      case 'joined':
        this.id = m.id;
        this.code = m.code;
        m.peers.forEach((p) => this.connectPeer(p, true));
        this._pending?.resolve(m);
        this._pending = null;
        break;
      case 'roster':
        this.roster = m;
        this.emit('roster', m);
        break;
      case 'left':
        this.dropPeer(m.id);
        break;
      case 'start':
        this.emit('start', m);
        break;
      case 'sig':
        this.onSignal(m.from, m.data);
        break;
    }
  }

  /* ---------- WebRTC ---------- */
  makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const peer = { pc, id, open: false, rel: null, unrel: null, queued: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => e.candidate && this.send({ t: 'sig', to: id, data: { ice: e.candidate } });
    // pre-negotiated channels, identical ids on both sides
    peer.rel = pc.createDataChannel('r', { negotiated: true, id: 0 });
    peer.unrel = pc.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    const onopen = () => {
      if (!peer.open && peer.rel.readyState === 'open' && peer.unrel.readyState === 'open') {
        peer.open = true;
        this.emit('peerOpen', id);
      }
    };
    peer.rel.onopen = peer.unrel.onopen = onopen;
    const onmsg = (e) => { try { this.emit('data', id, JSON.parse(e.data)); } catch { /* ignore */ } };
    peer.rel.onmessage = peer.unrel.onmessage = onmsg;
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.dropPeer(id);
    };
    return peer;
  }

  async connectPeer(id, offerer) {
    const peer = this.makePeer(id);
    if (!offerer) return peer;
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    this.send({ t: 'sig', to: id, data: { sdp: peer.pc.localDescription } });
    return peer;
  }

  async onSignal(from, data) {
    let peer = this.peers.get(from);
    if (data.sdp) {
      if (!peer) peer = this.makePeer(from);
      await peer.pc.setRemoteDescription(data.sdp);
      peer.queued.splice(0).forEach((c) => peer.pc.addIceCandidate(c).catch(() => {}));
      if (data.sdp.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.send({ t: 'sig', to: from, data: { sdp: peer.pc.localDescription } });
      }
    } else if (data.ice) {
      if (!peer) peer = this.makePeer(from);
      if (peer.pc.remoteDescription) peer.pc.addIceCandidate(data.ice).catch(() => {});
      else peer.queued.push(data.ice);
    }
  }

  dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* ignore */ }
    this.emit('peerClose', id);
  }

  /** reliable=false uses the unordered/lossy channel (positions) */
  broadcast(msg, reliable = true) {
    const s = JSON.stringify(msg);
    for (const p of this.peers.values()) {
      const ch = reliable ? p.rel : p.unrel;
      if (p.open && ch.readyState === 'open') ch.send(s);
    }
  }

  get isHost() { return this.roster?.host === this.id; }
  update(info) { this.send({ t: 'update', ...info }); }
  setup(info) { this.send({ t: 'setup', ...info }); }
  startRace() { this.send({ t: 'start' }); }
  endRace() { this.send({ t: 'end' }); }

  leave() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.ws?.close();
    this.ws = null;
    this.roster = null;
  }
}
