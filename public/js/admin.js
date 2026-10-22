import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { api, fmtTime } from './api.js';
import { downloadModel, parseGLB } from './loader.js';
import { buildCar, seatDriver } from './carmodel.js';
import { makeCharacter } from './characters.js';
import { Track } from './track.js';
import { PROFILES, engineProfile } from './audio.js';

const $ = (s) => document.querySelector(s);
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
let token = sessionStorage.getItem('sp-admin') || '';
let kind = 'car';
let list = [];
let cur = null; // {asset, cfg}

/* ---------- ui helpers ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
function el(tag, attrs = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), attrs);
  kids.forEach((k) => e.append(k));
  return e;
}
function row(label, ...ctl) { return el('div', { className: 'row' }, el('label', { textContent: label }), ...ctl); }
function num(label, get, set, { min, max, step = 0.01 } = {}, slider = false) {
  const n = el('input', { type: 'number', step, value: +(+get()).toFixed(4) });
  if (min != null) n.min = min;
  if (max != null) n.max = max;
  const ctl = [n];
  let r;
  if (slider) { r = el('input', { type: 'range', min, max, step, value: get() }); ctl.unshift(r); }
  const apply = (v) => { if (Number.isFinite(v)) { set(v); n.value = +v.toFixed(4); if (r) r.value = v; } };
  n.oninput = () => apply(parseFloat(n.value));
  if (r) r.oninput = () => apply(parseFloat(r.value));
  return row(label, ...ctl);
}
function text(label, get, set) {
  const i = el('input', { type: 'text', value: get() ?? '' });
  i.oninput = () => set(i.value);
  return row(label, i);
}
function check(label, get, set) {
  const i = el('input', { type: 'checkbox', checked: !!get() });
  i.onchange = () => set(i.checked);
  return row(label, i);
}
function color(label, get, set) {
  const i = el('input', { type: 'color', value: get() });
  i.oninput = () => set(i.value);
  return row(label, i);
}
const h3 = (t) => el('h3', { textContent: t });
const hint = (t) => el('div', { className: 'hint', textContent: t });
const btn = (t, fn, cls = '') => el('button', { textContent: t, className: cls, onclick: fn });

async function adminFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'x-admin-token': token } });
  if (r.status === 401) { sessionStorage.removeItem('sp-admin'); location.reload(); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function save() {
  await adminFetch(`/api/admin/${kind}/${cur.asset.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: cur.cfg }),
  });
  cur.asset.config = structuredClone(cur.cfg);
  toast('已儲存');
}

/* ---------- login ---------- */
async function tryLogin(pw) {
  const d = await api.post('/api/admin/login', { password: pw });
  token = d.token;
  sessionStorage.setItem('sp-admin', token);
}
$('#lf').onsubmit = async (e) => {
  e.preventDefault();
  try { await tryLogin($('#pw').value); start(); } catch (err) { $('#lerr').textContent = err.message; }
};

/* ---------- 3D stage ---------- */
const canvas = $('#gl');
const ov = $('#ov');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
let scene = new THREE.Scene();
let persp = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
let ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
let camera = persp;
const orbit = new OrbitControls(persp, canvas);
orbit.enableDamping = true;
const tc = new TransformControls(persp, canvas);
tc.addEventListener('dragging-changed', (e) => (orbit.enabled = !e.value));
let mapMode = false;
let onFrame = null;

function resize() {
  const r = $('#stage').getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  ov.width = r.width * devicePixelRatio;
  ov.height = r.height * devicePixelRatio;
  persp.aspect = r.width / r.height;
  persp.updateProjectionMatrix();
  if (mapMode) mv.fit();
}
addEventListener('resize', resize);
renderer.setAnimationLoop(() => {
  orbit.update();
  onFrame?.();
  renderer.render(scene, camera);
  if (mapMode) mv.draw();
});

let hemiLight, sunLight;
function newScene(bg = 0x1b2230) {
  scene.traverse((o) => { o.geometry?.dispose?.(); });
  scene = new THREE.Scene();
  scene.background = new THREE.Color(bg);
  hemiLight = new THREE.HemisphereLight(0xffffff, 0x445066, 1.6);
  sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  sunLight.position.set(5, 10, 6);
  scene.add(hemiLight, sunLight);
  renderer.toneMappingExposure = 1;
  tc.detach();
  scene.add(tc.getHelper());
  onFrame = null;
}

function progressBar(label) {
  return (p, bytes, cached) => {
    $('#tip').textContent = cached ? `${label}：從本地快取載入` : `${label}：下載中 ${(p * 100).toFixed(0)}% (${(bytes / 1048576).toFixed(1)} MB)`;
  };
}

/* ---------- car editor ---------- */
const car = { src: null, group: null, driver: null, markers: {}, target: 'seat', box: null };

async function openCar(asset) {
  mapMode = false;
  ov.style.pointerEvents = 'none';
  ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  camera = persp;
  newScene();
  scene.add(new THREE.GridHelper(10, 20, 0x445066, 0x2a3242));
  const gltf = await parseGLB(await downloadModel(asset.url, progressBar(asset.name)));
  car.src = gltf.scene;
  cur = { asset, cfg: structuredClone(asset.config) };
  rebuildCar();
  persp.position.set(4.5, 2.6, 5.5);
  orbit.target.set(0, 0.5, 0);
  $('#tip').textContent = '左鍵旋轉・右鍵平移・滾輪縮放。選擇下方目標後拖拉 gizmo 調整位置。車頭應朝向 -Z (藍色軸反方向)。';
  carPanel();
}

function rebuildCar() {
  const cfg = cur.cfg;
  if (car.group) scene.remove(car.group);
  car.group = buildCar(car.src, cfg);
  scene.add(car.group);
  const asset = (cfg.driverChar && charAssets.find((c) => c.id === cfg.driverChar)) || charAssets[0];
  car.driver = makeCharacter(asset?.config);
  seatDriver(car.group, car.driver, cfg);
  car.group.add(car.driver.group);

  // collision box
  if (car.box) scene.remove(car.box);
  const [w, h, l] = cfg.bodyBox;
  car.box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, l)), new THREE.LineBasicMaterial({ color: 0xff3355 }));
  car.box.position.y = h / 2;
  scene.add(car.box);

  // draggable markers
  const mk = (c) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.06), new THREE.MeshBasicMaterial({ color: c, depthTest: false }));
    m.renderOrder = 10;
    scene.add(m);
    return m;
  };
  car.markers.seat ??= mk(0xff8a2b);
  car.markers.eye ??= mk(0x28d7ff);
  car.markers.hood ??= mk(0x40e060);
  for (const m of Object.values(car.markers)) scene.add(m);
  syncMarkers();
  attachTarget();
}

function syncMarkers() {
  const c = cur.cfg;
  car.markers.seat.position.fromArray(c.seat.pos);
  car.markers.seat.rotation.set(rad(c.seat.rot[0]), rad(c.seat.rot[1]), rad(c.seat.rot[2]));
  car.markers.eye.position.fromArray(c.cockpitEye);
  car.markers.hood.position.fromArray(c.hood);
}

function attachTarget() {
  const m = car.markers[car.target];
  tc.attach(m);
  tc.setMode(car.mode || 'translate');
  tc.size = 0.8;
}

tc.addEventListener('objectChange', () => {
  if (kind !== 'car' || !cur) return;
  const c = cur.cfg;
  const m = car.markers[car.target];
  const r = (v) => +v.toFixed(3);
  if (car.target === 'seat') {
    c.seat.pos = m.position.toArray().map(r);
    c.seat.rot = [r(deg(m.rotation.x)), r(deg(m.rotation.y)), r(deg(m.rotation.z))];
    seatDriver(car.group, car.driver, c);
  } else if (car.target === 'eye') c.cockpitEye = m.position.toArray().map(r);
  else c.hood = m.position.toArray().map(r);
});

let charAssets = [];

function carPanel() {
  const p = $('#panel');
  const c = cur.cfg;
  p.replaceChildren(
    text('名稱', () => c.name, (v) => (c.name = v)),
    h3('模型方向 / 比例'),
    row('車頭轉向', ...[0, 90, 180, 270].map((y) => btn(`${y}°`, () => { c.yaw = y; rebuildCar(); carPanel(); }, c.yaw === y ? 'on' : ''))),
    hint('車頭必須朝 -Z。模型實際尺寸 (m)：' + car.group.userData.size.toArray().map((v) => v.toFixed(2)).join(' × ')),
    num('模型縮放', () => c.scale, (v) => { c.scale = v; rebuildCar(); }, { min: 0.01, max: 100, step: 0.01 }),
    h3('拖拉目標'),
    row('', ...[['seat', '座位'], ['eye', '駕駛視角'], ['hood', '引擎蓋視角']].map(([k, t]) => btn(t, () => { car.target = k; attachTarget(); carPanel(); }, car.target === k ? 'on' : ''))),
    row('gizmo', btn('移動', () => { car.mode = 'translate'; tc.setMode('translate'); }), btn('旋轉 (座位)', () => { if (car.target === 'seat') { car.mode = 'rotate'; tc.setMode('rotate'); } })),
    num('人物縮放', () => c.seat.scale, (v) => { c.seat.scale = v; seatDriver(car.group, car.driver, c); }, { min: 0.3, max: 3, step: 0.01 }, true),
    row('試穿人物', (() => {
      const s = el('select');
      charAssets.forEach((a) => s.append(el('option', { value: a.id, textContent: a.name, selected: a.id === c.driverChar })));
      s.onchange = () => { c.driverChar = s.value; rebuildCar(); };
      return s;
    })()),
    h3('坐姿 (度)'),
    ...[['torso', '上身前傾', -20, 60], ['head', '頭部俯仰', -40, 40], ['arm', '手臂抬起', -20, 120], ['elbow', '手肘彎曲', 0, 140], ['thigh', '大腿抬起', 0, 120], ['knee', '膝蓋彎曲', 0, 140]]
      .map(([k, t, mn, mx]) => num(t, () => c.pose[k], (v) => { c.pose[k] = v; car.driver.applyPose(c.pose); }, { min: mn, max: mx, step: 1 }, true)),
    h3('碰撞箱 (寬 高 長, m)'),
    ...['寬', '高', '長'].map((t, i) => num(t, () => c.bodyBox[i], (v) => { c.bodyBox[i] = v; rebuildCar(); }, { min: 0.1, max: 20, step: 0.01 })),
    btn('依模型尺寸自動量測', () => { c.bodyBox = car.group.userData.size.toArray().map((v) => +v.toFixed(2)); rebuildCar(); carPanel(); }),
    h3('性能'),
    num('馬力倍率', () => c.power, (v) => (c.power = v), { min: 0.2, max: 4, step: 0.05 }),
    num('極速 km/h', () => c.topSpeed, (v) => (c.topSpeed = v), { min: 50, max: 500, step: 5 }),
    num('紅線 RPM', () => c.redline, (v) => (c.redline = v), { min: 1500, max: 20000, step: 100 }),
    num('甩尾傾向 (F1 0.4 / 跑車 1)', () => c.drift ?? (c.redline >= 11000 ? 0.4 : 1), (v) => (c.drift = v), { min: 0, max: 2, step: 0.05 }),
    row('引擎聲', (() => {
      const s = el('select');
      const auto = `自動 (依紅線：${PROFILES[engineProfile({ redline: c.redline })].label})`;
      [['auto', auto], ...Object.entries(PROFILES).map(([k, p]) => [k, p.label])].forEach(([v, t]) => s.append(el('option', { value: v, textContent: t })));
      s.value = engineProfile(c) === c.sound?.type ? c.sound.type : 'auto'; // the old 'f1' default on a low redline shows as auto
      s.onchange = () => { c.sound = { ...c.sound, type: s.value }; };
      return s;
    })()),
    el('div', { style: 'margin-top:14px' }, btn('儲存', save, 'pri')),
  );
}

/* ---------- character editor ---------- */
async function openCharacter(asset) {
  mapMode = false;
  ov.style.pointerEvents = 'none';
  camera = persp;
  newScene();
  cur = { asset, cfg: structuredClone(asset.config) };
  let ch;
  const show = () => {
    if (ch) scene.remove(ch.group);
    ch = makeCharacter(cur.cfg);
    ch.applyPose({ torso: 0, arm: 5, elbow: 5, thigh: 0, knee: 0 });
    ch.group.position.y = 0.95;
    scene.add(ch.group);
  };
  show();
  persp.position.set(1.6, 1.4, 2.2);
  orbit.target.set(0, 1.1, 0);
  $('#tip').textContent = '人物預覽';
  $('#panel').replaceChildren(
    text('名稱', () => cur.cfg.name, (v) => (cur.cfg.name = v)),
    color('車衣', () => cur.cfg.suit, (v) => { cur.cfg.suit = v; show(); }),
    color('頭盔', () => cur.cfg.helmet, (v) => { cur.cfg.helmet = v; show(); }),
    color('膚色', () => cur.cfg.skin, (v) => { cur.cfg.skin = v; show(); }),
    el('div', { style: 'margin-top:14px' }, btn('儲存', save, 'pri')),
  );
}

/* ---------- map editor ---------- */
const mv = {
  cam: { x: 0, z: 0, k: 20 }, tool: 'select', drag: null, pan: null, clip: null, root: null, bounds: null, hoverPt: null,
  fit() {
    const w = ov.width / devicePixelRatio, h = ov.height / devicePixelRatio;
    if (this.bounds) {
      const b = this.bounds;
      this.cam.k = Math.min(w / (b.max.x - b.min.x + 4), h / (b.max.z - b.min.z + 4));
      this.cam.x = (b.min.x + b.max.x) / 2;
      this.cam.z = (b.min.z + b.max.z) / 2;
    }
    this.syncCam();
  },
  syncCam() {
    const w = ov.width / devicePixelRatio, h = ov.height / devicePixelRatio;
    const { x, z, k } = this.cam;
    ortho.left = -w / 2 / k; ortho.right = w / 2 / k; ortho.top = h / 2 / k; ortho.bottom = -h / 2 / k;
    ortho.position.set(x, 100, z);
    ortho.up.set(0, 0, -1);
    ortho.lookAt(x, 0, z);
    ortho.updateProjectionMatrix();
  },
  toScreen(x, z) {
    const w = ov.width / devicePixelRatio, h = ov.height / devicePixelRatio;
    return [(x - this.cam.x) * this.cam.k + w / 2, (z - this.cam.z) * this.cam.k + h / 2];
  },
  toWorld(sx, sz) {
    const w = ov.width / devicePixelRatio, h = ov.height / devicePixelRatio;
    return [(sx - w / 2) / this.cam.k + this.cam.x, (sz - h / 2) / this.cam.k + this.cam.z];
  },
  draw() {
    const ctx = ov.getContext('2d');
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const w = ov.width / devicePixelRatio, h = ov.height / devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    if (!cur) return;
    const c = cur.cfg;
    const k = this.cam.k;
    const pts = c.track.points;
    // road ribbon
    if (pts.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const path = () => { ctx.beginPath(); pts.forEach(([x, z], i) => { const [sx, sy] = this.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); if (c.circuit && pts.length > 2) ctx.closePath(); };
      ctx.strokeStyle = 'rgba(255,106,43,.22)'; ctx.lineWidth = c.track.width * k; path(); ctx.stroke();
      ctx.strokeStyle = '#ff6a2b'; ctx.lineWidth = 2; path(); ctx.stroke();
    }
    pts.forEach(([x, z], i) => {
      const [sx, sy] = this.toScreen(x, z);
      ctx.fillStyle = i === 0 ? '#3cf08a' : '#fff';
      ctx.beginPath(); ctx.arc(sx, sy, i === 0 ? 5 : 3, 0, 7); ctx.fill();
    });
    // direction arrows
    if (pts.length > 3) {
      const t = new Track(c);
      for (let s = 0; s < t.length; s += Math.max(3, 60 / k)) {
        const a = t.at(s); const [sx, sy] = this.toScreen(a.x, a.z);
        const ang = Math.atan2(a.dz, a.dx);
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang); ctx.fillStyle = '#fff8'; ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-4, -4); ctx.fill(); ctx.restore();
      }
    }
    // car footprint at start
    const gate = (g, col, label, checker) => {
      if (!g) return;
      const [sx, sy] = this.toScreen(g.x, g.z);
      const fx = -Math.sin(g.yaw), fz = -Math.cos(g.yaw);
      const half = (g.width || c.track.width * 1.3) / 2;
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(Math.atan2(fz, fx));
      ctx.lineWidth = 4; ctx.strokeStyle = col;
      if (checker) { ctx.setLineDash([6, 6]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; }
      ctx.beginPath(); ctx.moveTo(0, -half * k); ctx.lineTo(0, half * k); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(8, 9); ctx.lineTo(8, -9); ctx.fill();
      // to-scale car silhouette behind the line
      const cl = 5.4 * c.carScale * k, cw = 1.96 * c.carScale * k;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.strokeRect(-cl - 4, -cw / 2, cl, cw);
      ctx.restore();
      ctx.fillStyle = col; ctx.font = '12px system-ui'; ctx.fillText(label, sx + 10, sy - 12);
    };
    gate(c.start && { ...c.start, width: c.track.width * 1.3 }, '#3cf08a', c.circuit ? '起點／終點' : '起點');
    if (!c.circuit) gate(c.finish, '#ff3355', '終點', true);
    // preview of draw tool
    if (this.hoverPt && this.tool !== 'select') {
      const [sx, sy] = this.toScreen(...this.hoverPt);
      ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, sy, 8, 0, 7); ctx.stroke();
    }
  },
  hit(sx, sy) {
    const c = cur.cfg, R = 12;
    const near = (x, z) => { const [px, py] = this.toScreen(x, z); return Math.hypot(px - sx, py - sy) < R; };
    if (c.start && near(c.start.x, c.start.z)) return { type: 'start' };
    if (!c.circuit && c.finish && near(c.finish.x, c.finish.z)) return { type: 'finish' };
    for (let i = c.track.points.length - 1; i >= 0; i--) if (near(...c.track.points[i])) return { type: 'pt', i };
    return null;
  },
};

function snapGate(name, x, z) {
  const c = cur.cfg;
  let g = c[name] || { yaw: 0 };
  g = { ...g, x, z };
  const t = new Track(c);
  if (t.valid) {
    const p = t.project(x, z);
    const a = t.at(p.s);
    g.x = a.x; g.z = a.z;
    if (!g.manual) g.yaw = Math.atan2(-a.dx, -a.dz);
  }
  c[name] = g;
}

function mapPointer() {
  const spacing = () => 0.8; // world units between freehand points
  ov.onpointerdown = (e) => {
    ov.setPointerCapture(e.pointerId);
    const r = ov.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.button === 1 || e.button === 2 || e.shiftKey) { mv.pan = { sx, sy, cx: mv.cam.x, cz: mv.cam.z }; return; }
    const [wx, wz] = mv.toWorld(sx, sy);
    const c = cur.cfg;
    if (mv.rotating) { mv.rotating = false; $('#tip2') && ($('#tip2').textContent = ''); return; }
    if (mv.tool === 'select') {
      const h = mv.hit(sx, sy);
      if (h) mv.drag = h;
    } else if (mv.tool === 'draw') {
      c.track.points.push([+wx.toFixed(2), +wz.toFixed(2)]);
      mv.drag = { type: 'draw' };
    } else if (mv.tool === 'start') { snapGate('start', wx, wz); mv.drag = { type: 'start' }; }
    else if (mv.tool === 'finish') { c.finish = { x: wx, z: wz, yaw: 0 }; snapGate('finish', wx, wz); mv.drag = { type: 'finish' }; }
  };
  ov.onpointermove = (e) => {
    const r = ov.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wz] = mv.toWorld(sx, sy);
    mv.hoverPt = [wx, wz];
    $('#tip2') && ($('#tip2').textContent = `x ${wx.toFixed(2)}  z ${wz.toFixed(2)}`);
    if (mv.pan) {
      mv.cam.x = mv.pan.cx - (sx - mv.pan.sx) / mv.cam.k;
      mv.cam.z = mv.pan.cz - (sy - mv.pan.sy) / mv.cam.k;
      mv.syncCam();
      return;
    }
    if (mv.rotating) {
      const g = cur.cfg.start;
      if (g) { g.yaw = Math.atan2(-(wx - g.x), -(wz - g.z)); g.manual = true; }
      return;
    }
    const d = mv.drag;
    if (!d) return;
    const c = cur.cfg;
    if (d.type === 'pt') c.track.points[d.i] = [+wx.toFixed(2), +wz.toFixed(2)];
    else if (d.type === 'draw') {
      const l = c.track.points.at(-1);
      if (Math.hypot(wx - l[0], wz - l[1]) >= spacing()) c.track.points.push([+wx.toFixed(2), +wz.toFixed(2)]);
    } else if (d.type === 'start' || d.type === 'finish') snapGate(d.type, wx, wz);
  };
  ov.onpointerup = () => {
    if (mv.drag?.type === 'draw' && mv.tool === 'draw') { /* keep tool active for further strokes */ }
    if (mv.drag && ['pt', 'draw'].includes(mv.drag.type)) {
      const c = cur.cfg;
      if (c.start) snapGate('start', c.start.x, c.start.z);
      if (c.finish) snapGate('finish', c.finish.x, c.finish.z);
    }
    mv.drag = null; mv.pan = null;
  };
  ov.ondblclick = (e) => {
    if (mv.tool !== 'select') return;
    const r = ov.getBoundingClientRect();
    const h = mv.hit(e.clientX - r.left, e.clientY - r.top);
    if (h?.type === 'pt') cur.cfg.track.points.splice(h.i, 1);
    else if (h?.type === 'start') { mv.rotating = true; mv.drag = null; $('#tip2').textContent = '旋轉起點：移動滑鼠指向車頭方向，單擊確定'; }
  };
  ov.oncontextmenu = (e) => e.preventDefault();
  ov.onwheel = (e) => {
    e.preventDefault();
    const r = ov.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wz] = mv.toWorld(sx, sy);
    mv.cam.k = Math.max(2, Math.min(400, mv.cam.k * Math.exp(-e.deltaY * 0.0015)));
    const w = r.width, h = r.height;
    mv.cam.x = wx - (sx - w / 2) / mv.cam.k;
    mv.cam.z = wz - (sy - h / 2) / mv.cam.k;
    mv.syncCam();
  };
}

function applyLight() {
  const c = cur.cfg;
  sunLight.intensity = 2.2 * (c.light ?? 1);
  hemiLight.intensity = 1.6 * (c.light ?? 1);
  renderer.toneMappingExposure = c.brightness ?? 1;
}

function applyMapVisibility() {
  const c = cur.cfg;
  const hide = c.hide ? new RegExp(c.hide, 'i') : null;
  mv.root.traverse((o) => {
    if (!o.isMesh) return;
    o.visible = !(hide && (hide.test(o.name) || hide.test(o.parent?.name || '')));
  });
}

async function openMap(asset) {
  mapMode = true;
  newScene(0x10141c);
  camera = ortho;
  cur = { asset, cfg: structuredClone(asset.config) };
  const c = cur.cfg;
  c.track ??= { width: 3, points: [] };
  const gltf = await parseGLB(await downloadModel(asset.url, progressBar(asset.name)));
  mv.root = gltf.scene;
  scene.add(mv.root);
  applyMapVisibility();
  const box = new THREE.Box3().setFromObject(mv.root);
  mv.bounds = { min: box.min, max: box.max };
  const floorY = box.min.y;
  mv.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), floorY + (c.sectionH ?? 1.2));
  renderer.clippingPlanes = [mv.clip];
  ov.style.pointerEvents = 'auto';
  mv.fit();
  mapPointer();
  resize();
  $('#tip').innerHTML = '左鍵：依所選工具操作　右鍵／Shift+拖：平移　滾輪：縮放　選取工具：拖曳點、雙擊刪除點<br><span id="tip2"></span>';
  mapPanel(box);
}

function mapPanel(box) {
  const c = cur.cfg;
  const p = $('#panel');
  const tools = [['select', '選取/拖曳'], ['draw', '畫賽道'], ['start', c.circuit ? '起點/終點' : '起點']];
  if (!c.circuit) tools.push(['finish', '終點']);
  p.replaceChildren(
    text('名稱', () => c.name, (v) => (c.name = v)),
    h3('工具'),
    row('', ...tools.map(([k, t]) => btn(t, () => { mv.tool = k; mapPanel(box); }, mv.tool === k ? 'on' : ''))),
    row('', btn('起點方向改回自動', () => { if (c.start) { c.start.manual = false; snapGate('start', c.start.x, c.start.z); } })),
    hint('起點：選取工具下雙擊起點可自由旋轉方向（移動滑鼠、單擊確定）。'),
    hint('畫賽道：在地圖上按住拖曳 (或單擊加點)；沿行駛方向畫。起點/終點會自動吸附到賽道上。'),
    row('', btn('清除賽道', () => { c.track.points = []; }), btn('反向', () => { c.track.points.reverse(); if (c.start) snapGate('start', c.start.x, c.start.z); }), btn('縮放全圖', () => mv.fit())),
    h3('賽道'),
    check('環狀賽道', () => c.circuit, (v) => { c.circuit = v; mapPanel(box); }),
    check('往返(折返)賽道', () => c.track.pingpong, (v) => (c.track.pingpong = v)),
    hint('環狀 + 往返：沿線開到終端折返回來，適合沒有環形路線的地圖。'),
    num('賽道寬度 (m)', () => c.track.width, (v) => (c.track.width = v), { min: 0.5, max: 30, step: 0.1 }),
    num('預設圈數', () => c.laps, (v) => (c.laps = Math.max(1, Math.round(v))), { min: 1, max: 20, step: 1 }),
    h3('比例'),
    hint(`地圖範圍 (m)：${(box.max.x - box.min.x).toFixed(1)} × ${(box.max.z - box.min.z).toFixed(1)}，高 ${(box.max.y - box.min.y).toFixed(1)}。起點旁的方框為依比例縮小後的賽車。`),
    num('速度上限 km/h', () => c.maxSpeed ?? 160, (v) => (c.maxSpeed = v), { min: 30, max: 400, step: 5 }),
    num('賽車縮放', () => c.carScale, (v) => (c.carScale = v), { min: 0.02, max: 2, step: 0.01 }, true),
    h3('光照'),
    num('光源照射度', () => c.light ?? 1, (v) => { c.light = v; applyLight(); }, { min: 0, max: 3, step: 0.05 }, true),
    num('明亮度', () => c.brightness ?? 1, (v) => { c.brightness = v; applyLight(); }, { min: 0.2, max: 3, step: 0.05 }, true),
    hint('遊戲中會自動曝光 (像眼睛適應光線)，所以不會過亮或過暗。光源照射度：太陽與環境光強度；明亮度：在自動曝光上再調亮或調暗。預設 1。'),
    h3('顯示'),
    num('剖面高度 (m)', () => mv.clip.constant - mv.bounds.min.y, (v) => { mv.clip.constant = mv.bounds.min.y + v; if (c.sectionH != null) c.sectionH = v; }, { min: 0.1, max: Math.max(2, Math.ceil(box.max.y - box.min.y)), step: 0.05 }, true),
    check('遊戲中套用剖面(切掉屋頂)', () => c.sectionH != null, (v) => { c.sectionH = v ? mv.clip.constant - mv.bounds.min.y : null; }),
    hint('拖曳剖面高度，高於此高度的屋頂/天花板會被切掉；勾選後儲存，遊戲的畫面與碰撞都會套用。'),
    text('隱藏(正規式)', () => c.hide, (v) => { c.hide = v; try { applyMapVisibility(); } catch { /* bad regex while typing */ } }),
    text('不碰撞(正規式)', () => c.noCollide, (v) => (c.noCollide = v)),
    hint('隱藏 = 天花板等；不碰撞 = 玻璃、燈等無需阻擋賽車的物件(名稱含這些字)。'),
    el('div', { style: 'margin-top:14px' }, btn('儲存', save, 'pri')),
  );
}

/* ---------- records ---------- */
async function openRecords(asset) {
  newScene();
  mapMode = false;
  ov.style.pointerEvents = 'none';
  $('#tip').textContent = '';
  const p = $('#panel');
  p.replaceChildren(h3(`${asset.name} 紀錄`));
  for (const mode of ['lap', 'time']) {
    const rows = await api.get(`/api/records?map=${asset.id}&mode=${mode}`);
    const t = el('table');
    t.append(el('tr', {}, ...['#', '玩家', mode === 'time' ? '時間' : '圈數', ''].map((x) => el('th', { textContent: x }))));
    rows.forEach((r, i) => t.append(el('tr', {}, el('td', { textContent: i + 1 }), el('td', { textContent: r.player }),
      el('td', { textContent: mode === 'time' ? fmtTime(r.score) : r.score.toFixed(2) }),
      el('td', {}, btn('✕', async () => { await adminFetch(`/api/admin/records/${r.id}`, { method: 'DELETE' }); openRecords(asset); })))));
    p.append(h3(mode === 'time' ? '計時賽' : '繞圈賽 (10 分鐘)'), t);
  }
}

/* ---------- list / tabs ---------- */
async function loadList() {
  if (kind === 'rec') list = await api.assets('map'); else list = await api.assets(kind);
  if (kind === 'car') charAssets = await api.assets('character');
  const l = $('#list');
  l.replaceChildren(...list.map((a) => btn(a.name, () => select(a))));
  $('#panel').replaceChildren();
  if (list[0]) select(list[0]);
}
async function select(a) {
  [...$('#list').children].forEach((b) => b.classList.toggle('on', b.textContent === a.name));
  try {
    if (kind === 'car') await openCar(a);
    else if (kind === 'map') await openMap(a);
    else if (kind === 'character') await openCharacter(a);
    else await openRecords(a);
    resize();
  } catch (e) { console.error(e); toast('載入失敗：' + e.message); }
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  kind = b.dataset.k;
  renderer.clippingPlanes = [];
  loadList();
}));
$('#up').onclick = () => {
  if (kind === 'rec') return toast('請先選擇 賽車/地圖/人物 分頁');
  $('#file').click();
};
$('#file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  toast('上傳中…');
  try {
    await adminFetch(`/api/admin/upload/${kind}/${encodeURIComponent(f.name)}`, { method: 'PUT', body: f });
    toast('上傳完成');
    loadList();
  } catch (err) { toast(err.message); }
  e.target.value = '';
};
$('#rescan').onclick = async () => { await adminFetch('/api/admin/rescan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); loadList(); };

function start() {
  $('#login').remove();
  resize();
  loadList();
}
if (token) {
  adminFetch('/api/admin/rescan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(start).catch(() => {});
}

window.__admin = { persp, orbit, mv, get cur() { return cur; } };
