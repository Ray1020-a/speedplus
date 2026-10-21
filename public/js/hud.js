import { fmtTime } from './api.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.append(e);
  return e;
};

// seven-segment digit geometry (in a 28x46 box), slanted for the italic arcade look
const SEG = {
  a: '5,2 23,2 20,7 8,7', b: '24,3 24,21 20,19 20,9', c: '24,25 24,43 20,38 20,27',
  d: '5,44 23,44 20,39 8,39', e: '4,25 8,27 8,38 4,43', f: '4,3 8,9 8,19 4,21', g: '5,23 8,20 20,20 23,23 20,26 8,26',
};
const DIGITS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', ' ': '' };

function makeDigits(parent, n, x, y, scale) {
  const g = svg('g', { transform: `translate(${x} ${y}) scale(${scale}) skewX(-10)` }, parent);
  const digits = [];
  for (let i = 0; i < n; i++) {
    const d = svg('g', { transform: `translate(${i * 32} 0)` }, g);
    const segs = {};
    for (const k in SEG) segs[k] = svg('polygon', { points: SEG[k], class: 'seg' }, d);
    digits.push(segs);
  }
  return (str) => digits.forEach((segs, i) => {
    const on = DIGITS[str[i] ?? ' '] ?? '';
    for (const k in segs) segs[k].classList.toggle('on', on.includes(k));
  });
}

export class Hud {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-tl"><div class="hud-mode" id="h-mode"></div><div class="hud-time" id="h-time">00:00.000</div>
        <div class="hud-laps"><b id="h-lap">LAP 1/3</b><span id="h-best"></span></div><div class="hud-last" id="h-last"></div></div>
      <div class="hud-tr"><div id="h-board"></div></div>
      <div class="hud-center" id="h-msg"></div>
      <div class="hud-warn" id="h-warn">逆向行駛</div>
      <div class="hud-view" id="h-view"></div>
      <div class="hud-drift" id="h-drift"><div class="dp" id="h-dp"></div><div class="dm" id="h-dm"></div></div>
      <div class="hud-total" id="h-total"></div>
      <div class="hud-hold" id="h-hold"><div id="h-hold-t"></div><div class="hb"><i id="h-hold-b"></i></div></div>
      <canvas class="hud-map" id="h-map" width="360" height="360"></canvas>
      <div class="hud-speedo" id="h-speedo"></div>
      <div class="touch" id="touch"></div>`;
    this.buildSpeedo();
    this.map = root.querySelector('#h-map').getContext('2d');
    this.$ = (id) => root.querySelector('#' + id);
    this.lastBoard = '';
  }

  buildSpeedo() {
    const box = this.root.querySelector('#h-speedo');
    const s = svg('svg', { viewBox: '0 0 320 250', class: 'speedo' }, box);
    const defs = svg('defs', {}, s);
    const grad = svg('radialGradient', { id: 'sp-bg', cx: '50%', cy: '55%', r: '60%' }, defs);
    svg('stop', { offset: '0', 'stop-color': '#0b1624', 'stop-opacity': '.92' }, grad);
    svg('stop', { offset: '1', 'stop-color': '#05080f', 'stop-opacity': '.78' }, grad);
    svg('path', { d: 'M20 235 A140 140 0 1 1 300 235 Z', fill: 'url(#sp-bg)', stroke: '#3be7ff55', 'stroke-width': 1.5 }, s);
    // tachometer: 44 segments from 150deg to 390deg (clockwise through the top)
    this.segs = [];
    const N = 44, cx = 160, cy = 160, r1 = 118, r2 = 138;
    for (let i = 0; i < N; i++) {
      const a = (150 + (240 * i) / (N - 1)) * (Math.PI / 180);
      const a0 = a - 0.028, a1 = a + 0.028;
      const p = (r, an) => `${cx + r * Math.cos(an)},${cy + r * Math.sin(an)}`;
      const t = i / (N - 1);
      const col = t > 0.86 ? '#ff2d4a' : t > 0.7 ? '#ffb020' : '#3be7ff';
      const poly = svg('polygon', { points: `${p(r1, a0)} ${p(r2 + (i % 5 === 0 ? 5 : 0), a0)} ${p(r2 + (i % 5 === 0 ? 5 : 0), a1)} ${p(r1, a1)}`, fill: col, class: 'tseg' }, s);
      this.segs.push(poly);
    }
    this.tickLabels = [];
    this.tickGroup = svg('g', { 'font-size': 11, fill: '#cfe9ff', 'text-anchor': 'middle', 'font-family': 'system-ui', 'font-style': 'italic' }, s);
    svg('text', { x: 160, y: 104, 'text-anchor': 'middle', 'font-size': 10, fill: '#6fa6c8', 'font-family': 'system-ui', 'letter-spacing': 2 }, s).textContent = '× 1000 rpm';
    this.setSpeedDigits = makeDigits(s, 3, 88, 112, 1.5);
    this.unitText = svg('text', { x: 236, y: 176, 'font-size': 16, 'font-style': 'italic', 'font-weight': 700, fill: '#8fe9ff', 'font-family': 'system-ui' }, s);
    this.unitText.textContent = 'km/h';
    // gear box
    svg('rect', { x: 128, y: 190, width: 64, height: 46, rx: 6, fill: '#000a', stroke: '#3be7ff88' }, s);
    this.gearText = svg('text', { x: 160, y: 227, 'text-anchor': 'middle', 'font-size': 40, 'font-weight': 800, 'font-style': 'italic', fill: '#fff', 'font-family': 'system-ui' }, s);
    this.modeText = svg('text', { x: 108, y: 218, 'text-anchor': 'end', 'font-size': 14, 'font-weight': 700, fill: '#ffb020', 'font-family': 'system-ui' }, s);
    svg('text', { x: 212, y: 218, 'font-size': 11, fill: '#6fa6c8', 'font-family': 'system-ui' }, s).textContent = 'GEAR';
    this.rpmMax = 0;
  }

  setRedline(redline) {
    this.redline = redline;
    this.tickGroup.replaceChildren();
    const maxK = Math.ceil(redline / 1000);
    const step = maxK > 10 ? 2 : 1;
    for (let k = 0; k <= maxK; k += step) {
      const t = Math.min(1, (k * 1000) / (maxK * 1000));
      const a = (150 + 240 * t) * (Math.PI / 180);
      const tx = svg('text', { x: 160 + 100 * Math.cos(a), y: 164 + 100 * Math.sin(a) }, this.tickGroup);
      tx.textContent = k;
    }
    this.rpmMax = maxK * 1000;
  }

  setDash(kmh, rpm, gear, mt) {
    this.setSpeedDigits(String(Math.round(kmh)).padStart(3, ' '));
    const lit = Math.round((rpm / this.rpmMax) * this.segs.length);
    this.segs.forEach((s, i) => s.classList.toggle('lit', i < lit));
    this.gearText.textContent = gear === -1 ? 'R' : gear === 0 ? 'N' : gear;
    this.modeText.textContent = mt ? 'MT' : 'AT';
    this.root.querySelector('#h-speedo').classList.toggle('redzone', rpm > this.rpmMax * 0.9);
  }

  setUnit(u) { if (this.unitText.textContent !== u) this.unitText.textContent = u; }

  /** live drift chain (pts) or a banked flash (bank text); total shows the run's drift score */
  drift(pts, mult, bank, total) {
    const el = this.$('h-drift');
    if (bank != null) {
      if (!bank) { el.classList.remove('live', 'bank'); return; }
      this.$('h-dp').textContent = bank;
      this.$('h-dm').textContent = 'DRIFT BANKED';
      el.classList.remove('live', 'bank');
      void el.offsetWidth;
      el.classList.add('bank');
      return;
    }
    if (pts == null) { el.classList.remove('live'); } else {
      el.classList.remove('bank');
      el.classList.add('live');
      this.$('h-dp').textContent = pts.toLocaleString();
      this.$('h-dm').textContent = mult > 1 ? `DRIFT  ×${mult}` : 'DRIFT';
    }
    if (total != null) { const t = this.$('h-total'); const txt = total > 0 ? `DRIFT SCORE ${total.toLocaleString()}` : ''; if (t.textContent !== txt) t.textContent = txt; }
  }

  setMode(text) { this.$('h-mode').textContent = text; }
  setTime(ms, label) { this.$('h-time').textContent = label ?? fmtTime(ms); }
  setLap(text) { this.$('h-lap').textContent = text; }
  setBest(ms, last) {
    this.$('h-best').textContent = ms != null ? `  BEST ${fmtTime(ms)}` : '';
    this.$('h-last').textContent = last != null ? `LAST ${fmtTime(last)}` : '';
  }
  setView(name) {
    const v = this.$('h-view');
    v.textContent = `視角：${name}`;
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }
  /** progress 0..1 shows the hold-to-start bar; null hides it */
  hold(progress, text, noBar = false) {
    const e = this.$('h-hold');
    if (progress == null) { e.classList.remove('on'); return; }
    e.classList.add('on');
    e.classList.toggle('nobar', noBar);
    this.$('h-hold-t').textContent = text;
    this.$('h-hold-b').style.width = `${Math.min(1, progress) * 100}%`;
  }
  warn(on) { this.$('h-warn').classList.toggle('on', on); }

  msg(text, cls = '', ms = 1200) {
    const m = this.$('h-msg');
    m.className = 'hud-center show ' + cls;
    m.textContent = text;
    clearTimeout(this._mt);
    if (ms) this._mt = setTimeout(() => m.classList.remove('show'), ms);
  }

  board(rows, selfId) {
    const key = JSON.stringify(rows) + selfId;
    if (key === this.lastBoard) return;
    this.lastBoard = key;
    this.$('h-board').innerHTML = rows.length
      ? `<table>${rows.map((r, i) => `<tr class="${r.id === selfId ? 'me' : ''}"><td class="pos">${i + 1}</td><td class="nm">${esc(r.name)}</td><td class="gp">${r.text}</td></tr>`).join('')}</table>`
      : '';
  }

  /** minimap: track polyline + car dots */
  drawMap(track, bounds, dots) {
    const c = this.map;
    const W = 360;
    c.clearRect(0, 0, W, W);
    if (!track?.valid) return;
    const pad = 18;
    const sx = (W - pad * 2) / (bounds.max.x - bounds.min.x);
    const sz = (W - pad * 2) / (bounds.max.z - bounds.min.z);
    const k = Math.min(sx, sz);
    const ox = pad + ((W - pad * 2) - (bounds.max.x - bounds.min.x) * k) / 2;
    const oz = pad + ((W - pad * 2) - (bounds.max.z - bounds.min.z) * k) / 2;
    const P = (x, z) => [ox + (x - bounds.min.x) * k, oz + (z - bounds.min.z) * k];
    c.lineJoin = c.lineCap = 'round';
    c.beginPath();
    track.pts.forEach((p, i) => { const [x, y] = P(p.x, p.z); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    if (track.closed) c.closePath();
    c.strokeStyle = '#000b'; c.lineWidth = 12; c.stroke();
    c.strokeStyle = '#d7f4ff'; c.lineWidth = 6; c.stroke();
    for (const d of dots) {
      const [x, y] = P(d.x, d.z);
      c.fillStyle = d.me ? '#ff4d2d' : '#ffd23c';
      c.strokeStyle = '#000'; c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, d.me ? 9 : 6, 0, 7); c.fill(); c.stroke();
    }
  }
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
