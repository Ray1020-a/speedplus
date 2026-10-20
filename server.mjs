import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assets, records } from './db.mjs';
import { attachSignaling } from './signaling.mjs';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 3000);
const MODELS = process.env.MODELS_DIR || path.join(ROOT, 'models');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const KINDS = { car: 'cars', map: 'maps', character: 'characters' };

for (const d of Object.values(KINDS)) fs.mkdirSync(path.join(MODELS, d), { recursive: true });
if (ADMIN_PASSWORD === 'admin') console.warn('[warn] ADMIN_PASSWORD 使用預設值 "admin"，正式環境請設定環境變數');

/* ---------- default configs ---------- */
const defaultCar = (name) => ({
  name,
  yaw: 0,              // model rotation so that the nose points to -Z
  scale: 1,            // 1 = model units are metres
  seat: { pos: [0, 0.35, 0.2], rot: [0, 0, 0], scale: 1 },
  pose: { torso: 8, head: 0, arm: 55, elbow: 35, thigh: 80, knee: 70 },
  cockpitEye: [0, 0.75, 0.1],
  hood: [0, 0.9, -0.8],
  bodyBox: [1.9, 0.9, 5.4], // collision box (w,h,l), centered on car origin
  power: 1.0,
  topSpeed: 340, // km/h
  gearCount: 8,
  redline: 15000,
  sound: { type: 'f1' },
});
const defaultMap = (name) => ({
  name,
  carScale: 0.25,      // scale cars down so they fit the map
  maxSpeed: 160,       // km/h cap (virtual) so small maps stay playable
  hide: 'ceil',        // meshes whose names match this regex are hidden (ceilings)
  noCollide: 'glass|lamp',
  laps: 3,
  circuit: true,
  start: null,         // {x,z,yaw}
  finish: null,        // {x,z,yaw,width}
  track: { width: 3, points: [] },
  spawnY: null,
  sky: 'day',
});
const defaultCharacter = (name, c) => ({ name, type: 'procedural', ...c });

/* ---------- tuned configs shipped with the repo (seed/<model name>.json) ---------- */
function seedFor(file) {
  const p = path.join(ROOT, 'seed', file.replace(/\.[^.]+$/, '') + '.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

/* ---------- scan models folders -> DB ---------- */
const slug = (f) => f.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').toLowerCase();
function scanModels() {
  for (const [kind, dir] of Object.entries(KINDS)) {
    for (const f of fs.readdirSync(path.join(MODELS, dir))) {
      if (!/\.(glb|gltf)$/i.test(f)) continue;
      if (assets.byFile(kind, f)) continue;
      const name = f.replace(/\.[^.]+$/, '');
      const base = kind === 'car' ? defaultCar(name) : kind === 'map' ? defaultMap(name) : { name, type: 'glb', scale: 1 };
      const cfg = { ...base, ...seedFor(f) };
      assets.upsert(kind, slug(f), name, f, cfg);
      console.log(`[scan] ${kind}: ${f}`);
    }
  }
  if (!assets.list('character').length) {
    const people = [
      ['rin', '凜', { suit: '#e8372c', helmet: '#f5f5f5', skin: '#f1c9a5' }],
      ['kai', '凱', { suit: '#1d6fe0', helmet: '#101820', skin: '#c68863' }],
      ['mei', '美', { suit: '#f2b705', helmet: '#d6336c', skin: '#f6d5b8' }],
      ['ryo', '涼', { suit: '#1f9d55', helmet: '#222222', skin: '#8d5a3c' }],
    ];
    people.forEach(([id, n, c], i) => assets.upsert('character', id, n, null, defaultCharacter(n, c), i));
  }
}
scanModels();

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const sessions = new Set();
const requireAdmin = (req, res, next) =>
  sessions.has(req.get('x-admin-token')) ? next() : res.status(401).json({ error: 'unauthorized' });

const publicAsset = (a) => ({
  id: a.id, name: a.name, config: a.config,
  url: a.file ? `/models/${KINDS[a.kind]}/${encodeURIComponent(a.file)}?v=${a.version}` : null,
  size: a.size,
});
const withFile = (kind) => (a) => {
  const s = a.file && fs.statSync(path.join(MODELS, KINDS[kind], a.file), { throwIfNoEntry: false });
  return publicAsset({ ...a, kind, version: s ? Math.floor(s.mtimeMs) : 0, size: s ? s.size : 0 });
};

app.get('/api/assets/:kind', (req, res) => {
  const kind = req.params.kind;
  if (!KINDS[kind]) return res.sendStatus(404);
  res.json(assets.list(kind).filter((a) => !a.file || fs.existsSync(path.join(MODELS, KINDS[kind], a.file))).map(withFile(kind)));
});
app.get('/api/config', (_req, res) =>
  res.json({ ice: process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }));

app.get('/api/records', (req, res) => {
  const { map, mode } = req.query;
  if (!map || !['lap', 'time'].includes(mode)) return res.status(400).json({ error: 'bad query' });
  res.json(records.top(String(map), mode, 20));
});
app.post('/api/records', (req, res) => {
  const { map_id, car_id, mode, score, best_lap_ms, player, check } = req.body || {};
  if (!assets.get('map', map_id) || !['lap', 'time'].includes(mode) || !Number.isFinite(score) || score <= 0)
    return res.status(400).json({ error: 'bad record' });
  const isRecord = records.isRecord(map_id, mode, score);
  if (check) return res.json({ isRecord }); // only ask whether it beats the record
  const name = String(player || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!isRecord) return res.status(409).json({ error: 'not a record' });
  records.add({ map_id, car_id: String(car_id || ''), mode, score, best_lap_ms, player: name });
  res.json({ ok: true });
});

/* ---------- admin ---------- */
app.post('/api/admin/login', (req, res) => {
  const a = Buffer.from(String(req.body?.password ?? ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '密碼錯誤' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.json({ token });
});
app.put('/api/admin/:kind/:id', requireAdmin, (req, res) => {
  const { kind, id } = req.params;
  if (!KINDS[kind] || !assets.get(kind, id)) return res.sendStatus(404);
  const config = req.body?.config;
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config required' });
  assets.setConfig(kind, id, config, config.name);
  res.json({ ok: true });
});
app.post('/api/admin/rescan', requireAdmin, (_req, res) => { scanModels(); res.json({ ok: true }); });
app.put('/api/admin/upload/:kind/:file', requireAdmin, (req, res) => {
  const { kind, file } = req.params;
  if (!KINDS[kind] || !/^[\w.-]+\.glb$/i.test(file)) return res.status(400).json({ error: 'bad name' });
  const dest = path.join(MODELS, KINDS[kind], file);
  const out = fs.createWriteStream(dest);
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 300 * 1024 * 1024) { req.destroy(); out.destroy(); fs.rmSync(dest, { force: true }); } });
  req.pipe(out);
  out.on('finish', () => { scanModels(); res.json({ ok: true }); });
  out.on('error', () => res.status(500).json({ error: 'write failed' }));
});
app.delete('/api/admin/records/:id', requireAdmin, (req, res) => {
  import('./db.mjs').then(({ db }) => { db.prepare('DELETE FROM records WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });
});

/* ---------- static ---------- */
const lib = (p) => path.join(ROOT, 'node_modules', p);
app.use('/vendor/three', express.static(lib('three'), { maxAge: '7d' }));
app.use('/vendor/three-mesh-bvh', express.static(lib('three-mesh-bvh'), { maxAge: '7d' }));
app.use('/models', express.static(MODELS, { maxAge: '1h', fallthrough: false }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
attachSignaling(server);
server.listen(PORT, () => console.log(`speedplus listening on http://localhost:${PORT}`));
