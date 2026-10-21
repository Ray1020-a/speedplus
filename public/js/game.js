import * as THREE from 'three';
import { downloadModel, parseGLB } from './loader.js';
import { buildCar, seatDriver } from './carmodel.js';
import { makeCharacter } from './characters.js';
import { Track } from './track.js';
import { Vehicle } from './vehicle.js';
import { createEnvironment, createComposer, buildCollider } from './world.js';
import { fmtTime } from './api.js';
import { settings } from './settings.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
export const VIEWS = ['追尾 (近)', '追尾 (遠)', '引擎蓋', '駕駛座'];
const LAP_MODE_MS = 10 * 60 * 1000;
const STEP = 1 / 120;

export class Game {
  /**
   * opts: {renderer, hud, input, audio, quality, mode:'time'|'lap'|'multi', mt, map, car, character,
   *        laps, room, players:[{id,name,car,character}], carAssets:{id:asset}, charAssets:{id:asset}, onFinish, onPause, onExit}
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.03, 2500);
    this.view = 0;
    this.state = 'loading';
    this.remotes = new Map();
    this.clock = new THREE.Clock();
    this.acc = 0;
    this.camYaw = 0;
    this.camPos = new THREE.Vector3();
    this.shake = 0;
    this.rumbleT = 0;
    this.disposed = false;
    this.look = { yaw: 0, pitch: 0, idle: 0, drag: false };
    this.camOff = new THREE.Vector3();
    this.camReady = false;
    this.drift = { t: 0, pts: 0, total: 0, off: 0, best: 0 };
    this.res = 1; this.resCeil = 1; this.ft = 0; this.resT = 0;
    this.t = 0;
  }

  /* ------------------------------------------------------------ loading */
  async load(progress) {
    const mapCfg = this.map.config;
    const S = (this.S = mapCfg.carScale || 0.25);
    const jobs = [];
    const report = (label, i) => (p) => progress(label, i, p);
    const mapBuf = await downloadModel(this.map.url, (p, b, c) => progress(`地圖 ${this.map.name}`, 0, p, b, c));
    const carIds = [...new Set([this.car.id, ...(this.players || []).map((p) => p.car)])];
    const carScenes = {};
    for (let i = 0; i < carIds.length; i++) {
      const a = this.carAssets[carIds[i]];
      if (!a) continue;
      const buf = await downloadModel(a.url, (p, b, c) => progress(`賽車 ${a.name}`, 1 + i, p, b, c));
      jobs.push(parseGLB(buf).then((g) => (carScenes[a.id] = g.scene)));
    }
    progress('建立場景…', 99, 1);
    const mapGltf = await parseGLB(mapBuf);
    await Promise.all(jobs);
    this.carScenes = carScenes;

    // map
    this.mapRoot = mapGltf.scene;
    const hide = mapCfg.hide ? new RegExp(mapCfg.hide, 'i') : null;
    this.mapRoot.traverse((o) => {
      if (!o.isMesh) return;
      if (hide && (hide.test(o.name) || hide.test(o.parent?.name || ''))) { o.visible = false; return; }
      o.castShadow = this.quality !== 'low';
      o.receiveShadow = this.quality !== 'low';
      const m = o.material;
      if (m) { m.envMapIntensity = 0.5; if (m.map) m.map.anisotropy = 4; }
    });
    this.scene.add(this.mapRoot);
    const box = new THREE.Box3().setFromObject(this.mapRoot);
    this.bounds = { min: box.min.clone(), max: box.max.clone() };
    this.collider = buildCollider(this.mapRoot, mapCfg);
    this.scene.add(this.collider);
    this.env = createEnvironment(this.renderer, this.scene, this.quality, this.bounds, mapCfg);
    this.composer = createComposer(this.renderer, this.scene, this.camera, this.quality);

    // track
    this.track = new Track(mapCfg);
    this.buildTrackVisuals();

    // local car
    const carCfg = this.car.config;
    this.carCfg = carCfg;
    this.vehicle = new Vehicle(carCfg, S, mapCfg.maxSpeed || 160, this.collider);
    this.vehicle.mt = this.mt;
    this.vehicle.gear = this.mt ? 0 : 1;
    this.carGroup = this.makeCarObject(this.car.id, carCfg, this.character);
    this.scene.add(this.carGroup.root);
    this.driver = this.carGroup.driver;

    // spawn
    const idx = Math.max(0, (this.players || []).findIndex((p) => p.id === this.room?.id));
    this.spawn(idx);

    // remote players
    for (const p of this.players || []) if (p.id !== this.room?.id) this.addRemote(p);

    this.hud.setRedline(this.vehicle.redline);
    this.audio?.setListener?.(this.camera.position, new THREE.Vector3(0, 0, -1));
    this.setupAudio();
    const cv = this.renderer.domElement;
    cv.style.cursor = 'grab';
    this._pd = (e) => { if (e.button === 0) { this.look.drag = true; cv.style.cursor = 'grabbing'; } };
    this._pm = (e) => {
      if (!this.look.drag) return;
      this.look.yaw -= e.movementX * 0.006;
      this.look.pitch = clamp(this.look.pitch + e.movementY * 0.004, -0.5, 0.9);
      this.look.yaw = clamp(this.look.yaw, -Math.PI, Math.PI);
      this.look.idle = 0;
    };
    this._pu = () => { this.look.drag = false; cv.style.cursor = 'grab'; };
    cv.addEventListener('pointerdown', this._pd);
    addEventListener('pointermove', this._pm);
    addEventListener('pointerup', this._pu);
    addEventListener('pointercancel', this._pu);
    addEventListener('resize', (this._rs = () => this.resize()));
    document.addEventListener('visibilitychange', (this._vis = () => {
      if (document.hidden && this.mode !== 'multi' && !this.paused && (this.state === 'racing' || this.state === 'countdown')) this.onPause?.();
    }));
    this.basePR = this.renderer.getPixelRatio();
    this.resize();
    this.state = 'ready';
  }

  makeCarObject(carId, cfg, charAsset) {
    const src = this.carScenes[carId].clone(true);
    const group = buildCar(src, cfg);
    const root = new THREE.Group();
    root.add(group);
    root.scale.setScalar(this.S);
    root.rotation.order = 'YXZ';
    const ch = makeCharacter(charAsset?.config);
    seatDriver(group, ch, cfg);
    return { root, group, driver: ch };
  }

  addRemote(p) {
    if (!this.carScenes[p.car] || this.remotes.has(p.id)) return;
    const cfg = this.carAssets[p.car].config;
    const obj = this.makeCarObject(p.car, cfg, this.charAssets[p.character]);
    this.scene.add(obj.root);
    // name tag
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 34px system-ui'; g.textAlign = 'center';
    g.fillStyle = '#0008'; g.fillRect(0, 8, 256, 48);
    g.fillStyle = '#fff'; g.fillText(p.name, 128, 45);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    sp.scale.set(1.2, 0.3, 1);
    sp.position.y = 1.6 * this.S * 4;
    sp.renderOrder = 20;
    this.scene.add(sp);
    this.remotes.set(p.id, {
      info: p, obj, tag: sp, cfg,
      pos: new THREE.Vector3(), yaw: 0, tgt: { x: 0, y: 0, z: 0, yaw: 0, pit: 0, rol: 0, sp: 0, rpm: 3500 }, seen: false,
      progress: 0, finish: null, vel: new THREE.Vector3(), last: performance.now(), voice: null,
      hw: ((cfg.bodyBox?.[0] || 1.9) / 2) * this.S, hl: ((cfg.bodyBox?.[2] || 5.4) / 2) * this.S,
    });
  }
  removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.obj.root, r.tag);
    if (r.voice) this.audio.destroyEngine(r.voice);
    this.remotes.delete(id);
  }

  buildTrackVisuals() {
    const t = this.track;
    if (!t.valid) return;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,0.0)'; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(14, 52); g.lineTo(32, 20); g.lineTo(50, 52); g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pos = [], uv = [], idx = [];
    const step = 0.5;
    const half = t.width / 2;
    let vcount = 0;
    const ray = new THREE.Raycaster();
    ray.firstHitOnly = true;
    const groundY = (x, z) => {
      ray.set(new THREE.Vector3(x, this.bounds.min.y + 2.5, z), new THREE.Vector3(0, -1, 0));
      const h = ray.intersectObject(this.collider, false)[0];
      return h ? h.point.y + 0.012 : this.bounds.min.y;
    };
    const total = t.closed ? t.length : t.length;
    const lines = [];
    for (let s = 0; s <= total; s += step) {
      const p = t.at(s);
      const nx = -p.dz, nz = p.dx;
      // thin dashed centre-line of chevrons
      const w = Math.min(0.35, half);
      for (const side of [-1, 1]) {
        const x = p.x + nx * w * side, z = p.z + nz * w * side;
        pos.push(x, groundY(x, z), z);
        uv.push(side < 0 ? 0 : 1, s / (w * 2));
      }
      if (vcount) idx.push(vcount - 2, vcount - 1, vcount, vcount - 1, vcount + 1, vcount);
      vcount += 2;
      lines.push(p);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide, fog: false });
    this.guide = new THREE.Mesh(geo, mat);
    this.guide.renderOrder = 2;
    this.scene.add(this.guide);
    this.guideTex = tex;

    // start / finish gate
    const cfg = this.map.config;
    const gate = (g, finish) => {
      if (!g) return;
      const grp = new THREE.Group();
      const w = t.width * 1.3;
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 32;
      const x = cv.getContext('2d');
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#fff'; x.fillRect(i * 16, j * 16, 16, 16); }
      const ct = new THREE.CanvasTexture(cv);
      ct.colorSpace = THREE.SRGBColorSpace;
      const h = 1.5 * Math.max(this.S * 3, 0.5);
      const banner = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.06), new THREE.MeshStandardMaterial({ map: ct, emissive: 0x222222 }));
      banner.position.set(0, h, 0);
      const postMat = new THREE.MeshStandardMaterial({ color: finish ? 0xe02030 : 0x20c060, roughness: 0.4 });
      for (const sd of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, h, 10), postMat);
        p.position.set(sd * w / 2, h / 2, 0);
        grp.add(p);
      }
      const line = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.18), new THREE.MeshBasicMaterial({ map: ct, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      line.rotation.x = -Math.PI / 2;
      line.position.y = 0.01;
      grp.add(banner, line);
      grp.position.set(g.x, groundY(g.x, g.z) - 0.01, g.z);
      grp.rotation.y = g.yaw;
      this.scene.add(grp);
    };
    if (cfg.start) gate(cfg.start, false);
    if (!t.closed && cfg.finish) gate(cfg.finish, true);
  }

  setupAudio() {
    const a = this.audio;
    if (!a?.ctx) return;
    this.voice = a.createEngine(true, this.vehicle.redline);
    a.createAmbient();
    this.nextMuteCheck = 0;
  }

  /* ------------------------------------------------------------ spawn / reset */
  spawn(index = 0) {
    const t = this.track;
    const cfg = this.map.config;
    const v = this.vehicle;
    let x = cfg.start?.x ?? (this.bounds.min.x + this.bounds.max.x) / 2;
    let z = cfg.start?.z ?? (this.bounds.min.z + this.bounds.max.z) / 2;
    let yaw = cfg.start?.yaw ?? 0;
    if (t.valid && cfg.start && !cfg.start.manual) {
      const p = t.at(t.s0);
      yaw = Math.atan2(-p.dx, -p.dz);
      x = p.x; z = p.z;
    }
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const row = Math.floor(index / 2), col = index % 2 ? 1 : -1;
    const back = (2 + row * 1.4) * v.hl * 2 * 0.9;
    const lat = Math.min(t.width * 0.22, v.hw * 1.6) * (this.players?.length > 1 ? col : 0);
    x += -fx * back + rx * lat;
    z += -fz * back + rz * lat;
    v.reset(x, 0, z, yaw);
    const gy = v.groundAt(x, this.bounds.min.y + 1, z, 2.5);
    v.pos.y = gy ?? this.bounds.min.y;
    this.sAbs = t.valid ? t.project(x, z).s : 0;
    this.prevRel = t.valid ? t.rel(this.sAbs) : 0;
    this.P = 0;
    this.lapsDone = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.rel = this.prevRel;
    this.wrongWay = 0;
    this.camYaw = yaw;
    this.camReady = false;
    v.snap();
    this.endDrift(false);
    this.drift.total = 0;
  }

  resetToTrack() {
    const t = this.track, v = this.vehicle;
    this.look.yaw = this.look.pitch = 0;
    if (!t.valid) return this.spawn(0);
    const p = t.at(this.sAbs);
    const yaw = Math.atan2(-p.dx, -p.dz);
    v.reset(p.x, v.pos.y, p.z, yaw);
    const gy = v.groundAt(p.x, v.pos.y, p.z, 1.5);
    if (gy != null) v.pos.y = gy;
    v.snap();
    this.camYaw = yaw;
    this.camReady = false;
    this.endDrift(false);
  }

  /* ------------------------------------------------------------ run */
  begin(countdownMs = 3500) {
    this.hud.root.classList.add('started');
    this.hud.hold(null);
    this.hud.setMode(this.mode === 'lap' ? '繞圈賽 · 10 分鐘' : this.mode === 'time' ? '計時賽' : `多人競速 · ${this.laps} 圈`);
    this.state = 'countdown';
    this.cdEnd = performance.now() + countdownMs;
    this.cdLast = 99;
    this.raceStart = 0;
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  restart() {
    this.removeAllHits();
    this.spawn(0);
    this.waitStart();
  }

  /** Grid is shown; the countdown only starts once the starter holds Space for 1.5 s. */
  waitStart() {
    this.state = 'waiting';
    this.hold = 0;
    this.hud.root.classList.remove('started');
    this.hud.setMode(this.mode === 'lap' ? '繞圈賽 · 10 分鐘' : this.mode === 'time' ? '計時賽' : `多人競速 · ${this.laps} 圈`);
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.frame());
  }
  removeAllHits() { this.vehicle.events.length = 0; }

  get totalLaps() { return this.laps; }

  frame() {
    if (this.disposed) return;
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    this.t += dt;
    this.adaptResolution(rawDt);
    this.input.speedF = clamp(this.vehicle.speedKmh / (this.vehicle.top * 3.6), 0, 1);
    const inp = this.input.read(dt);
    const ev = inp.ev;
    if (ev.view) { this.view = (this.view + 1) % VIEWS.length; this.hud.setView(VIEWS[this.view]); this.driver.setHeadVisible(this.view !== 3); }
    if (ev.mute) this.hud.msg(this.audio.toggleMute() ? '靜音' : '音效開啟', '', 800);
    if (ev.pause) this.onPause?.();
    if (ev.reset && (this.state === 'racing' || this.state === 'finished')) this.resetToTrack();

    const now = performance.now();
    const paused = this.paused && this.mode !== 'multi';
    if (this.state === 'waiting') {
      const v = this.vehicle;
      v.rpm += (v.idle - v.rpm) * Math.min(1, dt * 4);
      if (this.canStart) {
        const held = this.input.keys.has('Space') || this.input.touch.hold;
        this.hold = held ? this.hold + dt : Math.max(0, this.hold - dt * 2);
        this.hud.hold(this.hold / 1.5, this.waitText?.() || '長按 空白鍵 1.5 秒開始');
        if (this.hold >= 1.5) { this.hold = 0; this.hud.hold(null); this.onStartRequest?.(); }
      } else this.hud.hold(0, '等待主辦人開始…', true);
    } else if (this.state === 'countdown') {
      const left = this.cdEnd - now;
      const n = Math.ceil(left / 1000);
      if (n !== this.cdLast && n <= 3 && n > 0) { this.cdLast = n; this.hud.msg(String(n), 'big', 900); this.audio?.beep(520, 0.15); }
      const v = this.vehicle;
      v.rpm += (v.idle + inp.throttle * (v.redline - v.idle) * 0.9 - v.rpm) * Math.min(1, dt * 6);
      if (left <= 0) {
        this.state = 'racing';
        this.raceStart = now;
        this.lapStart = 0;
        this.hud.msg('GO!', 'go', 900);
        this.audio?.beep(1040, 0.4, 0.3);
        this.onGo?.();
      }
    } else if (this.state === 'racing' || this.state === 'finished') {
      if (!paused) {
        this.acc += dt;
        let n = 0;
        const control = this.state === 'finished' ? { throttle: 0, brake: 0.3, steer: 0, handbrake: false } : inp;
        if (this.state === 'finished') control.brake = this.vehicle.speedKmh > 3 ? 0.6 : 0;
        while (this.acc >= STEP && n++ < 6) {
          this.vehicle.snap();
          this.vehicle.update(STEP, { ...control, shiftUp: n === 1 && inp.shiftUp, shiftDown: n === 1 && inp.shiftDown });
          this.acc -= STEP;
          this.collideRemotes();
        }
        if (n >= 6) this.acc = 0;
        this.updateProgress(now);
        this.updateDrift(dt);
      }
    }
    this.vehicle.render(this.state === 'racing' || this.state === 'finished' ? clamp(this.acc / STEP, 0, 1) : 1);
    this.updateRemotes(dt, now);
    this.updateVisuals(dt, inp);
    this.updateEffects(dt, inp);
    this.updateHud(now);
    if (this.mode === 'multi') this.netTick(now);
    this.render();
    if (settings.debug) this.debugStats(rawDt);
  }

  /* ------------------------------------------------------------ progress / race rules */
  /**
   * P = unwrapped distance driven along the centre line (starts at 0 on the grid). A lap is counted each
   * time P passes a multiple of the track length, so jitter around the start line cannot add or remove laps.
   */
  updateProgress(now) {
    const t = this.track, v = this.vehicle;
    if (!t.valid) return;
    const p = t.project(v.pos.x, v.pos.z, this.sAbs, Math.max(4, t.width * 2.5));
    this.sAbs = p.s;
    const rel = t.rel(p.s);
    const L = t.length;
    const elapsed = now - this.raceStart;
    if (t.closed) {
      let d = rel - this.prevRel;
      if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
      this.P += d;
      const laps = Math.floor(this.P / L);
      if (laps > this.lapsDone && this.state === 'racing') this.lapDone(elapsed, laps);
    } else {
      // point-to-point: each run is a lap; the car is carried back to the start line with its speed kept
      this.P = rel;
      if (this.state === 'racing' && rel >= t.sFinish) {
        this.lapDone(elapsed, this.lapsDone + 1);
        if (this.state === 'racing') this.wrapToStart();
      }
    }
    this.prevRel = rel;
    this.rel = t.closed ? ((this.P % L) + L) % L : rel;
    this.progress = t.closed ? this.P : this.lapsDone * t.sFinish + rel;
    // wrong way
    const tan = t.at(p.s);
    const along = v.vel.x * tan.dx + v.vel.z * tan.dz;
    this.wrongWay = along < -2 * this.S ? this.wrongWay + 1 / 60 : Math.max(0, this.wrongWay - 0.05);
    // lap-mode clock
    if (this.mode === 'lap' && this.state === 'racing' && elapsed >= LAP_MODE_MS) this.finishRace(LAP_MODE_MS);
  }

  wrapToStart() {
    const t = this.track, v = this.vehicle;
    const sp = v.vel.length();
    const p = t.at(t.s0);
    const yaw = Math.atan2(-p.dx, -p.dz);
    v.pos.set(p.x, v.pos.y, p.z);
    v.yaw = yaw;
    v.vel.set(-Math.sin(yaw) * sp, 0, -Math.cos(yaw) * sp);
    const gy = v.groundAt(p.x, v.pos.y, p.z, 1.5);
    if (gy != null) v.pos.y = gy;
    this.sAbs = t.s0;
    this.prevRel = 0;
    this.camYaw = yaw;
    this.camReady = false;
    v.snap();
  }

  lapDone(elapsed, laps) {
    this.lapsDone = laps;
    const lt = elapsed - this.lapStart;
    this.lapStart = elapsed;
    const prevBest = this.lapTimes.length ? Math.min(...this.lapTimes) : null;
    this.lapTimes.push(lt);
    const best = Math.min(...this.lapTimes);
    const delta = prevBest != null ? `  ${lt <= prevBest ? '-' : '+'}${(Math.abs(lt - prevBest) / 1000).toFixed(3)}` : '';
    this.hud.msg(lt === best ? `LAP ${laps}  ${fmtTime(lt)}${delta}  BEST!` : `LAP ${laps}  ${fmtTime(lt)}${delta}`, lt === best ? 'good' : '', 2200);
    this.audio?.beep(880, 0.2);
    if (this.mode !== 'lap' && laps >= this.totalLaps) this.finishRace(elapsed);
  }

  finishRace(elapsed) {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.finishMs = elapsed;
    this.endDrift(true);
    const L = this.track.length;
    const bestLap = this.lapTimes.length ? Math.min(...this.lapTimes) : null;
    const partial = this.track.closed ? clamp(this.rel / L, 0, 0.999) : clamp(this.rel / (this.track.sFinish || 1), 0, 0.999);
    const laps = this.lapsDone;
    const result = {
      mode: this.mode, ms: elapsed, laps, score: this.mode === 'lap' ? laps + partial : elapsed, bestLap,
      drift: this.drift.total, driftBest: this.drift.best, hits: this.hits || 0,
    };
    this.audio?.beep(1200, 0.5, 0.3);
    this.hud.msg('FINISH', 'go', 2500);
    if (this.mode === 'multi') {
      this.room.broadcast({ t: 'fin', ms: elapsed, bestLap });
      this.finishes.set(this.room.id, { ms: elapsed });
      this.firstFinish ??= performance.now();
    } else setTimeout(() => !this.disposed && this.onFinish?.(result), 1800);
  }

  /* ------------------------------------------------------------ multiplayer */
  initNet() {
    this.finishes = new Map();
    this.sendT = 0;
    this.room.on.peerClose = (id) => { this.removeRemote(id); };
  }

  onNet(id, m) {
    const r = this.remotes.get(id);
    if (!r) return;
    if (m.t === 's') {
      const t = r.tgt;
      t.x = m.x; t.y = m.y; t.z = m.z; t.yaw = m.yaw; t.pit = m.pit; t.rol = m.rol; t.sp = m.sp; t.rpm = m.rpm;
      r.progress = m.p;
      r.last = performance.now();
      if (!r.seen) { r.seen = true; r.pos.set(m.x, m.y, m.z); r.yaw = m.yaw; }
    } else if (m.t === 'fin') {
      r.finish = m.ms;
      this.finishes.set(id, { ms: m.ms });
      this.firstFinish ??= performance.now();
    }
  }

  netTick(now) {
    if (now - this.sendT > 50) {
      this.sendT = now;
      const v = this.vehicle;
      const f = (n) => +n.toFixed(3);
      this.room.broadcast({ t: 's', x: f(v.pos.x), y: f(v.pos.y), z: f(v.pos.z), yaw: f(v.yaw), pit: f(v.pitch), rol: f(v.roll), sp: Math.round(v.speedKmh), rpm: Math.round(v.rpm), p: f(this.progress ?? 0) }, false);
    }
    // end of race: everybody finished, or 45s after the first finisher
    const alive = [...this.remotes.values()].filter((r) => performance.now() - r.last < 8000);
    const allDone = this.finishes.has(this.room.id) && alive.every((r) => r.finish != null);
    if (!this.ended && this.firstFinish && (allDone || now - this.firstFinish > 45000)) {
      this.ended = true;
      this.onFinish?.({ mode: 'multi', rows: this.standings(true), me: this.room.id });
    }
  }

  standings(final = false) {
    const rows = [{ id: this.room.id, name: this.myName, progress: this.progress ?? 0, fin: this.finishes.get(this.room.id)?.ms ?? null }];
    for (const r of this.remotes.values()) rows.push({ id: r.info.id, name: r.info.name, progress: r.progress, fin: r.finish });
    rows.sort((a, b) => (a.fin != null && b.fin != null ? a.fin - b.fin : a.fin != null ? -1 : b.fin != null ? 1 : b.progress - a.progress));
    return rows.map((r) => ({ ...r, text: r.fin != null ? fmtTime(r.fin) : final ? 'DNF' : this.gapText(r) }));
  }
  gapText(r) {
    const L = (this.track.closed ? this.track.length : this.track.sFinish) || 1;
    const lap = clamp(Math.floor(r.progress / L) + 1, 1, this.laps);
    return `${lap}/${this.laps}`;
  }

  updateRemotes(dt, now) {
    const near = [];
    for (const r of this.remotes.values()) {
      const t = r.tgt;
      if (!r.seen) { r.obj.root.visible = false; r.tag.visible = false; continue; }
      r.obj.root.visible = r.tag.visible = true;
      const k = Math.min(1, dt * 14);
      const age = Math.min(0.15, (now - r.last) / 1000);
      const ahead = (t.sp / 3.6) * this.S * age;
      const tx = t.x - Math.sin(t.yaw) * ahead, tz = t.z - Math.cos(t.yaw) * ahead;
      r.pos.x += (tx - r.pos.x) * k; r.pos.y += (t.y - r.pos.y) * k; r.pos.z += (tz - r.pos.z) * k;
      r.yaw = lerpAngle(r.yaw, t.yaw, k);
      r.obj.root.position.copy(r.pos);
      r.obj.root.rotation.set(t.pit, r.yaw, t.rol);
      r.tag.position.set(r.pos.x, r.pos.y + 0.9 * (this.S * 4 + 0.2) * 0.6 + 0.35, r.pos.z);
      const d = r.pos.distanceTo(this.vehicle.pos);
      r.dist = d;
      near.push(r);
    }
    if (this.audio?.ctx) {
      near.sort((a, b) => a.dist - b.dist);
      near.forEach((r, i) => {
        if (i < 3 && !r.voice) r.voice = this.audio.createEngine(false, r.cfg.redline || 12000);
        if (i >= 3 && r.voice) { this.audio.destroyEngine(r.voice); r.voice = null; }
        if (r.voice) {
          r.voice.panner.positionX.value = r.pos.x; r.voice.panner.positionY.value = r.pos.y; r.voice.panner.positionZ.value = r.pos.z;
          this.audio.updateEngine(r.voice, r.tgt.rpm, 0.7, false, false);
        }
      });
    }
  }

  collideRemotes() {
    if (!this.remotes.size) return;
    const v = this.vehicle;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const mine = [[v.pos.x + fx * v.hl * 0.55, v.pos.z + fz * v.hl * 0.55], [v.pos.x - fx * v.hl * 0.55, v.pos.z - fz * v.hl * 0.55]];
    const rad = v.hw * 1.05;
    for (const r of this.remotes.values()) {
      if (!r.seen || r.pos.distanceTo(v.pos) > (v.hl + r.hl) * 1.5) continue;
      const rfx = -Math.sin(r.yaw), rfz = -Math.cos(r.yaw);
      const theirs = [[r.pos.x + rfx * r.hl * 0.55, r.pos.z + rfz * r.hl * 0.55], [r.pos.x - rfx * r.hl * 0.55, r.pos.z - rfz * r.hl * 0.55]];
      for (const a of mine) for (const b of theirs) {
        const dx = a[0] - b[0], dz = a[1] - b[1];
        const d = Math.hypot(dx, dz), min = rad + r.hw * 1.05;
        if (d < min && d > 1e-5) {
          const pen = (min - d) * 0.5;
          v.pos.x += (dx / d) * pen; v.pos.z += (dz / d) * pen;
          const into = -(v.vel.x * dx + v.vel.z * dz) / d;
          if (into > 0) { v.vel.x += (dx / d) * into * 1.2; v.vel.z += (dz / d) * into * 1.2; if (into > 0.1) v.events.push({ type: 'hit', power: clamp(into / this.S / 30, 0, 0.8) }); }
        }
      }
    }
  }

  /* ------------------------------------------------------------ visuals */
  updateVisuals(dt, inp) {
    const v = this.vehicle;
    const g = this.carGroup.root;
    g.position.copy(v.rPos);
    // body motion eases toward its target so weight transfer feels soft instead of twitchy
    const kb = 1 - Math.exp(-dt * 9);
    this.bodyRoll = (this.bodyRoll || 0) + (clamp(-v.latAccel * 0.0035, -0.06, 0.06) - (this.bodyRoll || 0)) * kb;
    this.bodyPitch = (this.bodyPitch || 0) + (clamp(-v.longAccel * 0.0025, -0.04, 0.04) - (this.bodyPitch || 0)) * kb;
    g.rotation.set(v.rPitch + this.bodyPitch, v.rYaw, v.rRoll + this.bodyRoll);

    // steering arms follow input a little
    this.driver.group.rotation.z = (this.carCfg.seat.rot[2] * Math.PI) / 180 + inp.steer * 0.05;

    this.updateCamera(dt);
    if (this.guideTex) this.guideTex.offset.y = -((performance.now() / 1000) * 0.8) % 1;
  }

  updateCamera(dt) {
    const v = this.vehicle, cam = this.camera;
    const L = this.look;
    if (!L.drag) { L.idle += dt; if (L.idle > 1.5) { const k = Math.exp(-dt * 3); L.yaw *= k; L.pitch *= k; } }
    const S = this.S;
    const pos = v.rPos;
    const speedF = clamp(v.speedKmh / (v.top * 3.6), 0, 1);
    const sk = Math.max(S, 0.1) * 4;
    // smooth shake (no per-frame random): hits + a faint speed buzz
    const amp = settings.shake ? (this.shake * 0.012 + speedF ** 3 * 0.003) * sk : 0;
    const t = this.t;
    const nx = (Math.sin(t * 61.3) + 0.7 * Math.sin(t * 37.1 + 1)) * amp;
    const ny = (Math.sin(t * 53.7 + 2) + 0.7 * Math.sin(t * 29.3)) * amp;
    let fov = settings.fov + speedF * 20 + clamp(-v.longAccel * 0.12, -2, 3);
    if (this.view <= 1) {
      // follow the car's heading, but lean toward the direction of travel while sliding (Horizon-style drift cam)
      const moving = v.speedKmh > 8;
      const travel = moving ? Math.atan2(-v.vel.x, -v.vel.z) : v.rYaw;
      const slideW = moving && v.signedKmh > 0 ? clamp(Math.abs(v.slipAngle) * 1.4, 0, 0.55) : 0;
      const goal = lerpAngle(v.rYaw, travel, slideW);
      this.camYaw = lerpAngle(this.camYaw, goal, 1 - Math.exp(-dt * (moving ? 6 : 2.5)));
      const dist = (this.view === 0 ? 6.0 : 10.5) * S * (1 + speedF * 0.1);
      const height = (this.view === 0 ? 2.0 : 3.6) * S;
      const target = new THREE.Vector3(pos.x, pos.y + 0.7 * S, pos.z);
      const yawC = this.camYaw + L.yaw;
      const dir = new THREE.Vector3(Math.sin(yawC), 0, Math.cos(yawC)); // behind the car
      const want = new THREE.Vector3().addScaledVector(dir, dist * Math.cos(L.pitch));
      want.y += height + dist * Math.sin(L.pitch);
      // keep the camera inside the map
      const len = want.length();
      const hit = v.cast(target, want.clone().normalize(), len + 0.1);
      if (hit < len + 0.1) want.setLength(Math.max(0.15, hit - 0.12));
      // only the offset is smoothed, so the car never trails out of frame at speed
      if (!this.camReady) { this.camOff.copy(want); this.camReady = true; }
      else this.camOff.lerp(want, 1 - Math.exp(-dt * (hit < len ? 30 : 10)));
      cam.position.copy(target).add(this.camOff);
      cam.position.x += nx; cam.position.y += ny;
      cam.lookAt(target.x, target.y + 0.2 * S, target.z);
      cam.rotateZ(clamp(-v.yawRate * 0.012 * speedF, -0.04, 0.04));
    } else {
      const off = new THREE.Vector3().fromArray(this.view === 2 ? this.carCfg.hood : this.carCfg.cockpitEye).multiplyScalar(S);
      const root = this.carGroup.root;
      off.applyEuler(root.rotation);
      cam.position.copy(pos).add(off);
      const e = root.rotation;
      cam.rotation.set(e.x + (this.view === 3 ? 0 : -0.03) - L.pitch * 0.6 + ny * 0.4, e.y + L.yaw * 0.8 - v.steerAngle * 0.25 + nx * 0.4, e.z, 'YXZ');
      cam.position.x += nx * 0.5; cam.position.y += ny * 0.5;
      fov += this.view === 3 ? 12 : 4;
      this.camReady = false;
    }
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 5));
    cam.updateProjectionMatrix();
  }

  /** On-screen performance readout (settings → 效能資訊). */
  debugStats(rawDt) {
    const r = this.renderer;
    if (!this.dbg) {
      this.dbg = document.createElement('pre');
      this.dbg.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;padding:6px 8px;background:#000a;color:#7dffb0;font:11px/1.35 monospace;z-index:50;pointer-events:none;white-space:pre';
      document.body.append(this.dbg);
      r.info.autoReset = false;
      const gl = r.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a') + ` / WebGL${r.capabilities.isWebGL2 ? 2 : 1}`;
      this.dbgN = 0; this.dbgT = 0;
    }
    this.dbgN++; this.dbgT += rawDt;
    if (this.dbgT >= 0.5) {
      const i = r.info, fps = this.dbgN / this.dbgT;
      this.dbg.textContent = `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(1)} ms\ncalls ${i.render.calls}  tris ${(i.render.triangles / 1000).toFixed(0)}k\ngeo ${i.memory.geometries}  tex ${i.memory.textures}\nquality ${this.quality}  pr ${r.getPixelRatio().toFixed(2)}  res ${this.res.toFixed(2)}  post ${this.composer ? 'on' : 'off'}\n${this.gpu}`;
      this.dbgN = 0; this.dbgT = 0;
    }
    r.info.reset();
  }

  /** Lowers / raises the render resolution to hold the frame rate. */
  adaptResolution(rawDt) {
    if (!settings.dynRes || this.state === 'loading') return;
    this.ft = this.ft ? this.ft * 0.96 + rawDt * 0.04 : rawDt;
    const now = performance.now();
    if (now - this.resT < 1500 || rawDt > 0.25) return;
    let next = this.res;
    if (this.ft > 0.026 && this.res > 0.55) { next = this.res - 0.15; this.resCeil = Math.max(0.55, this.res - 0.05); }
    else if (this.ft < 0.0175 && this.res < this.resCeil) next = Math.min(this.resCeil, this.res + 0.1);
    this.resT = now;
    if (next === this.res) return;
    this.res = next;
    this.renderer.setPixelRatio(this.basePR * next);
    this.composer?.setPixelRatio?.(this.basePR * next);
    this.resize();
  }

  /* ------------------------------------------------------------ drift scoring */
  updateDrift(dt) {
    const v = this.vehicle, d = this.drift;
    if (this.state !== 'racing') return;
    if (v.drifting) {
      d.t += dt; d.off = 0;
      const mult = 1 + Math.min(4, Math.floor(d.t / 2));
      d.pts += dt * v.speedKmh * 0.9 * (0.6 + Math.min(1, Math.abs(v.slipAngle))) * mult;
      d.mult = mult;
    } else if (d.pts > 0) {
      d.off += dt;
      if (d.off > 0.9) this.endDrift(true);
    }
  }
  endDrift(bank) {
    const d = this.drift;
    if (bank && d.pts >= 50) {
      const pts = Math.round(d.pts);
      d.total += pts;
      d.best = Math.max(d.best, pts);
      this.hud.drift(null, 0, `+${pts.toLocaleString()}`);
      this.audio?.beep(1320, 0.12, 0.12);
    } else if (!bank && d.pts > 0) this.hud.drift(null, 0, '');
    d.t = 0; d.pts = 0; d.off = 0; d.mult = 1;
  }

  updateEffects(dt, inp) {
    const v = this.vehicle, a = this.audio;
    for (const e of v.events.splice(0)) {
      if (e.type === 'hit') {
        a?.hit(e.power);
        this.hits = (this.hits || 0) + 1;
        if (e.power > 0.15 && this.drift.pts > 0) this.endDrift(false);
        this.shake = Math.max(this.shake, e.power * 8);
        this.input.rumble(0.3 + e.power * 0.7, 0.4 + e.power * 0.6, 120 + e.power * 200);
        this.input.buzz(40 + e.power * 120);
      } else if (e.type === 'shift') a?.shift();
    }
    // turbo flutter / exhaust crackle when lifting off at high revs
    if (this._thr > 0.8 && inp.throttle < 0.1 && v.rpm > v.redline * 0.6 && v.speedKmh > 40) {
      a?.burst?.(900, 0.1, 0.16, 'bandpass');
      setTimeout(() => a?.burst?.(1400, 0.05, 0.1, 'bandpass'), 90);
    }
    this._thr = inp.throttle;
    this.shake = Math.max(0, this.shake - dt * 12);
    if (a?.ctx && this.voice) {
      a.updateEngine(this.voice, v.rpm, this.state === 'countdown' ? inp.throttle : inp.throttle, v.limiter, v.shiftTimer > 0);
      a.updateAmbient(v.speedKmh, v.skid);
      a.setListener(this.camera.position, new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion));
    }
    // rumble: engine vibration + redline + tyre slip (throttled)
    this.rumbleT -= dt;
    if (this.rumbleT <= 0 && this.state !== 'ready') {
      this.rumbleT = 0.09;
      const eng = (v.rpm / v.redline) * 0.15 * inp.throttle;
      const slip = v.skid * 0.5;
      const lim = v.limiter ? 0.5 : 0;
      if (eng + slip + lim > 0.02) this.input.rumble(slip * 0.8 + lim * 0.6, eng + slip * 0.5 + lim, 110);
    }
    if (this.composer) {
      const sp = clamp(v.speedKmh / Math.max(60, v.top * 3.6), 0, 1);
      this.composer.grade.uniforms.speed.value += (sp - this.composer.grade.uniforms.speed.value) * Math.min(1, dt * 4);
    }
  }

  updateHud(now) {
    const v = this.vehicle, hud = this.hud;
    const mph = settings.units === 'mph';
    hud.setUnit(mph ? 'mph' : 'km/h');
    hud.setDash(v.speedKmh * (mph ? 0.621371 : 1), v.rpm, v.gear, this.mt);
    const dr = this.drift;
    hud.drift(dr.pts > 0 && (v.drifting || dr.off < 0.9) ? Math.round(dr.pts) : null, dr.mult || 1, null, dr.total);
    const elapsed = this.state === 'countdown' ? 0 : this.state === 'finished' ? this.finishMs : now - this.raceStart;
    if (this.mode === 'lap') {
      hud.setTime(0, fmtTime(Math.max(0, LAP_MODE_MS - elapsed)));
      hud.setLap(`LAP ${this.lapsDone}  ·  ${Math.floor((this.track.closed ? this.rel / this.track.length : this.rel / this.track.sFinish) * 100)}%`);
    } else {
      hud.setTime(elapsed);
      hud.setLap(`LAP ${clamp(this.lapsDone + 1, 1, this.totalLaps)}/${this.totalLaps}`);
    }
    hud.setBest(this.lapTimes.length ? Math.min(...this.lapTimes) : null, this.lapTimes.at(-1) ?? null);
    hud.warn(this.wrongWay > 1.2 && this.state === 'racing');
    if (this.mode === 'multi') hud.board(this.standings(), this.room.id);
    // minimap (every few frames)
    if ((this._mm = (this._mm || 0) + 1) % 3 === 0) {
      const dots = [{ x: v.pos.x, z: v.pos.z, me: true }, ...[...this.remotes.values()].filter((r) => r.seen).map((r) => ({ x: r.pos.x, z: r.pos.z }))];
      hud.drawMap(this.track, this.bounds, dots);
    }
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------ teardown */
  dispose() {
    this.disposed = true;
    this.dbg?.remove();
    this.renderer.info.autoReset = true;
    this.renderer.setAnimationLoop(null);
    removeEventListener('resize', this._rs);
    document.removeEventListener('visibilitychange', this._vis);
    this.renderer.domElement.removeEventListener('pointerdown', this._pd);
    removeEventListener('pointermove', this._pm);
    removeEventListener('pointerup', this._pu);
    removeEventListener('pointercancel', this._pu);
    this.renderer.domElement.style.cursor = '';
    if (this.voice) this.audio.destroyEngine(this.voice);
    this.audio?.stopAll?.();
    for (const r of this.remotes.values()) if (r.voice) this.audio.destroyEngine(r.voice);
    this.scene.traverse((o) => {
      o.geometry?.disposeBoundsTree?.();
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) { for (const k in m) if (m[k]?.isTexture) m[k].dispose(); m.dispose(); }
    });
    this.composer?.dispose?.();
    this.scene.environment?.dispose?.();
  }
}
