/** WebAudio: synthesised V6-turbo-hybrid style engine, wind, tyres, impacts. An engine sample can replace the synth (cfg.sound.url). */
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = Number(localStorage.getItem('sp-vol') ?? 0.7);
    this.sample = null;
    this.voices = new Map();
  }

  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    this.noiseBuf = this.makeNoise();
    this.curve = this.makeCurve(3.5);
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

  /** engine voice: local = full detail, remote = cheap + spatial */
  createEngine(local, redline = 12000) {
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
    const voice = { out, panner, nodes: [], redline, local };
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.curve;
    shaper.oversample = '2x';
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    pre.connect(shaper).connect(lp).connect(out);
    voice.lp = lp;

    if (this.sample) {
      const src = ctx.createBufferSource();
      src.buffer = this.sample;
      src.loop = true;
      src.connect(out);
      src.start();
      voice.src = src;
      voice.sampleMode = true;
    } else {
      const mk = (type, g) => {
        const o = ctx.createOscillator();
        o.type = type;
        const gn = ctx.createGain();
        gn.gain.value = g;
        o.connect(gn).connect(pre);
        o.start();
        return o;
      };
      voice.o1 = mk('sawtooth', 0.5); // firing frequency
      voice.o2 = mk('square', 0.22); // 2nd order
      voice.o3 = mk('sawtooth', 0.28); // half order (V6 rumble)
      if (local) {
        voice.turbo = ctx.createOscillator();
        voice.turbo.type = 'sine';
        const tg = ctx.createGain();
        tg.gain.value = 0.02;
        voice.turbo.connect(tg).connect(out);
        voice.turbo.start();
        voice.turboGain = tg;
        // intake / mechanical hiss
        const n = this.noise();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2500;
        const ng = ctx.createGain();
        ng.gain.value = 0.03;
        n.connect(bp).connect(ng).connect(out);
        n.start();
        voice.hiss = ng;
      }
    }
    return voice;
  }

  updateEngine(v, rpm, throttle, limiter, shifting) {
    const t = this.ctx.currentTime;
    const f = (rpm / 60) * 3; // V6: 3 firings per revolution
    const k = 0.04;
    if (v.sampleMode) {
      v.src.playbackRate.setTargetAtTime(Math.max(0.3, rpm / (this.sampleRef || 8000)), t, k);
    } else {
      v.o1.frequency.setTargetAtTime(f, t, k);
      v.o2.frequency.setTargetAtTime(f * 2, t, k);
      v.o3.frequency.setTargetAtTime(f * 0.5, t, k);
    }
    const load = 0.35 + 0.65 * throttle;
    v.lp.frequency.setTargetAtTime(500 + (rpm / v.redline) * 5200 * (0.5 + 0.5 * throttle), t, 0.05);
    let g = (0.22 + 0.5 * load) * (0.55 + 0.45 * (rpm / v.redline));
    if (limiter) g *= 0.5 + 0.5 * Math.sign(Math.sin(t * 150)); // fuel-cut chatter
    if (shifting) g *= 0.25;
    v.out.gain.setTargetAtTime(g * (v.local ? 0.9 : 0.6), t, 0.03);
    if (v.turbo) {
      v.turbo.frequency.setTargetAtTime(2000 + rpm * 0.9, t, 0.08);
      v.turboGain.gain.setTargetAtTime(0.006 + throttle * 0.02, t, 0.1);
      v.hiss.gain.setTargetAtTime(0.01 + throttle * 0.05 * (rpm / v.redline), t, 0.1);
    }
  }

  destroyEngine(v) {
    try {
      v.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => {
        [v.o1, v.o2, v.o3, v.turbo, v.src].forEach((o) => { try { o?.stop(); } catch { /* already stopped */ } });
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
    this.wind.g.gain.setTargetAtTime(Math.min(0.35, (speedKmh / 300) ** 1.5 * 0.4), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(400 + speedKmh * 4, t, 0.1);
    this.skidNode.g.gain.setTargetAtTime(skid * 0.18 * Math.min(1, speedKmh / 40), t, 0.05);
    this.skidNode.f.frequency.setTargetAtTime(1200 + skid * 800, t, 0.1);
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
    this.burst(300 + 800 * power, 0.25 + 0.3 * power, 0.4 + 0.6 * power);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g.gain.setValueAtTime(0.6 * power + 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.35);
  }
  shift() { if (this.ctx) this.burst(2500, 0.07, 0.25, 'bandpass'); }
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
