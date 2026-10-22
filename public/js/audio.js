/** WebAudio: synthesised engines (per-car profile), wind, tyres, impacts. A recording in /audio/engine.mp3 replaces the synth. */

/**
 * fires = firing pulses per crank revolution (cylinders / 2), tilt = how fast harmonics fall off (higher = darker),
 * half = half-order rumble, noise = exhaust breath, jitter = pitch wobble in cents, bright = filter opening, drive = saturation.
 */
export const PROFILES = {
  f1: { label: 'F1 V6 渦輪', fires: 3, tilt: 0.9, half: 0.1, noise: 0.16, jitter: 5, bright: 1, drive: 1.4, turbo: true },
  v8: { label: 'V8', fires: 4, tilt: 1.25, half: 0.45, noise: 0.22, jitter: 12, bright: 0.65, drive: 1.6 },
  i6: { label: '直列六缸 (跑車)', fires: 3, tilt: 1.1, half: 0.08, noise: 0.15, jitter: 7, bright: 0.75, drive: 1.3 },
  diesel: { label: '柴油 (公車 / 卡車)', fires: 3, tilt: 1, half: 0.3, noise: 0.45, jitter: 20, bright: 0.4, drive: 1.8 },
  electric: { label: '電動', electric: true },
};
/** Which profile a car uses. Every car used to be saved with type 'f1', so 'f1' only counts on an F1-like redline. */
export function engineProfile(cfg = {}) {
  const t = cfg.sound?.type, rl = cfg.redline || 12000;
  if (PROFILES[t] && (t !== 'f1' || rl >= 11000)) return t;
  return rl >= 11000 ? 'f1' : rl >= 5000 ? 'i6' : 'diesel';
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = Number(localStorage.getItem('sp-vol') ?? 0.7);
    this.sample = null;
    this.voices = new Map();
    this.sm = new WeakMap();
  }

  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(this.ctx.destination);
    this.noiseBuf = this.makeNoise();
    await this.ctx.resume();
    await this.loadSample('/audio/engine.mp3'); // optional real recording; synth is used when absent
  }

  makeNoise() {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  makeCurve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k); }
    return c;
  }
  noise(loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = loop;
    return s;
  }

  /**
   * Per-frame parameter smoothing done in JS. Calling setTargetAtTime every frame piles up automation
   * events, which WebKit (Safari / every iOS browser) never prunes, so the audio thread and main thread
   * slow down steadily after the race starts.
   */
  smooth(param, target, tc) {
    const now = this.ctx.currentTime;
    let st = this.sm.get(param);
    if (!st) { st = { v: target, t: now }; this.sm.set(param, st); }
    else {
      st.v += (target - st.v) * (1 - Math.exp(-Math.max(0, now - st.t) / tc));
      st.t = now;
    }
    param.value = st.v;
  }

  setVolume(v) {
    this.volume = v;
    localStorage.setItem('sp-vol', v);
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  async loadSample(url) {
    if (!url) return;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      this.sample = await this.ctx.decodeAudioData(await r.arrayBuffer());
    } catch { /* fall back to synth */ }
  }

  /** engine voice for a car config: local = full detail, remote = cheap + spatial */
  createEngine(local, cfg = {}) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    let panner = null;
    if (local) out.connect(this.master);
    else {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 2;
      panner.rolloffFactor = 1.4;
      out.connect(panner).connect(this.master);
    }
    const type = engineProfile(cfg);
    const p = PROFILES[type];
    const voice = { out, panner, redline: cfg.redline || 12000, local, type, p, crackle: !p.electric && type !== 'diesel' };
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.connect(out);
    voice.lp = lp;

    if (this.sample) {
      const src = ctx.createBufferSource();
      src.buffer = this.sample;
      src.loop = true;
      src.connect(out);
      src.start();
      voice.src = src;
      voice.sampleMode = true;
      return voice;
    }
    const osc = (freq, wave, g, dest) => {
      const o = ctx.createOscillator();
      if (typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
      o.frequency.value = freq;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn).connect(dest);
      o.start();
      o.amp = gn;
      return o;
    };
    if (p.electric) {
      // motor whine + its 2nd harmonic, a low hum, and inverter hiss
      voice.o1 = osc(200, 'sine', 0.6, lp);
      voice.o2 = osc(400, 'sine', 0.18, lp);
      voice.o3 = osc(100, 'triangle', 0.25, lp);
      if (local) voice.hiss = this.noiseBand(out, 'highpass', 5000, 0.7);
      return voice;
    }
    // light saturation only: heavy clipping is what made the old synth buzzy and harsh
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.makeCurve(p.drive);
    shaper.oversample = '4x';
    const pre = ctx.createGain();
    pre.gain.value = 0.45;
    pre.connect(shaper).connect(lp);
    // firing order: band-limited harmonics (no aliasing fizz) + a half order for uneven, lumpy firing
    voice.o1 = osc(100, this.engineWave(type), 1, pre);
    voice.o3 = osc(50, 'triangle', p.half, pre);
    // cycle-to-cycle variation: slow noise wobbles the pitch by a few cents, so it never sounds like a pure tone
    const jn = this.noise();
    const jl = ctx.createBiquadFilter();
    jl.type = 'lowpass';
    jl.frequency.value = 18;
    const jg = ctx.createGain();
    jg.gain.value = p.jitter * 30; // ~18 Hz low-passed white noise is ~1/30 of full scale
    jn.connect(jl).connect(jg);
    jg.connect(voice.o1.detune);
    jg.connect(voice.o3.detune);
    jn.start();
    voice.jitter = jn;
    // exhaust: band-passed noise, pulsed by the firing frequency
    const xn = this.noise();
    const xb = ctx.createBiquadFilter();
    xb.type = 'bandpass';
    xb.Q.value = 0.9;
    const xg = ctx.createGain();
    xg.gain.value = 0;
    xn.connect(xb).connect(xg).connect(pre);
    const am = ctx.createGain();
    am.gain.value = 0;
    voice.o1.connect(am).connect(xg.gain);
    xn.start();
    Object.assign(voice, { xn, xb, xg, am });
    if (local && p.turbo) {
      voice.turbo = osc(2000, 'sine', 0, out);
      voice.turboGain = voice.turbo.amp;
      voice.hiss = this.noiseBand(out, 'bandpass', 2500, 1);
    }
    return voice;
  }

  noiseBand(dest, type, freq, q) {
    const n = this.noise();
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    n.connect(f).connect(g).connect(dest);
    n.start();
    g.src = n;
    return g;
  }

  /** one firing cycle as harmonics: amplitude falls as n^-tilt, phases fixed but scattered so the wave is not a spiky pulse */
  engineWave(type) {
    this.waves ||= {};
    if (this.waves[type]) return this.waves[type];
    const { tilt } = PROFILES[type];
    const N = 32, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 1; n <= N; n++) {
      const a = Math.pow(n, -tilt), ph = rnd() * Math.PI * 2;
      re[n] = a * Math.cos(ph);
      im[n] = a * Math.sin(ph);
    }
    return (this.waves[type] = this.ctx.createPeriodicWave(re, im));
  }

  updateEngine(v, rpm, throttle, limiter, shifting) {
    const t = this.ctx.currentTime;
    const p = v.p;
    const r = Math.min(1, rpm / v.redline);
    const k = 0.04;
    let g;
    if (v.sampleMode) {
      this.smooth(v.src.playbackRate, Math.max(0.3, rpm / (this.sampleRef || 8000)), k);
      this.smooth(v.lp.frequency, 500 + r * 5200 * (0.5 + 0.5 * throttle), 0.05);
      g = (0.22 + 0.5 * (0.35 + 0.65 * throttle)) * (0.55 + 0.45 * r);
    } else if (p.electric) {
      const fe = 60 + r * 2600;
      this.smooth(v.o1.frequency, fe, k);
      this.smooth(v.o2.frequency, fe * 2, k);
      this.smooth(v.o3.frequency, fe * 0.5, k);
      this.smooth(v.lp.frequency, 1500 + r * 6000, 0.05);
      if (v.hiss) this.smooth(v.hiss.gain, 0.004 + throttle * 0.012 * r, 0.1);
      g = (0.08 + 0.2 * throttle) * (0.3 + 0.7 * r);
    } else {
      const f = (rpm / 60) * p.fires;
      this.smooth(v.o1.frequency, f, k);
      this.smooth(v.o3.frequency, f * 0.5, k);
      this.smooth(v.xb.frequency, Math.min(4000, Math.max(90, f * 1.6)), k);
      const nz = p.noise * (0.25 + 0.75 * throttle) * (0.4 + 0.6 * r);
      this.smooth(v.xg.gain, nz, 0.05);
      this.smooth(v.am.gain, nz * 0.8, 0.05);
      // darker off-throttle and at low revs, opens up under load
      this.smooth(v.lp.frequency, 160 + p.bright * (600 + 4600 * r) * (0.45 + 0.55 * throttle), 0.05);
      g = (0.2 + 0.4 * throttle) * (0.55 + 0.45 * r);
    }
    if (limiter) g *= 0.75 + 0.25 * Math.sin(t * Math.PI * 2 * 18); // soft fuel-cut bounce, not a hard on/off click
    if (shifting) g *= 0.35;
    this.smooth(v.out.gain, g * (v.local ? 0.9 : 0.6), 0.03);
    if (v.turbo) {
      this.smooth(v.turbo.frequency, 2000 + rpm * 0.9, 0.08);
      this.smooth(v.turboGain.gain, 0.003 + throttle * 0.01 * r, 0.1);
      this.smooth(v.hiss.gain, 0.005 + throttle * 0.03 * r, 0.1);
    }
  }

  destroyEngine(v) {
    try {
      v.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => {
        [v.o1, v.o2, v.o3, v.turbo, v.src, v.jitter, v.xn, v.hiss?.src].forEach((o) => { try { o?.stop(); } catch { /* already stopped */ } });
        v.out.disconnect();
      }, 300);
    } catch { /* ignore */ }
  }

  /* continuous environment sounds for the local car */
  createAmbient() {
    const ctx = this.ctx;
    const mkBand = (type, freq, q) => {
      const n = this.noise();
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      n.connect(f).connect(g).connect(this.master);
      n.start();
      return { f, g };
    };
    this.wind = mkBand('bandpass', 700, 0.6);
    this.skidNode = mkBand('bandpass', 1500, 4);
  }
  updateAmbient(speedKmh, skid) {
    if (!this.wind) return;
    const t = this.ctx.currentTime;
    this.smooth(this.wind.g.gain, Math.min(0.2, (speedKmh / 300) ** 1.5 * 0.25), 0.1);
    this.smooth(this.wind.f.frequency, 400 + speedKmh * 4, 0.1);
    this.smooth(this.skidNode.g.gain, skid * 0.18 * Math.min(1, speedKmh / 40), 0.05);
    this.smooth(this.skidNode.f.frequency, 1200 + skid * 800, 0.1);
  }

  burst(freq, dur, gain, type = 'lowpass') {
    const ctx = this.ctx;
    const n = this.noise(false);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(this.master);
    n.start(t);
    n.stop(t + dur + 0.05);
  }
  hit(power) {
    if (!this.ctx) return;
    this.burst(300 + 800 * power, 0.15 + 0.3 * power, 0.1 + 0.5 * power); // light scrapes stay quiet
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g.gain.setValueAtTime(0.5 * power + 0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.35);
  }
  /** soft UI click */
  tick() { if (this.ctx && this.ctx.state === 'running') this.beep(1180, 0.05, 0.07); }
  /** mute engine/wind while the game is paused */
  pause(on) { if (this.ctx) this.master.gain.setTargetAtTime(on ? this.volume * 0.12 : this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05); }
  shift() { if (this.ctx) this.burst(1600, 0.05, 0.1, 'bandpass'); }
  beep(freq, dur = 0.18, gain = 0.25) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  setListener(pos, fwd) {
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0); }
  }

  stopAll() {
    this.wind?.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.skidNode?.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }
}
