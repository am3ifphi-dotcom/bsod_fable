export const TAU = Math.PI * 2;
export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));
export const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t: number) => t * t * t;
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hash1 = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
};
/** smooth 1D value noise in -1..1 */
export function vnoise(t: number, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i + seed * 57.31), hash1(i + 1 + seed * 57.31), u) * 2 - 1;
}
/** fractal 1D noise in roughly -1..1 */
export function fnoise(t: number, seed = 0) {
  return (
    vnoise(t, seed) * 0.6 +
    vnoise(t * 2.13 + 11.7, seed + 3) * 0.3 +
    vnoise(t * 4.71 + 5.3, seed + 7) * 0.1
  );
}
/** stepped noise 0..1 that changes `rate` times per second */
export const stepNoise = (t: number, rate: number, seed = 0) =>
  hash1(Math.floor(t * rate) + seed * 17.17);
export function wrapAngle(a: number) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
export const lerpAngle = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;
/**
 * Second-order spring (frequency in Hz + damping ratio).
 * Under-damped values (z < 1) overshoot, which is what gives the
 * camera its "head with mass" feeling during forced cinematics.
 */
export class Spring {
  x: number;
  v = 0;
  target: number;
  f: number;
  z: number;
  constructor(x = 0, f = 2, z = 0.7) {
    this.x = x;
    this.target = x;
    this.f = f;
    this.z = z;
  }
  set(x: number) {
    this.x = x;
    this.target = x;
    this.v = 0;
  }
  to(target: number, f?: number, z?: number) {
    this.target = target;
    if (f !== undefined) this.f = f;
    if (z !== undefined) this.z = z;
  }
  kick(v: number) {
    this.v += v;
  }
  step(dt: number) {
    const w = TAU * this.f;
    const n = Math.max(1, Math.ceil((dt * w) / 0.35));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -2 * this.z * w * this.v - w * w * (this.x - this.target);
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}
/** yaw / pitch (three.js YXZ convention, forward = -Z) that looks from a to b */
export function lookAngles(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
  };
}