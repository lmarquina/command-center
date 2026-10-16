// Walking detection from the G2 IMU (x/y/z, units undocumented → everything is relative).
// Walking = a rhythmic bounce at step cadence (≈1.2–2.8 steps/s) whose size clearly exceeds the resting jitter.
// Still = low variation for ~1.5 s. Hysteresis avoids flapping. Pure + deterministic → unit-tested.

export class MotionDetector {
  // Tuned after a desk session (2026-10-10): sitting showed std 0.004–0.02 with head-turn spikes, so walking needs
  // ≥5 evenly spaced bounces, std ≥ minStd and ≥ ratio·floor, held for holdMs; switches are ≥ minDwellMs apart.
  constructor({ windowMs = 3000, stillMs = 2000, minPeaks = 5, ratio = 4, minStd = 0.04, minStepMs = 350, maxStepMs = 850, maxGapCv = 0.35, holdMs = 2000, minDwellMs = 8000 } = {}) {
    Object.assign(this, { windowMs, stillMs, minPeaks, ratio, minStd, minStepMs, maxStepMs, maxGapCv, holdMs, minDwellMs });
    this.samples = []; this.state = "still"; this.quietSince = null; this.walkSince = null; this.restStd = null; this.lastStats = null; this.lastSwitch = -Infinity;
  }
  /** @param {{x:number,y:number,z:number,t:number}} s  t in ms. Returns the new state if it changed, else null. */
  push(s) {
    const m = Math.hypot(s.x || 0, s.y || 0, s.z || 0);
    this.samples.push({ t: s.t, m }); while (this.samples.length && s.t - this.samples[0].t > this.windowMs) this.samples.shift();
    if (this.samples.length < 6) return null;
    const ms = this.samples.map((x) => x.m), mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    const std = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / ms.length);
    // resting jitter baseline: slow-moving minimum of the window std (learns the sensor's noise floor)
    this.restStd = this.restStd == null ? std : Math.min(std, this.restStd * 0.995 + std * 0.005);
    const floor = Math.max(this.restStd, 1e-6);
    // step-like peaks: local maxima above mean + 0.5·std, spaced like steps
    const peaks = [];
    for (let i = 1; i < this.samples.length - 1; i++) {
      const a = this.samples[i - 1].m, b = this.samples[i].m, c = this.samples[i + 1].m;
      if (b > a && b >= c && b > mean + 0.5 * std) peaks.push(this.samples[i].t);
    }
    const gaps = peaks.slice(1).map((t, i) => t - peaks[i]);
    const steps = gaps.filter((g) => g >= this.minStepMs && g <= this.maxStepMs);
    const gm = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
    const cv = steps.length > 1 ? Math.sqrt(steps.reduce((a, b) => a + (b - gm) ** 2, 0) / steps.length) / gm : 1;   // regularity
    const rhythmic = steps.length >= this.minPeaks - 1 && cv <= this.maxGapCv;
    const strong = std >= this.minStd && std > floor * this.ratio;
    const quiet = std < Math.max(this.minStd * 0.5, floor * 2);
    this.lastStats = { mean: +mean.toFixed(3), std: +std.toFixed(4), floor: +floor.toFixed(4), peaks: peaks.length, steplike: steps.length, cv: +cv.toFixed(2) };
    let next = this.state;
    if (strong && rhythmic) { this.quietSince = null; this.walkSince = this.walkSince ?? s.t; if (s.t - this.walkSince >= this.holdMs) next = "walking"; }
    else { this.walkSince = null; if (quiet) { this.quietSince = this.quietSince ?? s.t; if (s.t - this.quietSince >= this.stillMs) next = "still"; } else this.quietSince = null; }
    if (next !== this.state && s.t - this.lastSwitch < this.minDwellMs) next = this.state;   // no flapping
    if (next !== this.state) { this.state = next; this.lastSwitch = s.t; return next; }
    return null;
  }
}
