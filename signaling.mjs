// WebRTC signaling + lobby. Gameplay traffic never touches the server (peer-to-peer data channels).
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';

const MAX_PLAYERS = 16;
const MIN_PLAYERS = 2;
const rooms = new Map();

const code = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(c)) return c;
  }
};

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
const roster = (room) => ({
  t: 'roster', code: room.code, host: room.host, state: room.state, setup: room.setup,
  players: [...room.members.values()].map((m) => m.info),
});
const broadcast = (room, msg) => room.members.forEach((m) => send(m.ws, msg));

export function attachSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws) => {
    let room = null;
    let me = null;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const leave = () => {
      if (!room) return;
      room.members.delete(me);
      if (!room.members.size) rooms.delete(room.code);
      else {
        if (room.host === me) room.host = room.members.keys().next().value;
        broadcast(room, { t: 'left', id: me });
        broadcast(room, roster(room));
      }
      room = null;
    };

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }

      if (m.t === 'create' || m.t === 'join') {
        if (room) return;
        const name = cleanName(m.name);
        if (!name) return send(ws, { t: 'error', msg: '請輸入名字' });
        const info = { id: crypto.randomUUID().slice(0, 8), name, car: m.car, character: m.character, mt: !!m.mt };
        if (m.t === 'create') {
          room = { code: code(), host: info.id, state: 'lobby', members: new Map(), setup: { map: m.map, laps: Math.max(1, Math.min(20, m.laps | 0 || 3)) } };
          rooms.set(room.code, room);
        } else {
          const r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) return send(ws, { t: 'error', msg: '找不到房間' });
          if (r.state !== 'lobby') return send(ws, { t: 'error', msg: '比賽已開始' });
          if (r.members.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: '房間已滿 (最多 16 人)' });
          if ([...r.members.values()].some((x) => x.info.name === name)) return send(ws, { t: 'error', msg: '名字已被使用' });
          room = r;
        }
        me = info.id;
        const existing = [...room.members.keys()];
        room.members.set(me, { ws, info });
        send(ws, { t: 'joined', id: me, code: room.code, peers: existing });
        broadcast(room, roster(room));
        return;
      }
      if (!room) return;

      if (m.t === 'sig') { // relay SDP / ICE to one peer
        const to = room.members.get(m.to);
        if (to) send(to.ws, { t: 'sig', from: me, data: m.data });
      } else if (m.t === 'update') { // own car/character/transmission change
        const info = room.members.get(me).info;
        for (const k of ['car', 'character']) if (typeof m[k] === 'string') info[k] = m[k];
        if ('mt' in m) info.mt = !!m.mt;
        broadcast(room, roster(room));
      } else if (m.t === 'setup' && room.host === me && room.state === 'lobby') {
        if (m.laps) room.setup.laps = Math.max(1, Math.min(20, m.laps | 0));
        broadcast(room, roster(room));
      } else if (m.t === 'start' && room.host === me && room.state === 'lobby') {
        if (room.members.size < MIN_PLAYERS) return send(ws, { t: 'error', msg: '至少需要 2 人才能開局' });
        room.state = 'racing';
        broadcast(room, { t: 'start', order: [...room.members.keys()], seed: crypto.randomInt(1e9) });
        broadcast(room, roster(room));
      } else if (m.t === 'end' && room.host === me) {
        room.state = 'lobby';
        broadcast(room, roster(room));
      }
    });

    ws.on('close', leave);
    ws.on('error', leave);
  });

  const timer = setInterval(() => wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }), 30000);
  wss.on('close', () => clearInterval(timer));
}
