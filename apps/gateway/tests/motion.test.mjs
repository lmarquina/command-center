import { test } from "node:test";
import assert from "node:assert/strict";
import { MotionDetector } from "../src/motion.mjs";

// Synthetic IMU at 10 Hz: gravity on z plus noise; walking adds a ~1.8 Hz bounce. Scale is arbitrary on purpose.
function feed(det, { seconds, bounce = 0, hz = 1.8, noise = 0.01, t0 = 0, scale = 1 }) {
  const changes = []; let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < seconds * 10; i++) {
    const t = t0 + i * 100, b = bounce * Math.sin(2 * Math.PI * hz * t / 1000);
    const r = det.push({ x: scale * (noise * rnd()), y: scale * (noise * rnd()), z: scale * (1 + b + noise * rnd()), t });
    if (r) changes.push({ t, r });
  }
  return changes;
}

test("still → walking within ~2–3 s of rhythmic bouncing, → still ~1.5 s after stopping", () => {
  const d = new MotionDetector();
  assert.deepEqual(feed(d, { seconds: 6 }), []);                                  // standing: no change
  const w = feed(d, { seconds: 10, bounce: 0.15, t0: 6000 });
  assert.equal(w[0].r, "walking"); assert.ok(w[0].t - 6000 <= 6000, `detected after ${w[0].t - 6000} ms`);
  const s = feed(d, { seconds: 10, t0: 16000 });
  assert.equal(s.at(-1).r, "still"); assert.ok(s.at(-1).t - 16000 <= 6000);
});
test("units don't matter (same behaviour at 1000x scale)", () => {
  const d = new MotionDetector();
  // (absolute floor minStd is in sensor units; scale it with the data)
  const big = new MotionDetector({ minStd: 40 }); feed(big, { seconds: 6, scale: 1000 });
  assert.equal(feed(big, { seconds: 10, bounce: 0.15, t0: 6000, scale: 1000 })[0].r, "walking");
});
test("a single head turn / non-rhythmic motion does not switch to walking", () => {
  const d = new MotionDetector(); feed(d, { seconds: 6 });
  const changes = []; for (let i = 0; i < 30; i++) { const t = 6000 + i * 100; const r = d.push({ x: i >= 10 && i < 13 ? 0.6 : 0, y: 0, z: 1, t }); if (r) changes.push(r); }
  assert.ok(!changes.includes("walking"));
});

test("desk fidgeting (std ~0.005–0.02, random head moves) never switches to walking", () => {
  const d = new MotionDetector(); let seed = 3; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647 - 0.5);
  const changes = [];
  for (let i = 0; i < 600; i++) {          // 60 s at 10 Hz
    const t = i * 100, fidget = rnd() * 0.03 + (i % 37 === 0 ? 0.09 : 0) + 0.01 * Math.sin(i / 3);
    const r = d.push({ x: rnd() * 0.01, y: rnd() * 0.01, z: 1 + fidget, t }); if (r) changes.push(r);
  }
  assert.deepEqual(changes, []);
});
