const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const isTouchDevice = () =>
  (navigator.maxTouchPoints > 0 && matchMedia('(pointer:coarse)').matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export const KEYMAP = [
  ['加速', 'W / ↑'], ['煞車 / 倒車', 'S / ↓'], ['左轉', 'A / ←'], ['右轉', 'D / →'], ['手煞車 (甩尾)', 'Space'],
  ['升檔 (MT)', 'E / Shift'], ['降檔 (MT)', 'Q / Ctrl'], ['切換視角', 'C'], ['回到賽道 (重置)', 'R'],
  ['暫停 / 選單', 'Esc / P'], ['靜音', 'M'], ['', ''],
];
export const PAD_MAP = [
  ['轉向', '左搖桿 / 十字鍵'], ['加速', 'RT'], ['煞車 / 倒車', 'LT'], ['手煞車', 'A'], ['升檔 / 降檔 (MT)', 'RB / LB'],
  ['切換視角', 'Y'], ['回到賽道', 'X'], ['暫停', 'Start'], ['力回饋', '碰撞、紅線、打滑時震動'],
];

export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = { left: false, right: false, gas: false, brake: false, hand: false };
    this.edge = { up: false, down: false, view: false, reset: false, pause: false, mute: false };
    this.steer = 0; // smoothed keyboard steering
    this.pad = null;
    this.usingPad = false;
    this.enabled = true;
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', (e) => { this.pad = e.gamepad.index; this.onPad?.(true, e.gamepad.id); });
    addEventListener('gamepaddisconnected', () => { this.pad = null; this.onPad?.(false); });
    this.padPrev = [];
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
    // keyboard / touch steering eases in and returns to centre
    const rate = target === 0 ? 6 : 4.5;
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);
    let steer = this.steer;

    // gamepad
    const gp = this.pad != null ? navigator.getGamepads()[this.pad] : null;
    if (gp) {
      const prev = this.padPrev;
      const b = (i) => gp.buttons[i]?.pressed;
      const edge = (i) => b(i) && !prev[i];
      let sx = gp.axes[0] || 0;
      if (Math.abs(sx) < 0.08) sx = 0;
      sx = Math.sign(sx) * Math.pow(Math.abs(sx), 1.3);
      if (b(14)) sx = -1;
      if (b(15)) sx = 1;
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (Math.abs(sx) > 0 || rt > 0.05 || lt > 0.05 || b(0)) this.usingPad = true;
      if (this.usingPad) {
        steer = sx || steer;
        throttle = Math.max(throttle, rt);
        brake = Math.max(brake, lt);
        hand = hand || b(0);
      }
      if (edge(5)) this.edge.up = true;
      if (edge(4)) this.edge.down = true;
      if (edge(3)) this.edge.view = true;
      if (edge(2)) this.edge.reset = true;
      if (edge(9)) this.edge.pause = true;
      this.padPrev = gp.buttons.map((x) => x.pressed);
    }

    const out = { throttle, brake, steer: clamp(steer, -1, 1), handbrake: hand, shiftUp: this.edge.up, shiftDown: this.edge.down };
    const ev = { ...this.edge };
    this.edge = { up: false, down: false, view: false, reset: false, pause: false, mute: false };
    return { ...out, ev };
  }

  /** Rumble: strong = low-frequency motor, weak = high-frequency. Works on Xbox pads in Chromium; silently ignored elsewhere. */
  rumble(strong, weak, ms = 80) {
    const gp = this.pad != null ? navigator.getGamepads()[this.pad] : null;
    const act = gp?.vibrationActuator;
    if (act?.playEffect) {
      act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {});
    }
  }
  buzz(ms) { if (navigator.vibrate && !this.usingPad) navigator.vibrate(ms); }
}
