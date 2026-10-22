import * as THREE from 'three';
import { api, fmtTime } from './api.js';
import { Input, isTouchDevice, isWheel, KEYMAP, PAD_MAP, WHEEL_MAP } from './input.js';
import { GameAudio } from './audio.js';
import { Hud, esc } from './hud.js';
import { createRenderer } from './world.js';
import { Preview } from './preview.js';
import { Game, VIEWS } from './game.js';
import { Room } from './net.js';
import { makeCharacter } from './characters.js';
import { buildCar, seatDriver } from './carmodel.js';
import { downloadModel, parseGLB } from './loader.js';
import { settings, saveSettings } from './settings.js';
import { profile, levelOf, xpForLevel, award, medalFor, parTimes, ACHIEVEMENTS, MEDAL_TEXT } from './profile.js';

const $ui = document.getElementById('ui');
const touch = isTouchDevice();
document.body.classList.toggle('is-touch', touch);

const quality = localStorage.getItem('sp-quality') && localStorage.getItem('sp-quality') !== 'auto'
  ? localStorage.getItem('sp-quality')
  : touch ? 'low' : 'high';
let renderer;
try { renderer = createRenderer(document.getElementById('gl'), quality); } catch (e) {
  $ui.innerHTML = '<div class="screen full"><h1 class="title">無法啟動 3D 繪圖</h1><p style="color:var(--dim)">你的瀏覽器或裝置不支援 WebGL，請更新瀏覽器或開啟硬體加速。</p></div>';
  throw e;
}
const preview = new Preview(renderer);
const input = new Input();
const audio = new GameAudio();
const hud = new Hud(document.getElementById('hud'));
const hudEl = document.getElementById('hud');

const S = { char: null, car: null, map: null, multi: false, playMode: 'time', mt: false, name: localStorage.getItem('sp-name') || '' };
let data = { char: [], car: [], map: [] };
let game = null;
let room = null;
let iceServers = [];

/* ---------------------------------------------------------------- helpers */
function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function show(el) { $ui.replaceChildren(el); return el; }
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const cachedSet = new Set();
async function isCached(url) {
  if (!url) return true;
  try { return !!(await caches.match(new URL(url, location.href).href)); } catch { return false; }
}

/** vertical focus movement through the buttons of a menu (title, big choices, pause ...) */
function moveFocus(dir) {
  const scope = [...document.querySelectorAll('.screen')].pop();
  if (!scope) return false;
  const items = [...scope.querySelectorAll('.menu .btn:not(:disabled), .tab, .row .btn:not(:disabled)')].filter((b) => b.offsetParent);
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement);
  items[(i + dir + items.length) % items.length].focus();
  audio.tick?.();
  return true;
}
function keyNav(handlers) {
  const fn = (e) => {
    if (e.target.matches('input,textarea,select')) { if (e.key === 'Enter' && handlers.Enter) handlers.Enter(e); return; }
    let k = handlers[e.key];
    // synthetic Enter (gamepad A) does not activate a focused button by itself
    if (!k && e.key === 'Enter' && !e.isTrusted) k = () => document.activeElement?.click?.();
    if (!k && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) k = () => moveFocus(e.key === 'ArrowDown' ? 1 : -1);
    if (!k && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && document.activeElement?.closest('.row,.tabs')) k = () => moveFocus(e.key === 'ArrowRight' ? 1 : -1);
    if (k) { e.preventDefault(); k(e); }
  };
  addEventListener('keydown', fn);
  return () => removeEventListener('keydown', fn);
}
let offKeys = null;
function screen(el, handlers) {
  offKeys?.();
  offKeys = handlers ? keyNav(handlers) : null;
  show(el);
  el.querySelector('[autofocus]')?.focus();
}

/* Gamepad drives the menus too: D-pad / left stick = arrows, A = confirm, B = back, Start = pause (wheel: D-pad, ✕, ○) */
const padNext = {};
function padMenuTick() {
  requestAnimationFrame(padMenuTick);
  const gp = input.getPad();
  if (!gp || (game && !game.paused)) return;
  const p = input.padState(gp);
  const now = {
    ArrowUp: p.up || p.ly < -0.6, ArrowDown: p.down || p.ly > 0.6,
    ArrowLeft: p.left || p.lx < -0.6, ArrowRight: p.right || p.lx > 0.6,
    Enter: p.a, Escape: p.b,
  };
  const t = performance.now();
  for (const k in now) {
    if (!now[k]) { delete padNext[k]; continue; }
    const first = !(k in padNext);
    if (!first && (t < padNext[k] || !k.startsWith('Arrow'))) continue;
    padNext[k] = t + (first ? 380 : 120);
    // dispatch from the focused element: keyNav reads e.target.matches(), which window does not have
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  }
}
requestAnimationFrame(padMenuTick);
document.addEventListener('click', (e) => { if (e.target.closest?.('.btn,.tab,.card')) audio.tick?.(); });

/* ---------------------------------------------------------------- boot */
async function boot() {
  try {
    const [c, m, ch, cfg] = await Promise.all([api.assets('car'), api.assets('map'), api.assets('character'), api.get('/api/config')]);
    data = { car: c, map: m, char: ch };
    iceServers = cfg.ice;
  } catch (e) {
    show(h(`<div class="screen full"><h1 class="title">無法連線到伺服器</h1><p>${esc(e.message)}</p></div>`));
    return;
  }
  S.char = data.char[0];
  S.car = data.car[0];
  S.map = data.map[0];
  for (const a of [...data.car, ...data.map]) if (await isCached(a.url)) cachedSet.add(a.url);
  preview.start();
  showCharPreview(S.char);
  const code = new URLSearchParams(location.search).get('room');
  if (code) S.joinCode = code.toUpperCase();
  title();
}

/* ---------------------------------------------------------------- previews */
function charObject(asset, pose) {
  const ch = makeCharacter(asset?.config);
  ch.applyPose(pose || { torso: 0, arm: 8, elbow: 6, thigh: 0, knee: 0, head: 0 });
  return ch;
}
function showCharPreview(asset) {
  if (!asset) return;
  const ch = charObject(asset);
  preview.show(ch.group, { radius: 1.5, lift: 0.95, lookY: 0.95 });
}
/** Stand-in shown until the real model has been downloaded. */
function placeholderCar() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.35, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.7 });
  const add = (geo, m, x, y, z, rx = 0, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, 0, rz); g.add(o); return o; };
  add(new THREE.BoxGeometry(0.55, 0.3, 3.2), paint, 0, 0.3, -0.2);
  add(new THREE.BoxGeometry(0.4, 0.22, 1.5), paint, 0, 0.27, -2.0);
  add(new THREE.BoxGeometry(1.8, 0.05, 0.5), dark, 0, 0.12, -2.65);
  add(new THREE.BoxGeometry(1.5, 0.45, 0.06), dark, 0, 1.0, 2.5);
  add(new THREE.BoxGeometry(1.2, 0.18, 0.7), paint, 0, 0.35, 0.9);
  for (const [x, z, r] of [[-0.95, -1.7, 0.33], [0.95, -1.7, 0.33], [-0.95, 1.75, 0.37], [0.95, 1.75, 0.37]]) add(new THREE.CylinderGeometry(r, r, 0.4, 24), dark, x, r, z, 0, Math.PI / 2);
  return g;
}
const carSceneCache = new Map();
async function showCarPreview(asset, charAsset) {
  if (!asset) return;
  const token = (showCarPreview.t = (showCarPreview.t || 0) + 1);
  if (!(await isCached(asset.url))) {
    const g = placeholderCar();
    const ch = charObject(charAsset, asset.config.pose);
    seatDriver(g, ch, asset.config);
    if (token === showCarPreview.t) preview.show(g, { radius: 2.9 });
    return;
  }
  let scene = carSceneCache.get(asset.url);
  if (!scene) {
    scene = (await parseGLB(await downloadModel(asset.url))).scene;
    carSceneCache.set(asset.url, scene);
  }
  if (token !== showCarPreview.t) return;
  const grp = buildCar(scene.clone(true), asset.config);
  seatDriver(grp, charObject(charAsset, asset.config.pose), asset.config);
  const root = new THREE.Group();
  root.add(grp);
  preview.show(root, { radius: 2.9 });
}

/* ---------------------------------------------------------------- screens */
function title() {
  S.multi = false;
  const el = h(`<div class="screen">
    <div class="sub">Browser Racing</div>
    <div class="brand">SPEED<b>+</b></div>
    <div class="menu">
      <button class="btn" id="start" autofocus>開始</button>
      <button class="btn" id="career">生涯 · 成就</button>
      <button class="btn" id="rank">全服排行榜</button>
      <button class="btn" id="keys">遊戲鍵位說明</button>
      <button class="btn" id="set">設定</button>
    </div>
    <div class="spacer"></div>
    ${careerChip()}
    <div class="row" style="color:var(--dim);font-size:13px"><span id="padinfo"></span></div>
  </div>`);
  el.querySelector('#start').onclick = async () => { await audio.init(); if (touch) document.documentElement.requestFullscreen?.().catch(() => {}); if (S.joinCode) S.multi = true; pickChar(); };
  el.querySelector('#rank').onclick = () => rankScreen();
  el.querySelector('#career').onclick = careerScreen;
  el.querySelector('#keys').onclick = () => keysScreen(title);
  el.querySelector('#set').onclick = () => settingsScreen();
  input.onPad = (on, id, wheel) => { const p = el.querySelector('#padinfo'); if (p) p.textContent = on ? `${wheel ? '🏎️ 方向盤' : '🎮'} 已連接：${id}` : ''; };
  screen(el, {});
  showCharPreview(S.char);
}

/** Generic horizontal card chooser. */
function chooser({ step, title: ttl, items, current, card, onSelect, onPick, onBack, extra = '' }) {
  let idx = Math.max(0, items.findIndex((i) => i.id === current?.id));
  const el = h(`<div class="screen">
    <div class="step">${step}</div><h1 class="title">${ttl}</h1>
    ${extra}
    <div class="spacer"></div>
    <div class="cards" id="cards"></div>
    <div class="row"><button class="btn ghost" id="back">← 返回</button><button class="btn" id="ok" autofocus>決定 →</button></div>
  </div>`);
  const cards = el.querySelector('#cards');
  items.forEach((it, i) => {
    const c = h(`<div class="card" tabindex="0">${card(it)}</div>`);
    c.onclick = () => select(i);
    cards.append(c);
  });
  function select(i) {
    idx = (i + items.length) % items.length;
    [...cards.children].forEach((c, k) => c.classList.toggle('sel', k === idx));
    cards.children[idx].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    onSelect?.(items[idx]);
  }
  el.querySelector('#back').onclick = onBack;
  el.querySelector('#ok').onclick = () => onPick(items[idx]);
  screen(el, {
    ArrowRight: () => select(idx + 1), ArrowLeft: () => select(idx - 1), Enter: () => onPick(items[idx]), Escape: onBack, Backspace: onBack,
  });
  select(idx);
  return el;
}

function pickChar() {
  chooser({
    step: 'STEP 1 / 選擇人物', title: '選擇你的車手', items: data.char, current: S.char,
    card: (c) => `<h3>${esc(c.name)}</h3><div class="sw"><i style="background:${c.config.suit}"></i><i style="background:${c.config.helmet}"></i><i style="background:${c.config.skin}"></i></div><div class="meta">車衣・頭盔・膚色</div>`,
    onSelect: (c) => { S.char = c; showCharPreview(c); },
    onPick: (c) => { S.char = c; pickCar(); },
    onBack: title,
  });
}

function pickCar() {
  chooser({
    step: 'STEP 2 / 選擇賽車', title: '選擇賽車', items: data.car, current: S.car,
    card: (c) => `<h3>${esc(c.config.name || c.name)}</h3>
      <div class="meta">極速上限 ${c.config.topSpeed} km/h</div>
      <div class="kv"><span>馬力</span><b>${(c.config.power * 100) | 0}</b></div><div class="bar"><i style="width:${Math.min(100, c.config.power * 60)}%"></i></div>
      <div class="kv"><span>極速</span><b>${c.config.topSpeed}</b></div><div class="bar"><i style="width:${Math.min(100, c.config.topSpeed / 4)}%"></i></div>
      <div class="meta">${mb(c.size)} ${cachedSet.has(c.url) ? '<span class="pill ok">已下載</span>' : '<span class="pill">開局時下載</span>'}</div>`,
    onSelect: (c) => { S.car = c; showCarPreview(c, S.char); },
    onPick: (c) => { S.car = c; pickMap(); },
    onBack: pickChar,
  });
}

function pickMap() {
  chooser({
    step: 'STEP 3 / 選擇地圖', title: '選擇地圖', items: data.map, current: S.map,
    card: (m) => `<h3>${esc(m.config.name || m.name)}</h3>
      <div class="kv"><span>賽道</span><b>${m.config.track?.points?.length > 2 ? (m.config.circuit ? '環狀' : '直線') : '未設定'}</b></div>
      <div class="kv"><span>圈數</span><b>${m.config.laps}</b></div>
      <div class="kv"><span>車輛比例</span><b>×${m.config.carScale}</b></div>
      <div class="meta">${mb(m.size)} ${cachedSet.has(m.url) ? '<span class="pill ok">已下載</span>' : '<span class="pill">開局時下載</span>'}</div>`,
    onSelect: (m) => { S.map = m; },
    onPick: (m) => { S.map = m; modeScreen(); },
    onBack: pickCar,
  });
  showCarPreview(S.car, S.char);
}

function bigChoice({ step, title: ttl, options, onPick, onBack, note = '' }) {
  const el = h(`<div class="screen"><div class="step">${step}</div><h1 class="title">${ttl}</h1><p style="color:var(--dim);max-width:520px">${note}</p>
    <div class="menu" id="m"></div><div class="spacer"></div><div class="row"><button class="btn ghost" id="back">← 返回</button></div></div>`);
  const m = el.querySelector('#m');
  options.forEach((o, i) => {
    const b = h(`<button class="btn" ${i === 0 ? 'autofocus' : ''}>${o.label}<div style="font-size:12px;font-weight:400;font-style:normal;opacity:.75;letter-spacing:0">${o.desc || ''}</div></button>`);
    b.onclick = () => onPick(o.value);
    m.append(b);
  });
  el.querySelector('#back').onclick = onBack;
  screen(el, {
    Escape: onBack,
    ArrowDown: (e) => (document.activeElement.nextElementSibling || m.firstElementChild).focus(),
    ArrowUp: (e) => (document.activeElement.previousElementSibling || m.lastElementChild).focus(),
  });
}

function modeScreen() {
  bigChoice({
    step: 'STEP 4 / 遊玩方式', title: '單人或多人', onBack: pickMap,
    options: [{ label: '單人', value: 'single', desc: '挑戰全服排行榜' }, { label: '多人 (P2P)', value: 'multi', desc: '建立房間代號，最多 16 人，2 人即可開局' }],
    onPick: (v) => {
      S.multi = v === 'multi';
      if (S.multi) mtScreen(); else playScreen();
    },
  });
}

function playScreen() {
  const m = S.map.config;
  bigChoice({
    step: 'STEP 4 / 單人玩法', title: '選擇玩法', onBack: modeScreen,
    options: [
      { label: '計時賽', value: 'time', desc: `跑完 ${m.laps} 圈，看需要多久` },
      { label: '繞圈賽 · 10 分鐘', value: 'lap', desc: '10 分鐘內盡可能多繞幾圈' },
    ],
    onPick: (v) => { S.playMode = v; mtScreen(); },
  });
}

function mtScreen() {
  bigChoice({
    step: 'STEP 5 / 變速箱', title: '自排 AT 或 手排 MT', onBack: () => (S.multi ? modeScreen() : playScreen()),
    note: touch ? '手排需使用螢幕上的升/降檔按鈕。' : '手排：E / Shift 升檔、Q / Ctrl 降檔；從 N 檔再降一檔為倒車。',
    options: [{ label: 'AT 自排', value: false, desc: '自動換檔，輕鬆上手' }, { label: 'MT 手排', value: true, desc: '自己控制換檔，轉速更精準' }],
    onPick: (mt) => {
      S.mt = mt;
      if (S.multi) multiEntry(); else startSingle();
    },
  });
}

/* ---------------------------------------------------------------- multiplayer lobby */
function multiEntry(err = '') {
  const el = h(`<div class="screen"><div class="step">MULTIPLAYER</div><h1 class="title">多人房間</h1>
    <div class="panel">
      <div class="field"><label>你的名字</label><input type="text" id="name" maxlength="16" value="${esc(S.name)}" placeholder="輸入名字" autofocus></div>
      <div class="field"><label>房間代號 (加入時輸入)</label><input type="text" id="code" maxlength="5" value="${esc(S.joinCode || '')}" placeholder="例如 K7QM2" style="text-transform:uppercase;letter-spacing:.3em"></div>
      <div class="msg-err" id="err">${esc(err)}</div>
      <div class="row"><button class="btn" id="create">建立房間</button><button class="btn" id="join">加入房間</button></div>
      <p style="color:var(--dim);font-size:13px">建立房間時地圖為你剛選的「${esc(S.map.name)}」；加入房間時將使用房主的地圖。</p>
    </div><div class="spacer"></div><div class="row"><button class="btn ghost" id="back">← 返回</button></div></div>`);
  const name = () => el.querySelector('#name').value.trim();
  const fail = (m) => (el.querySelector('#err').textContent = m);
  const go = async (join) => {
    const n = name();
    if (!n) return fail('請輸入名字');
    S.name = n;
    localStorage.setItem('sp-name', n);
    const code = el.querySelector('#code').value.trim().toUpperCase();
    if (join && code.length < 4) return fail('請輸入房間代號');
    el.querySelector('#err').textContent = '連線中…';
    try {
      room = new Room(iceServers);
      const info = { name: n, car: S.car.id, character: S.char.id, mt: S.mt };
      if (join) await room.join({ ...info, code }); else await room.create({ ...info, map: S.map.id, laps: S.map.config.laps });
      S.joinCode = null;
      window.__room = room;
      lobby();
    } catch (e) { room?.leave(); room = null; fail(e.message); }
  };
  el.querySelector('#create').onclick = () => go(false);
  el.querySelector('#join').onclick = () => go(true);
  el.querySelector('#back').onclick = mtScreen;
  screen(el, { Escape: mtScreen });
}

function lobby() {
  const el = h(`<div class="screen"><div class="step">ROOM</div>
    <div class="row"><div class="code" id="code"></div><button class="btn small" id="copy">複製邀請連結</button></div>
    <div class="panel scroll" style="width:min(560px,90vw);max-height:46vh"><table class="t" id="pl"></table></div>
    <div id="hostbox" style="margin-top:12px"></div><div class="msg-err" id="err"></div>
    <div class="spacer"></div><div class="row"><button class="btn ghost" id="leave">← 離開房間</button></div></div>`);
  const render = () => {
    const r = room.roster;
    if (!r) return;
    const map = data.map.find((m) => m.id === r.setup.map);
    el.querySelector('#code').textContent = r.code;
    el.querySelector('#pl').innerHTML = `<tr><th>#</th><th>玩家</th><th>賽車</th><th>連線</th></tr>` + r.players.map((p, i) => {
      const car = data.car.find((c) => c.id === p.car);
      const open = p.id === room.id || room.peers.get(p.id)?.open;
      return `<tr class="${p.id === room.id ? 'me' : ''}"><td>${i + 1}</td><td>${esc(p.name)}${p.id === r.host ? '<span class="pill">房主</span>' : ''}</td><td>${esc(car?.name || p.car)} ${p.mt ? 'MT' : 'AT'}</td><td>${open ? '<span class="pill ok">已連線</span>' : '<span class="pill no">連線中…</span>'}</td></tr>`;
    }).join('');
    const hb = el.querySelector('#hostbox');
    const info = `<div style="color:var(--dim);margin-bottom:8px">地圖：<b style="color:#fff">${esc(map?.name || r.setup.map)}</b>　圈數：<b style="color:#fff">${r.setup.laps}</b>　人數 ${r.players.length}/16</div>`;
    if (room.isHost) {
      hb.innerHTML = info + `<div class="row"><label style="color:var(--dim)">圈數</label><input type="number" id="laps" min="1" max="20" value="${r.setup.laps}" style="width:90px"><button class="btn" id="go" ${r.players.length < 2 ? 'disabled' : ''}>開始比賽</button></div>${r.players.length < 2 ? '<div style="color:var(--dim);font-size:13px;margin-top:6px">至少 2 人才能開局</div>' : ''}`;
      hb.querySelector('#laps').onchange = (e) => room.setup({ laps: +e.target.value });
      hb.querySelector('#go')?.addEventListener('click', () => room.startRace());
    } else hb.innerHTML = info + '<div style="color:var(--acc)">等待房主開始比賽…</div>';
  };
  room.on.roster = render;
  room.on.peerOpen = render;
  room.on.peerClose = render;
  room.on.error = (m) => (el.querySelector('#err').textContent = m);
  room.on.start = (m) => startMulti(m);
  room.on.closed = () => { if (!game) { room = null; title(); } };
  el.querySelector('#copy').onclick = () => { navigator.clipboard?.writeText(`${location.origin}/?room=${room.code}`); el.querySelector('#err').textContent = '已複製邀請連結'; };
  const leave = () => { room.on.closed = null; room.leave(); room = null; title(); };
  el.querySelector('#leave').onclick = leave;
  screen(el, { Escape: leave });
  render();
}

/* ---------------------------------------------------------------- race start */
const TIPS = [
  '提示：按住空白鍵不放可以甩尾，維持漂移角度累積漂移分數。',
  '提示：入彎前先放油門再煞車，出彎時再慢慢補油。',
  '提示：按 R 可以隨時回到賽道，按 C 切換四種視角。',
  '提示：滑鼠左鍵拖曳可以環顧四周，放開後會自動回正。',
  '提示：手把支援震動回饋，碰撞、紅線與打滑都能感覺到。',
  '提示：在設定裡可以調整 FOV、HUD 大小與速度單位。',
];
function loadingScreen(text) {
  const el = h(`<div class="screen full"><div class="loadbox"><div class="brand" style="font-size:56px">SPEED<b>+</b></div><h2 id="t" style="font-style:italic">${text}</h2><div id="bars"></div><div style="color:var(--dim);font-size:13px">模型會儲存在本機，下次無須重新下載</div><div class="tip" style="margin-top:22px">${TIPS[Math.floor(Math.random() * TIPS.length)]}</div></div></div>`);
  screen(el, {});
  const bars = el.querySelector('#bars');
  const rows = {};
  return (label, i, p, bytes, cached) => {
    if (!rows[i]) { rows[i] = h(`<div><div class="lbl"><span></span><span></span></div><div class="pbar"><i></i></div></div>`); bars.append(rows[i]); }
    const r = rows[i];
    r.querySelector('.lbl span').textContent = label;
    r.querySelector('.lbl span:last-child').textContent = cached ? '本機快取' : bytes ? mb(bytes) : '';
    r.querySelector('i').style.width = `${(p ?? 0) * 100}%`;
  };
}

function makeAssetMaps() {
  return {
    carAssets: Object.fromEntries(data.car.map((c) => [c.id, c])),
    charAssets: Object.fromEntries(data.char.map((c) => [c.id, c])),
  };
}

async function createGame(opts, progress) {
  preview.stop();
  const g = new Game({ renderer, hud, input, audio, quality, mt: S.mt, car: S.car, character: S.char, myName: S.name, ...makeAssetMaps(), ...opts });
  await g.load(progress);
  return g;
}

async function startSingle() {
  const progress = loadingScreen('準備賽道…');
  try {
    game = await createGame({ mode: S.playMode, map: S.map, laps: S.map.config.laps }, progress);
  } catch (e) { console.error(e); return loadFailed(e); }
  S.map.config && data.car.concat(data.map).forEach((a) => cachedSet.add(a.url));
  runGame();
}

function loadFailed(e) {
  preview.start();
  show(h(`<div class="screen full"><h1 class="title">載入失敗</h1><p>${esc(e.message)}</p><div class="menu"><button class="btn" id="b" autofocus>返回</button></div></div>`));
  $ui.querySelector('#b').onclick = title;
}

function runGame() {
  hudEl.classList.remove('hidden');
  $ui.replaceChildren();
  offKeys?.(); offKeys = null;
  setupTouch();
  hud.setView(VIEWS[0]);
  window.__game = game;
  game.onPause = () => togglePause();
  game.onFinish = (res) => finished(res);
  const multi = game.mode === 'multi';
  game.canStart = !multi || room.isHost;
  game.onStartRequest = () => {
    if (multi) room.broadcast({ t: 'go' });
    game.begin(3500);
  };
  game.waitStart();
  if (pendingGo) { pendingGo = false; game.begin(3500); }
}

let pendingGo = false;
async function startMulti(m) {
  const r = room.roster;
  const players = m.order.map((id) => r.players.find((p) => p.id === id)).filter(Boolean);
  const map = data.map.find((x) => x.id === r.setup.map);
  if (!map) { room.on.error?.('找不到房主的地圖'); return; }
  const me = players.find((p) => p.id === room.id);
  const myCar = data.car.find((c) => c.id === me.car) || S.car;
  const myChar = data.char.find((c) => c.id === me.character) || S.char;
  const progress = loadingScreen('等待所有玩家…');
  const ready = new Set();
  pendingGo = false;
  room.on.data = (id, msg) => {
    if (msg.t === 'ready') ready.add(id);
    else if (msg.t === 'go') { if (game?.state === 'waiting') game.begin(3500); else pendingGo = true; }
    else game?.onNet(id, msg);
  };
  try {
    game = await createGame({ mode: 'multi', map, car: myCar, character: myChar, mt: me.mt, laps: r.setup.laps, room, players }, progress);
  } catch (e) { console.error(e); room.leave(); room = null; return loadFailed(e); }
  game.initNet();
  game.waitText = () => (room.isHost ? `已就緒 ${ready.size + 1}/${players.length}　長按 空白鍵 / A / ✕ 1.5 秒開始比賽` : '');
  room.broadcast({ t: 'ready' });
  runGame();
}

/* ---------------------------------------------------------------- pause / finish */
function togglePause() {
  if (!game || game.state === 'loading') return;
  if (game.pauseEl && !game.pauseEl.isConnected) return; // a sub-screen (settings / keys) is open
  if (game.pauseEl) { closePause(); return; }
  game.paused = true;
  audio.pause(game.mode !== 'multi');
  const multi = game.mode === 'multi';
  const el = h(`<div class="screen full pause" style="align-items:center;justify-content:center"><div class="menu" style="margin:0">
    <div class="step" style="text-align:center">PAUSED</div>
    <h1 class="title" style="text-align:center;margin-bottom:10px">暫停${multi ? ' <small style="font-size:14px;color:var(--dim)">(比賽持續進行)</small>' : ''}</h1>
    <button class="btn" id="r" autofocus>繼續</button>
    ${multi ? '' : '<button class="btn" id="re">重新開始</button>'}
    <button class="btn" id="rs">復位到賽道 (R)</button>
    <button class="btn" id="cr">重置視角</button>
    <button class="btn" id="st">設定</button>
    <button class="btn" id="k">遊戲鍵位說明</button>
    <button class="btn" id="q">離開比賽</button></div></div>`);
  game.pauseEl = el;
  game.pauseOff = keyNav({ Escape: (e) => { if (!e.isTrusted) togglePause(); } });
  el.querySelector('#r').onclick = togglePause;
  el.querySelector('#re')?.addEventListener('click', () => { togglePause(); game.restart(); });
  el.querySelector('#rs').onclick = () => { togglePause(); game.resetToTrack(); };
  el.querySelector('#cr').onclick = () => { game.look.yaw = game.look.pitch = 0; closePause(); };
  el.querySelector('#st').onclick = () => { el.remove(); settingsScreen(() => document.body.append(el), document.body); };
  el.querySelector('#k').onclick = () => { el.remove(); keysScreen(() => { document.body.append(el); }, document.body); };
  el.querySelector('#q').onclick = quitToMenu;
  document.body.append(el);
  el.style.position = 'fixed';
  el.style.zIndex = 20;
  el.querySelector('#r').focus();
}
function closePause() {
  if (!game?.pauseEl) return;
  game.pauseEl.remove();
  game.pauseEl = null;
  game.pauseOff?.();
  game.pauseOff = null;
  game.paused = false;
  audio.pause(false);
}

function quitToMenu() {
  game?.pauseOff?.();
  audio.pause(false);
  game?.pauseEl?.remove();
  game?.dispose();
  game = null;
  if (room) { room.on.closed = null; room.leave(); room = null; }
  hudEl.classList.add('hidden');
  preview.start();
  title();
}

async function finished(res) {
  game.paused = true;
  hudEl.classList.add('hidden');
  if (res.mode === 'multi') return multiResult(res);
  const mapId = S.map.id;
  const recMode = res.mode;
  const score = res.score;
  let isRecord = false;
  if (score > 0 && (recMode === 'time' || res.laps >= 1 || res.score > 0.05)) {
    try { isRecord = (await api.post('/api/records', { map_id: mapId, car_id: S.car.id, mode: recMode, score, check: true })).isRecord; } catch { /* offline */ }
  }
  const par = parTimes(game);
  const medal = medalFor(res, game);
  const rw = award(res, { mapId, medal, drift: res.drift, driftBest: res.driftBest, hits: res.hits });
  const summary = recMode === 'time'
    ? `<div class="code" style="font-size:44px;letter-spacing:.05em">${fmtTime(res.ms)}</div>`
    : `<div class="code" style="font-size:44px;letter-spacing:.05em">${res.score.toFixed(2)} 圈</div>`;
  const el = h(`<div class="screen full"><div class="step">${recMode === 'time' ? 'TIME ATTACK' : '10 MIN LAP RACE'} · ${esc(S.map.name)}</div><h1 class="title">${isRecord ? '🏆 新紀錄！' : '完賽'}</h1>
    ${summary}<div style="color:var(--dim)">最佳單圈 ${fmtTime(res.bestLap)}</div>
    ${rewardHtml(rw)}
    <div style="color:var(--dim);font-size:12px">${recMode === 'time' ? `金牌 ${fmtTime(par.gold)} · 銀牌 ${fmtTime(par.silver)} · 銅牌 ${fmtTime(par.bronze)}` : ''}</div>
    <div id="rec" style="margin:14px 0"></div>
    <div class="panel scroll" style="max-height:36vh;width:min(560px,92vw)"><table class="t" id="lb"></table></div>
    <div class="spacer"></div>
    <div class="row"><button class="btn" id="again" autofocus>再來一次</button><button class="btn ghost" id="menu">回主選單</button></div></div>`);
  const lb = async (hl) => {
    const rows = await api.get(`/api/records?map=${mapId}&mode=${recMode}`).catch(() => []);
    const carName = (id) => data.car.find((c) => c.id === id)?.name || id;
    el.querySelector('#lb').innerHTML = `<tr><th>#</th><th>玩家</th><th>賽車</th><th>${recMode === 'time' ? '時間' : '圈數'}</th></tr>` +
      rows.slice(0, 10).map((r, i) => `<tr class="${hl && r.created === hl ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.player)}</td><td>${esc(carName(r.car_id))}</td><td>${recMode === 'time' ? fmtTime(r.score) : r.score.toFixed(2)}</td></tr>`).join('');
  };
  el.querySelector('#again').onclick = () => { el.remove(); hudEl.classList.remove('hidden'); game.paused = false; game.restart(); };
  el.querySelector('#again').focus();
  el.querySelector('#menu').onclick = () => { el.remove(); quitToMenu(); };
  document.body.append(el);
  el.style.cssText += ';position:fixed;z-index:20;overflow:auto';
  if (isRecord) {
    el.querySelector('#rec').innerHTML = `<div class="panel row"><input type="text" id="rn" maxlength="16" placeholder="輸入名字登記排行榜" value="${esc(S.name)}" style="flex:1;min-width:200px"><button class="btn small" id="sub">登記</button></div><div class="msg-err" id="re"></div>`;
    el.querySelector('#sub').onclick = async () => {
      const n = el.querySelector('#rn').value.trim();
      if (!n) return;
      S.name = n; localStorage.setItem('sp-name', n);
      try {
        await api.post('/api/records', { map_id: mapId, car_id: S.car.id, mode: recMode, score, best_lap_ms: res.bestLap, player: n });
        el.querySelector('#rec').innerHTML = '<div style="color:#7dff9b">已登記到全服排行榜！</div>';
        lb(true);
      } catch (e) { el.querySelector('#re').textContent = e.status === 409 ? '紀錄已被刷新，未登記' : e.message; }
    };
    el.querySelector('#rn').focus();
  }
  lb();
}

function multiResult(res) {
  const rows = res.rows;
  const place = rows.findIndex((r) => r.id === res.me) + 1;
  const rw = award({ mode: 'multi', laps: game?.lapsDone || 0, ms: game?.finishMs || 0 }, { mapId: game?.map?.id, place, players: rows.length, drift: game?.drift.total, driftBest: game?.drift.best, hits: game?.hits });
  const el = h(`<div class="screen full"><div class="step">RACE RESULT</div><h1 class="title">比賽結果</h1>
    <div class="panel scroll" style="max-height:56vh;width:min(560px,92vw)"><table class="t"><tr><th>#</th><th>玩家</th><th>成績</th></tr>
    ${rows.map((r, i) => `<tr class="${r.id === res.me ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.text}</td></tr>`).join('')}</table></div>
    ${rewardHtml(rw)}
    <div class="spacer"></div><div class="row"><button class="btn" id="back" autofocus>${room.isHost ? '返回房間' : '等待房主…'}</button><button class="btn ghost" id="leave">離開</button></div></div>`);
  document.body.append(el);
  el.style.cssText += ';position:fixed;z-index:20;overflow:auto';
  const toLobby = () => {
    el.remove();
    game?.dispose();
    game = null;
    hudEl.classList.add('hidden');
    preview.start();
    room.on.data = null;
    lobby();
  };
  if (room.isHost) el.querySelector('#back').onclick = () => { room.endRace(); toLobby(); };
  else {
    el.querySelector('#back').disabled = false;
    const prev = room.on.roster;
    room.on.roster = (r) => { if (r.state === 'lobby') toLobby(); else prev?.(r); };
  }
  el.querySelector('#leave').onclick = () => { el.remove(); quitToMenu(); };
}

/* ---------------------------------------------------------------- career */
function careerChip() {
  const lv = levelOf(profile.xp);
  const a = xpForLevel(lv), b = xpForLevel(lv + 1);
  return `<div class="chip"><div class="lv">${lv}</div><div class="chip-body"><div class="chip-top"><span>車手等級</span><b>${profile.credits.toLocaleString()} CR</b></div><div class="bar"><i style="width:${((profile.xp - a) / (b - a)) * 100}%"></i></div></div></div>`;
}
const medalDot = (m) => `<span class="medal m${m}">${m ? MEDAL_TEXT[['', 'bronze', 'silver', 'gold'][m]] : '—'}</span>`;

function careerScreen() {
  const st = profile.stats;
  const mapsRows = data.map.map((m) => `<tr><td>${esc(m.config.name || m.name)}</td><td>${medalDot(profile.medals[m.id + '|time'] || 0)}</td><td>${medalDot(profile.medals[m.id + '|lap'] || 0)}</td></tr>`).join('');
  const el = h(`<div class="screen full"><div class="step">CAREER</div><h1 class="title">生涯 · 成就</h1>
    <div class="career scroll">
      <div>${careerChip()}
        <div class="keys" style="grid-template-columns:1fr;margin-top:14px">
          <div><span>完成比賽</span><b>${st.races}</b></div><div><span>多人勝場</span><b>${st.wins}</b></div>
          <div><span>累計圈數</span><b>${st.laps}</b></div><div><span>漂移總分</span><b>${Math.round(st.driftTotal).toLocaleString()}</b></div>
          <div><span>最高漂移連鎖</span><b>${Math.round(st.driftBest).toLocaleString()}</b></div><div><span>碰撞次數</span><b>${st.hits}</b></div>
        </div>
        <table class="t" style="margin-top:14px"><tr><th>地圖</th><th>計時賽</th><th>繞圈賽</th></tr>${mapsRows}</table></div>
      <div class="achs">${ACHIEVEMENTS.map((a) => `<div class="ach ${profile.ach[a.id] ? 'on' : ''}"><i>${profile.ach[a.id] ? '★' : '☆'}</i><div><b>${a.name}</b><span>${a.desc}</span></div></div>`).join('')}</div>
    </div>
    <div class="spacer"></div><div class="row"><button class="btn" id="b" autofocus>← 返回</button></div></div>`);
  el.querySelector('#b').onclick = title;
  screen(el, { Escape: title });
}

function rewardHtml(rw) {
  return `<div class="rewards">
    ${rw.medal ? `<div class="medalbig m${rw.medal}">${MEDAL_TEXT[['', 'bronze', 'silver', 'gold'][rw.medal]]}${rw.medalUp ? ' <small>NEW</small>' : ''}</div>` : ''}
    <div class="rw"><span>獎勵積分</span><b>+${rw.credits.toLocaleString()} CR</b></div>
    <div class="rw"><span>經驗值</span><b>+${rw.xp} XP</b></div>
    ${rw.drift ? `<div class="rw"><span>漂移分數</span><b>${Math.round(rw.drift).toLocaleString()}</b></div>` : ''}
    ${rw.levelUp ? `<div class="levelup">LEVEL UP！ Lv.${rw.level}</div>` : ''}
    ${rw.unlocked.map((a) => `<div class="levelup" style="color:var(--acc2)">★ 成就解鎖：${a.name}</div>`).join('')}
  </div>`;
}

/* ---------------------------------------------------------------- misc screens */
function keysScreen(back, parent) {
  const el = h(`<div class="screen full" style="${parent ? 'position:fixed;z-index:30;overflow:auto' : ''}"><div class="step">CONTROLS</div><h1 class="title">遊戲鍵位說明</h1>
    <div class="scroll"><h3 style="color:var(--acc)">鍵盤 (電腦)</h3><div class="keys">${KEYMAP.filter((k) => k[0]).map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join('')}</div>
    <h3 style="color:var(--acc)">Xbox 手把 (支援震動回饋)</h3><div class="keys">${PAD_MAP.map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join('')}</div>
    <h3 style="color:var(--acc)">方向盤 + 踏板 (Logitech G29 / G923)</h3><div class="keys">${WHEEL_MAP.map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join('')}</div>
    <h3 style="color:var(--acc)">手機 / 平板 (橫放)</h3><p style="color:var(--dim)">螢幕左下 ◀ ▶ 轉向；右下為油門、煞車、手煞車；手排時出現升/降檔按鈕；右上可切換視角、重置、暫停。</p></div>
    <div class="spacer"></div><div class="row"><button class="btn" id="b" autofocus>← 返回</button></div></div>`);
  const close = () => { el.remove(); (back || title)(); };
  el.querySelector('#b').onclick = close;
  if (parent) { parent.append(el); const off = keyNav({ Escape: () => { off(); close(); } }); }
  else screen(el, { Escape: close });
}

function settingsScreen(back = title, parent) {
  const q = localStorage.getItem('sp-quality') || 'auto';
  const sw = (id, label, on) => `<div class="field sw"><label for="${id}">${label}</label><button class="toggle ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${!!on}"><i></i></button></div>`;
  const el = h(`<div class="screen${parent ? ' full' : ''}" style="${parent ? 'position:fixed;z-index:30;overflow:auto' : ''}"><div class="step">SETTINGS</div><h1 class="title">設定</h1>
    <div class="panel scroll" style="max-width:640px;width:min(640px,92vw)">
      <div class="field"><label>音量</label><input type="range" id="vol" min="0" max="1" step="0.05" value="${audio.volume}"></div>
      <div class="field"><label>速度單位</label><div class="tabs" id="units" style="margin:0">${[['kmh', 'km/h'], ['mph', 'mph']].map(([v, t]) => `<button class="tab ${settings.units === v ? 'on' : ''}" data-v="${v}">${t}</button>`).join('')}</div></div>
      <div class="field"><label>視野角 FOV <b id="fovv" style="color:#fff">${settings.fov}°</b></label><input type="range" id="fov" min="50" max="90" step="1" value="${settings.fov}"></div>
      <div class="field"><label>HUD 大小 <b id="hudv" style="color:#fff">${Math.round(settings.hudScale * 100)}%</b></label><input type="range" id="hud" min="0.7" max="1.3" step="0.05" value="${settings.hudScale}"></div>
      ${sw('steerAssist', '轉向輔助 (甩尾時自動反打方向盤)', settings.steerAssist)}
      ${sw('throttleAssist', '鍵盤油門 / 煞車漸進 (更好控制)', settings.throttleAssist)}
      ${sw('shake', '鏡頭震動', settings.shake)}
      ${sw('dynRes', '動態解析度 (自動維持流暢幀率)', settings.dynRes)}
      ${sw('debug', '效能資訊 (FPS / 繪製次數 / GPU)', settings.debug)}
      <div class="field"><label>方向盤轉角 (左右打到底) <b id="wlv" style="color:#fff">${settings.wheelLock}°</b></label><input type="range" id="wlock" min="180" max="900" step="30" value="${settings.wheelLock}"></div>
      <div class="field"><label>方向盤 / 踏板 <b id="wlive" style="color:#fff"></b></label><div class="row" style="margin:0"><button class="btn" id="wcal">重新偵測踏板</button></div></div>
      <div class="field"><label>畫質 (變更後重新載入)</label><select id="q">${[['auto', '自動'], ['low', '低 (行動裝置)'], ['medium', '中'], ['high', '高']].map(([v, t]) => `<option value="${v}" ${v === q ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    </div><div class="spacer"></div><div class="row"><button class="btn" id="b" autofocus>← 返回</button></div></div>`);
  el.querySelector('#vol').oninput = (e) => audio.setVolume(+e.target.value);
  el.querySelector('#fov').oninput = (e) => { saveSettings({ fov: +e.target.value }); el.querySelector('#fovv').textContent = e.target.value + '°'; };
  el.querySelector('#hud').oninput = (e) => { saveSettings({ hudScale: +e.target.value }); el.querySelector('#hudv').textContent = Math.round(e.target.value * 100) + '%'; };
  el.querySelectorAll('#units .tab').forEach((t) => (t.onclick = () => { saveSettings({ units: t.dataset.v }); el.querySelectorAll('#units .tab').forEach((x) => x.classList.toggle('on', x === t)); }));
  el.querySelectorAll('.toggle').forEach((t) => (t.onclick = () => {
    const on = !t.classList.contains('on');
    t.classList.toggle('on', on);
    t.setAttribute('aria-checked', on);
    saveSettings({ [t.id]: on });
  }));
  el.querySelector('#q').onchange = (e) => { localStorage.setItem('sp-quality', e.target.value); location.reload(); };
  el.querySelector('#wlock').oninput = (e) => { saveSettings({ wheelLock: +e.target.value }); el.querySelector('#wlv').textContent = e.target.value + '°'; };
  // live wheel readout + pedal detection: press throttle, then brake; the pedal is the axis that moved furthest from rest
  const live = el.querySelector('#wlive');
  let calStep = null, rest = null;
  el.querySelector('#wcal').onclick = () => { const gp = input.getPad(); if (isWheel(gp)) { rest = [...gp.axes]; calStep = 'throttle'; } };
  const wheelTick = () => {
    if (!el.isConnected) return;
    requestAnimationFrame(wheelTick);
    const gp = input.getPad();
    if (!isWheel(gp)) { live.textContent = '未偵測到 (先按方向盤上任一鍵)'; calStep = null; return; }
    if (calStep) {
      const moved = gp.axes.map((v, i) => (i === 0 || Math.abs(rest[i]) > 1.05 || (calStep === 'brake' && i === settings.wheelAxes.throttle) ? 0 : Math.abs(v - rest[i])));
      const i = moved.indexOf(Math.max(...moved));
      if (moved[i] > 1) {
        saveSettings({ wheelAxes: { ...settings.wheelAxes, [calStep]: i } });
        calStep = calStep === 'throttle' ? 'brake' : null;
      }
      live.textContent = calStep === 'throttle' ? '踩住油門到底…' : calStep === 'brake' ? '油門 OK，放開後踩住煞車到底…' : '';
      return;
    }
    const p = input.padState(gp);
    live.textContent = `轉向 ${Math.round(p.steer * 100)}%　油門 ${Math.round(p.rt * 100)}%　煞車 ${Math.round(p.lt * 100)}%`;
  };
  requestAnimationFrame(wheelTick); // el is attached after this function returns
  const close = () => { el.remove(); back(); };
  el.querySelector('#b').onclick = close;
  if (parent) { parent.append(el); const off = keyNav({ Escape: () => { off(); close(); } }); el.querySelector('#b').onclick = () => { off(); close(); }; el.querySelector('#b').focus(); }
  else screen(el, { Escape: close });
}

async function rankScreen(mapId = S.map?.id, mode = 'time') {
  const el = h(`<div class="screen full"><div class="step">LEADERBOARD</div><h1 class="title">全服排行榜</h1>
    <div class="tabs" id="mt"></div><div class="tabs" id="md"></div>
    <div class="panel scroll" style="max-height:52vh;width:min(640px,94vw)"><table class="t" id="lb"></table></div>
    <div class="spacer"></div><div class="row"><button class="btn" id="b" autofocus>← 返回</button></div></div>`);
  const rows = await api.get(`/api/records?map=${mapId}&mode=${mode}`).catch(() => []);
  el.querySelector('#mt').append(...data.map.map((m) => { const b = h(`<button class="tab ${m.id === mapId ? 'on' : ''}">${esc(m.name)}</button>`); b.onclick = () => rankScreen(m.id, mode); return b; }));
  el.querySelector('#md').append(...[['time', '計時賽'], ['lap', '繞圈賽 10 分鐘']].map(([v, t]) => { const b = h(`<button class="tab ${v === mode ? 'on' : ''}">${t}</button>`); b.onclick = () => rankScreen(mapId, v); return b; }));
  el.querySelector('#lb').innerHTML = `<tr><th>#</th><th>玩家</th><th>賽車</th><th>${mode === 'time' ? '時間' : '圈數'}</th><th>日期</th></tr>` +
    (rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.player)}</td><td>${esc(data.car.find((c) => c.id === r.car_id)?.name || r.car_id)}</td><td>${mode === 'time' ? fmtTime(r.score) : r.score.toFixed(2)}</td><td>${new Date(r.created).toLocaleDateString()}</td></tr>`).join('') : '<tr><td colspan="5" style="color:var(--dim)">尚無紀錄，成為第一名吧！</td></tr>');
  el.querySelector('#b').onclick = title;
  screen(el, { Escape: title });
}

/* ---------------------------------------------------------------- touch controls */
function setupTouch() {
  const box = hudEl.querySelector('#touch');
  box.replaceChildren();
  if (!touch) return;
  const btn = (cls, label, down, up) => {
    const b = document.createElement('div');
    b.className = 'tb ' + cls;
    b.textContent = label;
    const on = (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); b.classList.add('on'); down(); };
    const off = (e) => { e.preventDefault(); b.classList.remove('on'); up?.(); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('lostpointercapture', off);
    box.append(b);
    return b;
  };
  const t = input.touch;
  btn('steer', '◀', () => (t.left = true), () => (t.left = false)).style.left = 'max(20px,env(safe-area-inset-left))';
  btn('steer', '▶', () => (t.right = true), () => (t.right = false)).style.left = 'calc(max(20px,env(safe-area-inset-left)) + min(22vh,110px) + 14px)';
  btn('gas', 'GAS', () => (t.gas = true), () => (t.gas = false));
  btn('brk', 'BRAKE', () => (t.brake = true), () => (t.brake = false));
  btn('start', '按住開始', () => (t.hold = true), () => (t.hold = false));
  btn('hand', 'DRIFT', () => (t.hand = true), () => (t.hand = false));
  const top = (label, off, fn) => { const b = btn('sm', label, fn); b.style.top = '10px'; b.style.left = `calc(50% + ${off}px)`; return b; };
  top('⏸', -82, () => (input.edge.pause = true));
  top('↺', -26, () => (input.edge.reset = true));
  top('👁', 30, () => (input.edge.view = true));
  if (game?.mt) {
    const mk = (label, left, fn) => { const x = btn('sm', label, fn); x.style.left = left; x.style.bottom = 'calc(max(20px,env(safe-area-inset-bottom)) + min(22vh,110px) + 14px)'; x.style.top = 'auto'; x.style.width = x.style.height = '56px'; };
    mk('DN', 'max(20px,env(safe-area-inset-left))', () => (input.edge.down = true));
    mk('UP', 'calc(max(20px,env(safe-area-inset-left)) + 70px)', () => (input.edge.up = true));
  }
}

boot();
