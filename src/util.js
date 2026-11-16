// Small shared helpers: math, seeded random, easing and a promise-based tween runner.

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ease = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

const active = new Set();

/** Run fn(easedT) every frame for `dur` seconds. Resolves when finished. */
export function animate(dur, fn, easing = ease.inOut) {
  return new Promise((resolve) => {
    if (dur <= 0) { fn(1); resolve(); return; }
    active.add({ t: 0, dur, fn, easing, resolve });
    fn(easing(0));
  });
}

export function tickAnimations(dt) {
  for (const a of [...active]) {
    a.t += dt;
    const k = Math.min(1, a.t / a.dur);
    a.fn(a.easing(k));
    if (k >= 1) { active.delete(a); a.resolve(); }
  }
}

export const wait = (s) => animate(s, () => {}, ease.linear);

/** Tween an Object3D's local position / quaternion / scale from where it is now. */
export function moveTo(obj, { pos, quat, scale }, dur, easing = ease.inOut) {
  const p0 = obj.position.clone();
  const q0 = obj.quaternion.clone();
  const s0 = obj.scale.clone();
  return animate(dur, (t) => {
    if (pos) obj.position.lerpVectors(p0, pos, t);
    if (quat) obj.quaternion.slerpQuaternions(q0, quat, clamp(t, 0, 1));
    if (scale) obj.scale.lerpVectors(s0, scale, t);
  }, easing);
}
