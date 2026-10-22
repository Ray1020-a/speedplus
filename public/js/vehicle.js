import * as THREE from 'three';

const G = 9.81;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const KMH = 3.6;

/**
 * Arcade car in "scaled world" units. All real-world numbers (speed, accel) are divided/multiplied by
 * `S` (car scale) at the boundary so physics feels like a real car while the map stays small.
 */
export class Vehicle {
  constructor(cfg, S, mapMaxKmh, collider) {
    this.cfg = cfg;
    this.S = S;
    this.collider = collider;
    const top = Math.min(cfg.topSpeed || 300, mapMaxKmh || 1e9) / KMH; // m/s (real)
    this.top = top;
    this.nGears = cfg.gearCount || 8;
    this.redline = cfg.redline || 12000;
    this.idle = Math.min(3500, this.redline * 0.3); // a bus / diesel redline (2500) sits below a petrol idle
    this.driftK = cfg.drift ?? (this.redline >= 11000 ? 0.4 : 1); // how easily the rear lets go; race cars sit on downforce
    const ratio = Math.pow(0.24, 1 / (this.nGears - 1));
    this.vmax = Array.from({ length: this.nGears + 1 }, (_, i) => (i === 0 ? 0 : top * Math.pow(ratio, this.nGears - i)));
    this.power = cfg.power || 1;
    const aTop = 3.4 * this.power;
    this.drag = aTop / (top * top);
    this.A1 = Math.min(13 * this.power, 16);
    this.wheelbase = 3.4;
    this.hw = ((cfg.bodyBox?.[0] || 1.9) / 2) * S;
    this.hl = ((cfg.bodyBox?.[2] || 5.4) / 2) * S;
    this.height = (cfg.bodyBox?.[1] || 1.0) * S;

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.vel = new THREE.Vector3();
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.steerAngle = 0;
    this.gear = 1; // -1 R, 0 N, 1..n
    this.mt = false;
    this.rpm = this.idle;
    this.shiftTimer = 0;
    this.limiter = false;
    this.skid = 0;
    this.airborne = 0;
    this.longAccel = 0;
    this.latAccel = 0;
    this.events = []; // {type:'hit', power}
    this.slipAngle = 0;
    this.drifting = false;
    // previous physics state, for render interpolation between fixed steps
    this.pPos = new THREE.Vector3();
    this.pYaw = 0;
    this.pPitch = 0;
    this.pRoll = 0;
    this.rPos = new THREE.Vector3();
    this.rYaw = 0;
    this.rPitch = 0;
    this.rRoll = 0;
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
  }

  reset(x, y, z, yaw) {
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.yawRate = 0;
    this.gear = 1;
    this.rpm = this.idle;
    this.pitch = this.roll = 0;
    this.steerAngle = 0;
    this.skid = 0;
    this.drifting = false;
    this.snap();
    this.render(1);
  }

  /** remember the state before a physics step */
  snap() {
    this.pPos.copy(this.pos);
    this.pYaw = this.yaw;
    this.pPitch = this.pitch;
    this.pRoll = this.roll;
  }

  /** blend previous and current state; alpha = fraction of a step not yet simulated */
  render(alpha) {
    this.rPos.lerpVectors(this.pPos, this.pos, alpha);
    let d = this.yaw - this.pYaw;
    d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
    this.rYaw = this.pYaw + d * alpha;
    this.rPitch = this.pPitch + (this.pitch - this.pPitch) * alpha;
    this.rRoll = this.pRoll + (this.roll - this.pRoll) * alpha;
  }

  get forward() { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  get speedKmh() { return Math.abs(this.vel.dot(this.forward)) / this.S * KMH; }
  get signedKmh() { return this.vel.dot(this.forward) / this.S * KMH; }
  /** AT reverse: the brake pedal drives backwards and the throttle brakes */
  get reversing() { return !this.mt && this.gear === -1; }

  /** returns distance to first hit or Infinity */
  cast(origin, dir, far) {
    if (!this.collider) return Infinity;
    this._ray.set(origin, dir);
    this._ray.near = 0;
    this._ray.far = far;
    const h = this._ray.intersectObject(this.collider, false)[0];
    return h ? h.distance : Infinity;
  }

  groundAt(x, y, z, step) {
    const d = this.cast(new THREE.Vector3(x, y + step, z), new THREE.Vector3(0, -1, 0), step + 3);
    return d === Infinity ? null : y + step - d;
  }

  update(dt, input) {
    const S = this.S;
    const fwd = this.forward;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    let vf = this.vel.dot(fwd) / S; // real m/s
    let vl = this.vel.dot(right) / S;

    /* ----- transmission ----- */
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const n = this.nGears;
    if (!this.mt) {
      if (this.gear <= 0 && this.gear !== -1) this.gear = 1;
      if (input.brake > 0.2 && vf < 0.3 && input.throttle < 0.1) this.gear = -1; // flip only near a standstill: until then the pedal still brakes
      else if (this.gear === -1 && input.throttle > 0.2 && vf > -0.3) this.gear = 1;
      if (this.gear > 0 && this.shiftTimer === 0) {
        const ratio = Math.abs(vf) / this.vmax[this.gear];
        if (ratio > (0.9 + 0.05 * input.throttle) && this.gear < n) { this.gear++; this.shiftTimer = 0.12; this.events.push({ type: 'shift' }); }
        else if (this.gear > 1 && Math.abs(vf) / this.vmax[this.gear - 1] < (0.55 + 0.2 * input.throttle)) { this.gear--; this.shiftTimer = 0.1; this.events.push({ type: 'shift' }); }
      }
    } else {
      if (input.shiftUp && this.gear < n) { this.gear++; this.shiftTimer = 0.1; this.events.push({ type: 'shift' }); }
      if (input.shiftDown && this.gear > -1) { this.gear--; this.shiftTimer = 0.1; this.events.push({ type: 'shift' }); }
    }

    const thr = this.reversing ? input.brake : input.throttle;
    const brk = this.reversing ? input.throttle : input.brake;

    /* ----- rpm ----- */
    const vmaxG = this.gear > 0 ? this.vmax[this.gear] : this.vmax[1];
    if (this.gear === 0) {
      this.rpm += ((this.idle + thr * (this.redline - this.idle)) - this.rpm) * Math.min(1, dt * 6);
    } else {
      const wheelRpm = this.idle + (this.redline - this.idle) * (Math.abs(vf) / vmaxG);
      const clutch = this.idle + thr * 0.5 * (this.redline - this.idle) * (1 - Math.min(1, Math.abs(vf) / (vmaxG * 0.5)));
      const target = Math.max(wheelRpm, clutch);
      this.rpm += (target - this.rpm) * Math.min(1, dt * 14);
    }
    this.limiter = this.rpm >= this.redline * 0.985 && thr > 0.5;
    this.rpm = clamp(this.rpm, this.idle * 0.8, this.redline);

    /* ----- longitudinal ----- */
    let a = 0;
    const tq = (r) => 0.62 + 0.38 * Math.sin(Math.PI * clamp((r - this.idle * 0.6) / (this.redline * 1.0 - this.idle * 0.6), 0, 1) ** 0.8);
    if (this.gear !== 0 && this.shiftTimer === 0) {
      const dirSign = this.gear === -1 ? -1 : 1;
      let thrust = thr * tq(this.rpm) * this.A1 * (this.vmax[1] / vmaxG);
      thrust = Math.min(thrust, 16 * this.power);
      if (this.gear === -1) thrust = Math.min(thrust, 5.5) * 1;
      const over = Math.abs(vf) / (this.gear > 0 ? vmaxG : Math.min(vmaxG, 8)); // reverse tops out near 30 km/h
      if (over > 1 || this.limiter) thrust = 0;
      if (this.gear > 0 && vf < -0.5) thrust = 0; // do not push backwards in forward gear
      a += thrust * dirSign;
      // engine braking when lifted / over-revved
      if (thr < 0.05 && this.gear > 0) a -= Math.sign(vf) * (0.6 + 2.2 * (Math.abs(vf) / vmaxG)) * Math.min(1, Math.abs(vf));
      if (over > 1) a -= Math.sign(vf) * (over - 1) * 60;
    }
    a -= this.drag * vf * Math.abs(vf);
    a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 0.25);
    const brake = brk * 26 + (input.handbrake ? 9 : 0);
    if (brake > 0 && Math.abs(vf) > 0.01) {
      a -= Math.sign(vf) * Math.min(brake, Math.abs(vf) / dt + 0);
    }
    const newVf = vf + a * dt;
    this.longAccel = a;
    // clamp so that braking never flips direction
    vf = (brake > 0 && Math.sign(newVf) !== Math.sign(vf) && Math.abs(vf) > 0) ? 0 : newVf;

    /* ----- lateral ----- */
    const speedAbs = Math.abs(vf);
    const maxSteer = 0.52 / (1 + (speedAbs / 24) ** 2) + 0.05;
    let target = input.steer * maxSteer;
    // counter-steer help: when the tail steps out, ease the front wheels toward the direction of travel
    const slipAng = Math.atan2(vl, Math.max(speedAbs, 3)) * Math.sign(vf || 1);
    if (input.assist && speedAbs > 8 && !input.handbrake) {
      target += clamp(slipAng * 0.9, -0.28, 0.28) * (input.steer === 0 ? 1 : 0.6);
    }
    this.steerAngle += (target - this.steerAngle) * Math.min(1, dt * (input.steer === 0 ? 10 : 8));
    let w = (vf * Math.tan(this.steerAngle)) / this.wheelbase;
    const grip = (2.4 + (speedAbs * speedAbs) * 0.0009) * G; // downforce grows with v^2
    const need = Math.abs(w * vf);
    let slide = 0;
    if (need > grip) { w *= grip / need; slide = clamp(need / grip - 1, 0, 1); }
    // the rear lets go and the car rotates past its path: handbrake locks it, full throttle at the limit spins it (power oversteer)
    const loose = input.handbrake ? 1 : thr > 0.6 && this.gear > 0 && speedAbs > 8 ? Math.min(1, slide * 2) * thr * this.driftK : 0;
    w *= 1 + (input.handbrake ? 0.3 * (0.5 + 0.5 * this.driftK) : 0.5 * loose);
    this.yawRate += (-w - this.yawRate) * Math.min(1, dt * 16);
    this.yaw += this.yawRate * dt;
    // the car's momentum stays put in the world while it yaws; tyre grip then drags it back toward the nose
    const f1 = this.forward;
    const r1 = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wx = fwd.x * vf + right.x * vl, wz = fwd.z * vf + right.z * vl;
    const sp0 = Math.hypot(vf, vl);
    vf = wx * f1.x + wz * f1.z;
    vl = wx * r1.x + wz * r1.z;
    const lateralGrip = input.handbrake ? 1.6 : (9 - 5 * slide) * (1 - 0.7 * loose);
    const vl0 = vl;
    vl *= Math.exp(-lateralGrip * dt);
    // grip redirects speed rather than deleting it; a little is scrubbed off by the sliding tyres
    if (vf > 0.5) vf = Math.sqrt(Math.max(0, sp0 * sp0 - vl * vl)) * (1 - Math.min(1, Math.abs(vl0) / 8) * 0.35 * dt);
    this.latAccel = vf * -this.yawRate;
    this.slipAngle = slipAng;
    this.drifting = speedAbs > 11 && Math.abs(slipAng) > 0.2 && this.airborne === 0;
    this.skid = clamp(Math.abs(vl) / 4 + slide * 0.7 + (input.handbrake ? speedAbs / 30 : 0) + (input.brake > 0.9 && speedAbs > 20 ? 0.4 : 0), 0, 1);

    /* ----- integrate (recompute axes after yaw change) ----- */
    const f2 = this.forward;
    const r2 = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.vel.set(0, 0, 0).addScaledVector(f2, vf * S).addScaledVector(r2, vl * S);
    this.pos.addScaledVector(this.vel, dt);

    this.collide();
    this.ground(dt);
  }

  collide() {
    if (!this.collider) return;
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const push = new THREE.Vector3();
    let worst = 0;
    const heights = [0.06 + this.height * 0.1, this.height * 0.75];
    const N = 16;
    for (let k = 0; k < N; k++) {
      const ang = (k / N) * Math.PI * 2;
      const lx = Math.sin(ang), lz = -Math.cos(ang); // local dir, -Z forward
      // car-local to world
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      dir.set(lx * c + lz * s, 0, -lx * s + lz * c);
      const edge = Math.min(this.hw / (Math.abs(lx) || 1e-6), this.hl / (Math.abs(lz) || 1e-6));
      for (const h of heights) {
        origin.set(this.pos.x, this.pos.y + h, this.pos.z);
        const d = this.cast(origin, dir, edge + 0.02);
        if (d < edge) {
          const pen = edge - d;
          push.addScaledVector(dir, -pen);
          worst = Math.max(worst, pen);
          const into = this.vel.dot(dir);
          if (into > 0) {
            if (into > 0.15) this.events.push({ type: 'hit', power: clamp(into / this.S / 25, 0, 1) });
            this.vel.addScaledVector(dir, -into * 1.15); // slight bounce
            this.vel.multiplyScalar(0.985);
          }
        }
      }
    }
    if (worst > 0) {
      if (push.length() > 0.5) push.setLength(0.5);
      this.pos.add(push);
      this.yawRate *= 0.9;
    }
  }

  ground(dt) {
    const S = this.S;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const pts = [[-this.hw * 0.8, -this.hl * 0.7], [this.hw * 0.8, -this.hl * 0.7], [-this.hw * 0.8, this.hl * 0.7], [this.hw * 0.8, this.hl * 0.7]]
      .map(([lx, lz]) => [this.pos.x + lx * c + lz * s, this.pos.z - lx * s + lz * c]);
    const step = 0.12 * Math.max(S, 0.4) + 0.05;
    const hs = pts.map(([x, z]) => this.groundAt(x, this.pos.y, z, step));
    const valid = hs.filter((h) => h != null);
    if (!valid.length) {
      this.airborne += dt;
      this.vel.y -= G * dt * S;
      this.pos.y += this.vel.y * dt;
      return;
    }
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    const h = hs.map((v) => (v == null ? avg : v));
    const front = (h[0] + h[1]) / 2, rear = (h[2] + h[3]) / 2;
    const left = (h[0] + h[2]) / 2, rightH = (h[1] + h[3]) / 2;
    const tp = Math.atan2(front - rear, this.hl * 1.4);
    const tr = Math.atan2(rightH - left, this.hw * 1.6);
    const k = Math.min(1, dt * 14);
    this.pitch += (tp - this.pitch) * k;
    this.roll += (tr - this.roll) * k;
    this.pos.y += (avg - this.pos.y) * Math.min(1, dt * 20);
    this.vel.y = 0;
    this.airborne = 0;
  }
}
