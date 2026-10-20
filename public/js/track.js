/** Centre-line of a race track as a polyline in map XZ coordinates. */
export class Track {
  constructor(cfg) {
    const t = cfg.track || {};
    this.width = t.width || 3;
    this.closed = cfg.circuit !== false;
    let pts = (t.points || []).map(([x, z]) => ({ x, z }));
    // out-and-back: drive to the far end, turn around and come back along the same line
    if (t.pingpong && this.closed && pts.length > 2) pts = pts.concat(pts.slice(1, -1).reverse());
    this.pts = pts;
    this.cum = [0];
    const n = this.pts.length;
    const segs = this.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = this.pts[i], b = this.pts[(i + 1) % n];
      this.cum.push(this.cum[i] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.length = n > 1 ? this.cum[segs] : 0;
    this.valid = n >= 3 && this.length > 1;
    this.s0 = 0;
    this.sFinish = this.length;
    if (this.valid) {
      if (cfg.start) this.s0 = this.project(cfg.start.x, cfg.start.z).s;
      if (!this.closed) this.sFinish = cfg.finish ? this.rel(this.project(cfg.finish.x, cfg.finish.z).s) : this.length - this.s0;
      if (!this.closed) this.sFinish = Math.max(1, Math.min(this.sFinish, this.length - this.s0 - 0.3));
    }
  }

  /** arc length relative to the start line, in [0, length) */
  rel(s) {
    const L = this.length;
    return this.closed ? (((s - this.s0) % L) + L) % L : s - this.s0;
  }

  at(s) {
    const L = this.length;
    if (this.closed) s = ((s % L) + L) % L; else s = Math.max(0, Math.min(L, s));
    let lo = 0, hi = this.cum.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cum[m] <= s) lo = m; else hi = m - 1; }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length];
    const len = this.cum[lo + 1] - this.cum[lo] || 1;
    const f = (s - this.cum[lo]) / len;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
  }

  /** closest point on the line; hint (absolute s) + win restrict the search to avoid shortcut jumps */
  project(x, z, hint = null, win = 15) {
    const n = this.pts.length;
    const segs = this.cum.length - 1;
    let best = { d2: Infinity, s: 0, side: 0 };
    for (let i = 0; i < segs; i++) {
      if (hint != null) {
        let d = Math.abs((this.cum[i] + this.cum[i + 1]) / 2 - hint);
        if (this.closed) d = Math.min(d, this.length - d);
        if (d > win + (this.cum[i + 1] - this.cum[i])) continue;
      }
      const a = this.pts[i], b = this.pts[(i + 1) % n];
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz || 1e-9;
      const f = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / l2));
      const px = a.x + abx * f, pz = a.z + abz * f;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      if (d2 < best.d2) best = { d2, s: this.cum[i] + f * Math.sqrt(l2), side: abx * (z - pz) - abz * (x - px) };
    }
    return { s: best.s, dist: Math.sqrt(best.d2), side: best.side };
  }
}
