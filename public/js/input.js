import { settings } from './settings.js';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const isTouchDevice = () =>
  (navigator.maxTouchPoints > 0 && matchMedia('(pointer:coarse)').matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export const KEYMAP = [
  ['加速', 'W / ↑'], ['煞車 / 倒車', 'S / ↓'], ['左轉', 'A / ←'], ['右轉', 'D / →'], ['手煞車 (甩尾)', 'Space'],
  ['升檔 (MT)', 'E / Shift'], ['降檔 (MT)', 'Q / Ctrl'], ['切換視角', 'C'], ['滑鼠拖曳：轉動視角', '左鍵按住'], ['復位 (回到賽道)', 'R'],
  ['暫停 / 選單', 'Esc / P'], ['靜音', 'M'], ['', ''],
];
export const PAD_MAP = [
  ['轉向', '左搖桿 / 十字鍵'], ['加速', 'RT'], ['煞車 / 倒車', 'LT'], ['手煞車', 'A'], ['升檔 / 降檔 (MT)', 'RB / LB'],
  ['轉動視角', '右搖桿'], ['切換視角', 'Y'], ['回到賽道', 'X'], ['暫停', 'Start'], ['力回饋', '碰撞、紅線、打滑時震動'],
];
export const WHEEL_MAP = [
  ['轉向', '方向盤'], ['加速', '油門踏板'], ['煞車 / 倒車', '煞車踏板'], ['手煞車', '✕'], ['升檔 / 降檔 (MT)', '右 / 左撥片'],
  ['切換視角', '△'], ['回到賽道', '□'], ['暫停', 'OPTIONS'], ['選單', '十字鍵，✕ 確定，○ 返回'],
];

/** Racing wheels have no standard Gamepad mapping. Layout below is the Logitech G29 / G923 (PlayStation & PC) in Chromium. */
export const isWheel = (gp) => !!gp && gp.mapping !== 'standard' && /wheel|G29|G9\d\d/i.test(gp.id);
const WHEEL_BTN = { a: 0, x: 1, b: 2, y: 3, rb: 4, lb: 5, start: 9 }; // ✕ □ ○ △, right / left paddle, OPTIONS
const WHEEL_HAT = 9; // D-pad is a single POV axis
/** POV hat axis: -1 = up, then clockwise in steps of 2/7; anything past ±1 means released. */
function hat(v) {
  if (v == null || Math.abs(v) > 1.05) return {};
  const k = Math.round((v + 1) * 3.5) % 8;
  return { up: k === 7 || k <= 1, right: k >= 1 && k <= 3, down: k >= 3 && k <= 5, left: k >= 5 };
}

export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = { left: false, right: false, gas: false, brake: false, hand: false, hold: false };
    this.edge = { up: false, down: false, view: false, reset: false, pause: false, mute: false };
    this.steer = 0; // smoothed keyboard steering
    this.thr = 0; // smoothed keyboard throttle / brake
    this.brk = 0;
    this.speedF = 0; // 0..1, set by the game each frame (keyboard steering gets calmer at speed)
    this.pad = null;
    this.usingPad = false;
    this.enabled = true;
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', (e) => { this.pad = e.gamepad.index; this.onPad?.(true, e.gamepad.id, isWheel(e.gamepad)); });
    addEventListener('gamepaddisconnected', () => { this.pad = null; this.onPad?.(false); });
    this.padPrev = {};
    this.pedalSeen = new Set(); // some browsers report an untouched pedal as 0 (= half pressed) until it first moves
  }

  /** The controller in use: whichever was pressed last (a wheel can enumerate twice, or sit next to an Xbox pad). */
  getPad() {
    const pads = [...navigator.getGamepads()].filter(Boolean);
    for (const gp of pads) if (gp.index !== this.pad && gp.buttons.some((x) => x.pressed)) this.pad = gp.index;
    return pads.find((gp) => gp.index === this.pad) || pads[0] || null;
  }

  /** One controller frame in Xbox terms: lx/ly = left stick (0 on a wheel), steer, rt/lt 0..1, face buttons, D-pad. */
  padState(gp) {
    const b = (i) => !!gp.buttons[i]?.pressed;
    if (isWheel(gp)) {
      const pedal = (i) => {
        const v = gp.axes[i];
        if (v == null) return 0;
        if (v !== 0) this.pedalSeen.add(i);
        if (!this.pedalSeen.has(i)) return 0;
        const p = (1 - v) / 2; // released = 1, floored = -1
        return p < 0.03 ? 0 : p;
      };
      const raw = gp.axes[0] || 0;
      const d = hat(gp.axes[WHEEL_HAT]);
      const B = WHEEL_BTN;
      return {
        wheel: true, lx: 0, ly: 0, steer: Math.abs(raw) < 0.01 ? 0 : clamp((raw * 900) / settings.wheelLock, -1, 1),
        rt: pedal(settings.wheelAxes.throttle), lt: pedal(settings.wheelAxes.brake),
        a: b(B.a), b: b(B.b), x: b(B.x), y: b(B.y), lb: b(B.lb), rb: b(B.rb), start: b(B.start),
        up: !!d.up, down: !!d.down, left: !!d.left, right: !!d.right,
      };
    }
    const lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
    let steer = Math.hypot(lx, ly) < 0.1 ? 0 : lx; // radial dead zone
    steer = Math.sign(steer) * Math.pow(Math.abs(steer), 1.5) * (1 - 0.25 * this.speedF); // finer centre, calmer at speed
    return {
      wheel: false, lx, ly, rx: gp.axes[2] || 0, ry: gp.axes[3] || 0, steer, rt: gp.buttons[7]?.value || 0, lt: gp.buttons[6]?.value || 0,
      a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rb: b(5), start: b(9),
      up: b(12), down: b(13), left: b(14), right: b(15),
    };
  }

  onKey(e, down) {
    if (!this.enabled || e.target.matches?.('input,textarea,select')) return;
    const k = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
    if (down) {
      this.usingPad = false;
      if (e.repeat) return;
      if (k === 'KeyE' || k === 'ShiftLeft' || k === 'ShiftRight') this.edge.up = true;
      if (k === 'KeyQ' || k === 'ControlLeft' || k === 'ControlRight') this.edge.down = true;
      if (k === 'KeyC') this.edge.view = true;
      if (k === 'KeyR') this.edge.reset = true;
      if (k === 'Escape' || k === 'KeyP') this.edge.pause = true;
      if (k === 'KeyM') this.edge.mute = true;
      this.keys.add(k);
    } else this.keys.delete(k);
  }

  /** Poll once per frame. */
  read(dt) {
    const k = (...c) => c.some((x) => this.keys.has(x));
    let throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    let target = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    let hand = k('Space');
    if (this.touch.gas) throttle = 1;
    if (this.touch.brake) brake = 1;
    target += (this.touch.right ? 1 : 0) - (this.touch.left ? 1 : 0);
    if (this.touch.hand) hand = true;
    // keyboard / touch steering eases in, is gentler at speed, and snaps back faster when reversing direction
    const flip = target !== 0 && Math.sign(target) !== Math.sign(this.steer) && this.steer !== 0;
    const rate = target === 0 ? 7 + 4 * this.speedF : (5.4 - 2.6 * this.speedF) * (flip ? 1.8 : 1);
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    if (settings.throttleAssist) {
      this.thr += clamp(throttle - this.thr, -9 * dt, 6 * dt);
      this.brk += clamp(brake - this.brk, -12 * dt, 8 * dt);
      throttle = this.thr; brake = this.brk;
    }
    let steer = this.steer;

    // gamepad / wheel
    const gp = this.getPad();
    if (gp) {
      const p = this.padState(gp);
      const prev = this.padPrev;
      const edge = (n) => p[n] && !prev[n];
      let sx = p.steer;
      if (p.left) sx = -1;
      if (p.right) sx = 1;
      // a wheel never rests at exactly 0, so it needs a small threshold before it takes over from the keyboard
      if (Math.abs(sx) > (p.wheel ? 0.05 : 0) || p.rt > 0.05 || p.lt > 0.05 || p.a) this.usingPad = true;
      if (this.usingPad) {
        steer = sx;
        throttle = Math.max(throttle, p.rt);
        brake = Math.max(brake, p.lt);
        hand = hand || p.a;
      }
      if (edge('rb')) this.edge.up = true;
      if (edge('lb')) this.edge.down = true;
      if (edge('y')) this.edge.view = true;
      if (edge('x')) this.edge.reset = true;
      if (edge('start')) this.edge.pause = true;
      this.padPrev = p;
    }

    // right stick: look around (standard-mapped pads only; deadzone, then squared for fine control)
    let look = { x: 0, y: 0 };
    if (gp) {
      const q = this.padPrev;
      const mag = Math.hypot(q.rx || 0, q.ry || 0);
      if (mag > 0.15) {
        const s = ((mag - 0.15) / 0.85) ** 2 / mag;
        look = { x: q.rx * s, y: q.ry * s };
      }
    }
    const out = { look, throttle, brake, steer: clamp(steer, -1, 1), handbrake: hand, assist: settings.steerAssist, shiftUp: this.edge.up, shiftDown: this.edge.down };
    const ev = { ...this.edge };
    this.edge = { up: false, down: false, view: false, reset: false, pause: false, mute: false };
    return { ...out, ev };
  }

  /** Rumble: strong = low-frequency motor, weak = high-frequency. Works on Xbox pads in Chromium; silently ignored elsewhere. */
  rumble(strong, weak, ms = 80) {
    const act = this.getPad()?.vibrationActuator;
    if (act?.playEffect) {
      act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {});
    }
  }
  buzz(ms) { if (navigator.vibrate && !this.usingPad) navigator.vibrate(ms); }
}
