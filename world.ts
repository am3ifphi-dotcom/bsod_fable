import * as THREE from 'three';
import { MONO_FONT, dialogTexture, errorTextTexture, makeCanvas, qrTexture, titleBarTexture } from './textures';
import { TAU, clamp, hash1, mulberry, smooth } from './utils';
export const WORLD = {
  spawn: new THREE.Vector3(0, 0, 150),
  radius: 232,
  eye: 1.65,
  secret: 'WAKE_UP',
};
export function terrainHeight(x: number, z: number) {
  const r = Math.hypot(x, z);
  const base =
    2.4 * Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.017 - 0.4) +
    1.5 * Math.sin(x * 0.043 - z * 0.031 + 2.0) +
    0.5 * Math.sin(x * 0.09 + 0.7) * Math.sin(z * 0.11);
  const f = smooth(24, 62, r);
  const rim = Math.pow(Math.max(0, r - 245) / 60, 2) * 34;
  return base * f + rim;
}
/** walkable height (terrain + the plaza steps) */
export function groundHeight(x: number, z: number) {
  const r = Math.hypot(x, z);
  let h = terrainHeight(x, z);
  if (r < 17) h = Math.max(h, 0.3);
  if (r < 13) h = Math.max(h, 0.6);
  if (r < 9.5) h = Math.max(h, 0.9);
  return h;
}
const FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
vec3 applyFog(vec3 c, float d) { return mix(c, uFogColor, smoothstep(uFogNear, uFogFar, d)); }
`;
const TERRAIN_VERT = /* glsl */ `
uniform float uCollapseT;
uniform vec3 uHole;
varying vec3 vP;
varying float vDist;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vP = position;
  vec3 p = position;
  if (uCollapseT > 0.0) {
    float dC = distance(p.xz, uHole.xz);
    float cell = h21(floor((p.xz + 1.3) / 8.0));
    float ft = max(0.0, uCollapseT - dC / 60.0 - cell * 1.1);
    p.y -= 30.0 * (ft - 2.0 * (1.0 - exp(-ft / 2.0)));
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D tText;
uniform vec3 uHole;
uniform float uHoleR;
uniform vec2 uCrackDir;
uniform float uCrackLen;
${FOG}
varying vec3 vP;
varying float vDist;
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float n11(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h11(i), h11(i + 1.0), f); }
float zig(float al, float seed) {
  return (n11(al * 0.33 + seed) - 0.5) * 3.4 * smoothstep(0.0, 14.0, al) + (n11(al * 1.7 + seed * 3.0) - 0.5) * 0.6 * smoothstep(0.0, 3.0, al);
}
float crack(vec2 p, vec2 o, vec2 dir, float len, float seed) {
  vec2 q = p - o;
  float al = dot(q, dir);
  float ac = dot(q, vec2(-dir.y, dir.x));
  float d = abs(ac - zig(al, seed));
  float w = 0.26 - 0.16 * smoothstep(0.0, len, al);
  float m = step(0.0, al) * step(al, len);
  return m * ((1.0 - smoothstep(0.0, w, d)) + 0.35 * exp(-d * 1.6));
}
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }
void main() {
  vec2 p = vP.xz;
  if (uHoleR > 0.0 && distance(p, uHole.xz) < uHoleR) discard;
  vec3 n = normalize(cross(dFdx(vP), dFdy(vP)));
  n *= sign(n.y + 1e-5);
  float r = length(p);
  vec2 g4 = abs(fract(p / 4.0 - 0.5) - 0.5) / fwidth(p / 4.0);
  float line = (1.0 - min(min(g4.x, g4.y), 1.0)) * (1.0 - smoothstep(70.0, 280.0, vDist));
  vec2 g1 = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  float line1 = (1.0 - min(min(g1.x, g1.y), 1.0)) * (1.0 - smoothstep(8.0, 40.0, vDist));
  float tBig = texture2D(tText, p * 0.0065).r;
  float tSmall = texture2D(tText, p * 0.045 + 0.3).r * (1.0 - smoothstep(18.0, 70.0, vDist));
  float shade = 0.5 + 0.5 * clamp(dot(n, normalize(vec3(-0.4, 0.8, -0.45))), 0.0, 1.0);
  vec3 col = mix(vec3(0.0, 0.06, 0.34), vec3(0.0, 0.19, 0.68), shade * (0.55 + 0.45 * smoothstep(-3.0, 4.0, vP.y)));
  float ringD = (0.5 - abs(fract(r / 3.5) - 0.5)) * 3.5;
  float rings = (1.0 - smoothstep(0.04, 0.1, ringD)) * (1.0 - smoothstep(30.0, 42.0, r));
  col += vec3(0.75, 0.88, 1.0) * (line * 0.42 + line1 * 0.15 + tBig * 0.09 + tSmall * 0.2 + rings * 0.55);
  if (uCrackLen > 0.0) {
    vec2 perp = vec2(-uCrackDir.y, uCrackDir.x);
    float ck = crack(p, uHole.xz, uCrackDir, uCrackLen, 1.0);
    vec2 o2 = uHole.xz + uCrackDir * 26.0 + perp * zig(26.0, 1.0);
    ck = max(ck, crack(p, o2, rot(uCrackDir, 0.62), max(0.0, uCrackLen - 26.0) * 0.6, 4.0));
    vec2 o3 = uHole.xz + uCrackDir * 48.0 + perp * zig(48.0, 1.0);
    ck = max(ck, crack(p, o3, rot(uCrackDir, -0.78), max(0.0, uCrackLen - 48.0) * 0.7, 9.0));
    ck = max(ck, crack(p, uHole.xz, -uCrackDir, uCrackLen * 0.22, 5.0));
    ck = max(ck, crack(p, uHole.xz, perp, uCrackLen * 0.16, 7.0));
    col += vec3(0.8, 0.93, 1.0) * ck * 2.6;
  }
  if (!gl_FrontFacing) col = col * 0.22 + vec3(0.5, 0.75, 1.0) * line * 0.6;
  gl_FragColor = vec4(applyFog(col, vDist), 1.0);
}`;
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FRAG = /* glsl */ `
uniform float uTime;
uniform float uSkyBreak;
uniform float uSkyDark;
uniform vec3 uFogColor;
varying vec3 vDir;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float az = atan(d.x, -d.z);
  float y = d.y;
  float band = floor(y * 34.0);
  float bt = floor(uTime * 9.0);
  az += (h(vec2(band, bt)) - 0.5) * uSkyBreak * 1.4 * step(1.0 - uSkyBreak * 0.8, h(vec2(band * 1.7, bt + 2.0)));
  vec3 col = mix(vec3(0.30, 0.62, 1.0), vec3(0.0, 0.11, 0.52), pow(clamp(y, 0.0, 1.0), 0.55));
  col = mix(vec3(0.0, 0.025, 0.15), col, smoothstep(-0.35, 0.0, y));
  col = mix(col, uFogColor, exp(-abs(y) * 9.0));
  // a square sun with a face nobody asked for
  vec2 sp = vec2(az, y - 0.22);
  float sq = (1.0 - smoothstep(0.074, 0.08, abs(sp.x))) * (1.0 - smoothstep(0.074, 0.08, abs(sp.y)));
  float eyes = 1.0 - smoothstep(0.007, 0.009, min(length(sp - vec2(-0.026, 0.024)), length(sp - vec2(0.026, 0.024))));
  float mouth = (1.0 - smoothstep(0.004, 0.006, abs(length(sp - vec2(0.0, -0.06)) - 0.036))) * step(-0.034, sp.y);
  col += vec3(1.0) * sq * 1.7 * (1.0 - max(eyes, mouth) * 0.85);
  col += vec3(0.6, 0.8, 1.0) * exp(-length(sp) * 5.0) * 0.5;
  col *= 0.97 + 0.03 * sin(y * 400.0);
  float tear = step(1.0 - uSkyBreak * 0.45, h(vec2(floor(y * 17.0 + 3.0), floor(uTime * 5.0))));
  col = mix(col, vec3(0.0, 0.0, 0.02), tear * step(0.02, y) * 0.92);
  col = mix(col, uFogColor, uSkyDark);
  gl_FragColor = vec4(col, 1.0);
}`;
export const MONO_VERT = /* glsl */ `
uniform float uTime;
uniform float uGlitch;
uniform float uCollapseT;
uniform vec3 uHole;
uniform vec3 uOffset;
varying vec3 vN;
varying vec2 vUv2;
varying float vDist;
varying float vSeed;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec3 scl = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  vec3 origin = m[3].xyz - uOffset;
  float seed = fract(sin(dot(origin.xz, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 wp = m * vec4(position, 1.0);
  vec3 rel = wp.xyz - m[3].xyz;
  float slice = floor((rel.y + scl.y * 0.5) * 0.4 + seed * 10.0);
  float g = step(0.7, fract(sin(slice * 91.7 + floor(uTime * 14.0) * 7.3) * 4375.5)) * uGlitch;
  rel.x += g * (seed - 0.5) * 5.0;
  float fall = 0.0;
  if (uCollapseT > 0.0) {
    float dC = distance(origin.xz, uHole.xz);
    float ft = max(0.0, uCollapseT - dC / 55.0 - seed * 0.9);
    fall = 36.0 * (ft - 2.4 * (1.0 - exp(-ft / 2.4)));
    float ang = min(ft * 0.3 * (seed + 0.3), 1.3) * (seed > 0.5 ? 1.0 : -1.0);
    float cs = cos(ang), sn = sin(ang);
    rel.xy = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs);
  }
  wp.xyz = m[3].xyz + rel;
  wp.y -= fall;
  vN = normalize(mat3(m) * normal);
  vec2 uv2 = abs(normal.y) > 0.5 ? uv * scl.xz : (abs(normal.x) > 0.5 ? uv * scl.zy : uv * scl.xy);
  vUv2 = uv2 * 0.085 + vec2(seed * 7.0, seed * 3.0);
  vSeed = seed;
  vec4 mv = viewMatrix * wp;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
export const MONO_FRAG = /* glsl */ `
uniform sampler2D tText;
uniform float uTime;
${FOG}
varying vec3 vN;
varying vec2 vUv2;
varying float vDist;
varying float vSeed;
void main() {
  float txt = texture2D(tText, vUv2).r;
  float nl = dot(normalize(vN), normalize(vec3(-0.4, 0.75, -0.5))) * 0.5 + 0.5;
  vec3 col = mix(vec3(0.0, 0.045, 0.28), vec3(0.0, 0.2, 0.7), nl);
  float row = floor(vUv2.y * 32.0);
  float fl = step(0.988, fract(sin(row * 12.7 + floor(uTime * 3.0) * 3.1 + vSeed * 40.0) * 437.5));
  col += vec3(0.85, 0.93, 1.0) * txt * (0.7 + fl * 1.6);
  col += vec3(0.1, 0.3, 0.8) * fl * 0.3;
  gl_FragColor = vec4(applyFog(col, vDist), 1.0);
}`;
const SHARD_VERT = /* glsl */ `
uniform float uTime;
uniform float uCollapseT;
uniform vec3 uHole;
varying vec3 vW;
varying float vDist;
varying float vSeed;
void main() {
  vec3 origin = instanceMatrix[3].xyz;
  float seed = fract(sin(dot(origin.xz, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 a = normalize(vec3(seed - 0.5, fract(seed * 7.3) - 0.5, fract(seed * 13.7) - 0.5) + 0.001);
  float ang = uTime * (0.1 + seed * 0.35);
  vec3 lp = (instanceMatrix * vec4(position, 0.0)).xyz;
  lp = lp * cos(ang) + cross(a, lp) * sin(ang) + a * dot(a, lp) * (1.0 - cos(ang));
  vec3 p = origin + lp;
  p.y += sin(uTime * (0.2 + seed * 0.3) + seed * 30.0) * 1.2;
  if (uCollapseT > 0.0) {
    float ft = max(0.0, uCollapseT - distance(origin.xz, uHole.xz) / 70.0 - seed);
    p.y -= 22.0 * (ft - 2.0 * (1.0 - exp(-ft / 2.0)));
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vW = wp.xyz;
  vSeed = seed;
  vec4 mv = viewMatrix * wp;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const SHARD_FRAG = /* glsl */ `
${FOG}
varying vec3 vW;
varying float vDist;
varying float vSeed;
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  float nl = abs(dot(n, normalize(vec3(-0.4, 0.75, -0.5))));
  vec3 col = mix(vec3(0.1, 0.4, 1.0), vec3(1.15), nl) * (0.65 + 0.6 * vSeed);
  gl_FragColor = vec4(applyFog(col, vDist), 1.0);
}`;
const DUST_VERT = /* glsl */ `
attribute vec3 aOff;
uniform float uTime;
uniform float uStretch;
uniform vec3 uCamLocal;
varying float vA;
void main() {
  float box = 70.0;
  vec3 o = aOff * box;
  o.y += uTime * (0.25 + fract(aOff.x * 9.0) * 0.5);
  vec3 c = mod(o - uCamLocal + box * 0.5, box) - box * 0.5;
  float s = 0.03 + fract(aOff.z * 17.0) * 0.05;
  vec3 lp = position * vec3(s, s + uStretch * (0.4 + fract(aOff.y * 5.0)), s);
  vec4 mv = viewMatrix * vec4(cameraPosition + c + lp, 1.0);
  float d = length(mv.xyz);
  vA = smoothstep(35.0, 20.0, d) * smoothstep(0.6, 2.5, d);
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAG = /* glsl */ `
varying float vA;
void main() { gl_FragColor = vec4(vec3(0.75, 0.88, 1.0) * vA * 0.9, 1.0); }`;
const BEAM_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vY = uv.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BEAM_FRAG = /* glsl */ `
uniform float uBeam;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying float vY;
void main() {
  float f = pow(abs(dot(normalize(vN.xz), normalize(vV.xz))), 2.5);
  float fl = 0.85 + 0.15 * sin(uTime * 3.0 + vY * 60.0);
  gl_FragColor = vec4(vec3(0.55, 0.78, 1.0) * f * fl * uBeam * smoothstep(0.0, 0.03, vY), 1.0);
}`;
export interface Slab {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  rot: THREE.Euler;
}
export class World {
  group = new THREE.Group();
  u = {
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color('#3f93ea') },
    uFogNear: { value: 26 },
    uFogFar: { value: 430 },
    uGlitch: { value: 0 },
    uCollapseT: { value: 0 },
    uHole: { value: new THREE.Vector3(0, 0, 1e5) },
    uHoleR: { value: 0 },
    uCrackDir: { value: new THREE.Vector2(0, -1) },
    uCrackLen: { value: 0 },
    uOffset: { value: new THREE.Vector3() },
    tText: { value: null as THREE.Texture | null },
    uSkyBreak: { value: 0 },
    uSkyDark: { value: 0 },
    uStretch: { value: 0 },
    uCamLocal: { value: new THREE.Vector3() },
    uBeam: { value: 1 },
  };
  monoMat: THREE.ShaderMaterial;
  slabs: Slab[] = [];
  sky!: THREE.Mesh;
  rings: THREE.Mesh[] = [];
  core!: THREE.Mesh;
  timeScale = 1;
  time = 0;
  anomaly = 0;
  reveal = 0;
  secretSeen = false;
  onAnomaly: ((strength: number) => void) | null = null;
  onReveal: (() => void) | null = null;
  private colliders: { x: number; z: number; r: number }[] = [];
  private cubes: THREE.Mesh[] = [];
  private totems: THREE.Group[] = [];
  private secretCanvas!: HTMLCanvasElement;
  private secretCtx!: CanvasRenderingContext2D;
  private secretTex!: THREE.CanvasTexture;
  private secretMat!: THREE.MeshBasicMaterial;
  private secretDrawn = -1;
  private secretLocked = -1;
  private nextAnomaly = 16;
  private towerMat: THREE.ShaderMaterial;
  constructor() {
    this.u.tText.value = errorTextTexture();
    this.monoMat = new THREE.ShaderMaterial({ vertexShader: MONO_VERT, fragmentShader: MONO_FRAG, uniforms: this.u });
    // the tower is animated by hand when it comes down, so it ignores the shader collapse
    this.towerMat = new THREE.ShaderMaterial({
      vertexShader: MONO_VERT,
      fragmentShader: MONO_FRAG,
      uniforms: { ...this.u, uCollapseT: { value: 0 } },
    });
    this.build();
  }
  private build() {
    const G = this.group;
    const rnd = mulberry(777);
    const u = this.u;
    // ---------- terrain ----------
    const tg = new THREE.PlaneGeometry(680, 680, 170, 170);
    tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) tp.setY(i, terrainHeight(tp.getX(i), tp.getZ(i)));
    const terrain = new THREE.Mesh(
      tg,
      new THREE.ShaderMaterial({ vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms: u, side: THREE.DoubleSide })
    );
    terrain.frustumCulled = false;
    G.add(terrain);
    // ---------- sky ----------
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1400, 32, 20),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: u, side: THREE.BackSide, depthWrite: false })
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    G.add(this.sky);
    // ---------- monolith field (near, mid and silhouettes on the horizon) ----------
    const N = 120;
    const mono = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.monoMat, N);
    const dummy = new THREE.Object3D();
    let placed = 0;
    let guard = 0;
    while (placed < N && guard++ < 4000) {
      const far = placed >= 84;
      const a = rnd() * TAU;
      const r = far ? 300 + rnd() * 150 : 44 + Math.pow(rnd(), 0.8) * 196;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!far && Math.abs(x) < 15 && z > 40) continue; // keep the arrival corridor open
      const w = far ? 18 + rnd() * 40 : 2 + rnd() * rnd() * 9;
      const d = far ? 18 + rnd() * 40 : 2 + rnd() * rnd() * 9;
      const h = far ? 90 + rnd() * 190 : 6 + rnd() * rnd() * 46;
      if (!far && this.colliders.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + Math.max(w, d) + 3)) continue;
      const y = terrainHeight(x, z);
      dummy.position.set(x, y + h / 2 - 2.5, z);
      dummy.rotation.set((rnd() - 0.5) * 0.14, rnd() * TAU, (rnd() - 0.5) * 0.14);
      dummy.scale.set(w, h, d);
      dummy.updateMatrix();
      mono.setMatrixAt(placed, dummy.matrix);
      if (!far) this.colliders.push({ x, z, r: Math.max(w, d) * 0.6 });
      placed++;
    }
    mono.count = placed;
    mono.instanceMatrix.needsUpdate = true;
    mono.frustumCulled = false;
    G.add(mono);
    // ---------- the kernel: central tower ----------
    for (const [r, hgt] of [
      [17, 0.3],
      [13, 0.6],
      [9.5, 0.9],
    ]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 48), this.towerMat);
      s.scale.set(r, hgt, r);
      s.position.y = hgt / 2;
      G.add(s);
    }
    for (let i = 0; i < 10; i++) {
      const w = 12 - i * 0.75;
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.towerMat);
      m.scale.set(w, 8.5, w);
      m.position.set(i === 0 ? 0 : (rnd() - 0.5) * 1.6, 0.9 + 3.6 + 4.25 + i * 9.8, i === 0 ? 0 : (rnd() - 0.5) * 1.6);
      m.rotation.y = i === 0 ? 0 : (rnd() - 0.5) * 0.6;
      m.frustumCulled = false;
      G.add(m);
      this.slabs.push({ mesh: m, pos: m.position.clone(), rot: m.rotation.clone() });
    }
    this.colliders.push({ x: 0, z: 0, r: 6.6 });
    // the secret, engraved on all four faces of the lowest slab
    const [sc, sg] = makeCanvas(1024, 256);
    this.secretCanvas = sc;
    this.secretCtx = sg;
    this.secretTex = new THREE.CanvasTexture(sc);
    this.secretTex.colorSpace = THREE.SRGBColorSpace;
    this.secretTex.anisotropy = 8;
    this.secretMat = new THREE.MeshBasicMaterial({
      map: this.secretTex,
      transparent: true,
      depthWrite: false,
      fog: false,
      color: new THREE.Color(1.5, 1.6, 1.8),
    });
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3), this.secretMat);
      const a = (i / 4) * TAU;
      p.position.set(Math.sin(a) * 0.508, -0.02, Math.cos(a) * 0.508);
      p.rotation.y = a;
      this.slabs[0].mesh.add(p);
    }
    this.drawSecret(0, 0);
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.8, 3.4), fog: false }));
    this.core.position.y = 2.9;
    G.add(this.core);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.3, 1.6, 2.0) });
    for (const [r, y, t] of [
      [26, 72, 0.5],
      [17, 46, 0.35],
      [38, 96, 0.6],
    ]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 6, 72), ringMat);
      ring.position.y = y;
      ring.rotation.x = Math.PI / 2 + (rnd() - 0.5) * 0.5;
      ring.frustumCulled = false;
      G.add(ring);
      this.rings.push(ring);
    }
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 2.4, 900, 24, 1, true),
      new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: u,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    beam.position.y = 450 + 100;
    beam.frustumCulled = false;
    G.add(beam);
    // gates: four giant window frames around the plaza
    const titleMat = new THREE.MeshBasicMaterial({ map: titleBarTexture() });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      const gate = new THREE.Group();
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.towerMat);
        p.scale.set(1.6, 16, 1.6);
        p.position.set(s * 6.6, 8, 0);
        gate.add(p);
        const lx = s * 6.6;
        this.colliders.push({
          x: Math.sin(a) * 31 + Math.cos(a) * lx,
          z: Math.cos(a) * 31 - Math.sin(a) * lx,
          r: 1.1,
        });
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.towerMat);
      bar.scale.set(14.8, 2.4, 1.7);
      bar.position.y = 16.6;
      gate.add(bar);
      for (const s of [-1, 1]) {
        const t = new THREE.Mesh(new THREE.PlaneGeometry(14.6, 2.28), titleMat);
        t.position.set(0, 16.6, s * 0.87);
        t.rotation.y = s > 0 ? 0 : Math.PI;
        gate.add(t);
      }
      gate.position.set(Math.sin(a) * 31, terrainHeight(Math.sin(a) * 31, Math.cos(a) * 31) - 0.4, Math.cos(a) * 31);
      gate.rotation.y = a;
      G.add(gate);
    }
    // ---------- floating error dialogs (classic "stuck window" trails) ----------
    const dlgMat = new THREE.MeshBasicMaterial({ map: dialogTexture(), side: THREE.DoubleSide });
    const dlg = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.625), dlgMat, 110);
    let di = 0;
    for (let t = 0; t < 6; t++) {
      const a = rnd() * TAU;
      const r = 50 + rnd() * 120;
      const bx = Math.cos(a) * r;
      const bz = Math.sin(a) * r;
      const by = 10 + rnd() * 34;
      const size = 5 + rnd() * 9;
      const yaw = rnd() * TAU;
      const sx = (rnd() - 0.5) * 2.4;
      const sy = 0.5 + rnd() * 1.3;
      const curve = (rnd() - 0.5) * 0.12;
      for (let k = 0; k < 15; k++) {
        dummy.position.set(bx + Math.cos(yaw) * k * sx + Math.sin(yaw) * k * 0.5, by + k * sy + Math.sin(k * 0.5) * 0.8, bz - Math.sin(yaw) * k * sx + Math.cos(yaw) * k * 0.5);
        dummy.rotation.set(0, yaw + k * curve, 0);
        dummy.scale.set(size, size, 1);
        dummy.updateMatrix();
        dlg.setMatrixAt(di++, dummy.matrix);
      }
    }
    while (di < 110) {
      const a = rnd() * TAU;
      const r = 30 + rnd() * 190;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const size = 2.5 + rnd() * 6;
      const buried = rnd() > 0.5;
      dummy.position.set(x, terrainHeight(x, z) + (buried ? size * 0.12 : 4 + rnd() * 26), z);
      dummy.rotation.set((rnd() - 0.5) * (buried ? 0.9 : 0.3), rnd() * TAU, (rnd() - 0.5) * (buried ? 0.9 : 0.25));
      dummy.scale.set(size, size, 1);
      dummy.updateMatrix();
      dlg.setMatrixAt(di++, dummy.matrix);
    }
    dlg.instanceMatrix.needsUpdate = true;
    dlg.frustumCulled = false;
    G.add(dlg);
    // ---------- drifting shards ----------
    const SH = 460;
    const shards = new THREE.InstancedMesh(
      new THREE.TetrahedronGeometry(1, 0),
      new THREE.ShaderMaterial({ vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG, uniforms: u }),
      SH
    );
    for (let i = 0; i < SH; i++) {
      const a = rnd() * TAU;
      const r = (i < 90 ? 9 + rnd() * 30 : 20 + rnd() * 250) + 0.01 * i;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = 0.12 + rnd() * rnd() * (i < 90 ? 0.9 : 2.6);
      dummy.position.set(x, (i < 90 ? 12 + rnd() * 80 : terrainHeight(x, z) + 2.5 + rnd() * rnd() * 90), z);
      dummy.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
      dummy.scale.set(s, s * (0.4 + rnd() * 2), s * 0.6);
      dummy.updateMatrix();
      shards.setMatrixAt(i, dummy.matrix);
    }
    shards.instanceMatrix.needsUpdate = true;
    shards.frustumCulled = false;
    G.add(shards);
    // ---------- QR cubes ----------
    const qrMat = new THREE.MeshBasicMaterial({ map: qrTexture() });
    for (let i = 0; i < 6; i++) {
      const a = rnd() * TAU;
      const r = 36 + rnd() * 130;
      const s = 2.5 + rnd() * 5;
      const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), qrMat);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      c.position.set(x, terrainHeight(x, z) + 6 + rnd() * 18, z);
      c.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      G.add(c);
      this.cubes.push(c);
    }
    // ---------- fallen ":(" colossi ----------
    const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.95, 1.05) });
    for (const [x, y, z, s, rx, ry, rz] of [
      [-165, 34, -130, 1.0, 0.3, 0.9, -1.2],
      [185, 60, -40, 1.5, -0.2, -1.2, -1.75],
      [50, 90, -260, 2.2, 0.1, 0.1, -1.5],
      [-120, 26, 150, 0.8, 0.4, 2.4, -0.4],
    ]) {
      const t = new THREE.Group();
      for (const e of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(4.2, 16, 12), white);
        eye.position.set(-22, e * 13, 0);
        t.add(eye);
      }
      const arc = new THREE.Mesh(new THREE.TorusGeometry(42, 3, 8, 40, 1.5), white);
      arc.position.set(46, 0, 0);
      arc.rotation.z = Math.PI - 0.75;
      t.add(arc);
      t.position.set(x, y, z);
      t.rotation.set(rx, ry, rz);
      t.scale.setScalar(s);
      G.add(t);
      this.totems.push(t);
    }
    // ---------- distant light pillars ----------
    const pil = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.5, 0.75, 1),
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
      18
    );
    for (let i = 0; i < 18; i++) {
      const a = rnd() * TAU;
      const r = 150 + rnd() * 260;
      const w = 0.6 + rnd() * 2.6;
      dummy.position.set(Math.cos(a) * r, 300, Math.sin(a) * r);
      dummy.rotation.set(0, rnd() * 3, 0);
      dummy.scale.set(w, 700, w);
      dummy.updateMatrix();
      pil.setMatrixAt(i, dummy.matrix);
    }
    pil.instanceMatrix.needsUpdate = true;
    pil.frustumCulled = false;
    G.add(pil);
    // ---------- dust / speed streaks (wraps around the camera) ----------
    const bg = new THREE.BoxGeometry(1, 1, 1);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = bg.index;
    ig.setAttribute('position', bg.attributes.position);
    const DN = 520;
    const off = new Float32Array(DN * 3);
    for (let i = 0; i < off.length; i++) off[i] = rnd();
    ig.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
    ig.instanceCount = DN;
    const dust = new THREE.Mesh(
      ig,
      new THREE.ShaderMaterial({
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        uniforms: u,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    dust.frustumCulled = false;
    G.add(dust);
  }
  private drawSecret(reveal: number, time: number) {
    const g = this.secretCtx;
    const word = WORLD.secret;
    g.clearRect(0, 0, 1024, 256);
    g.font = `bold 168px ${MONO_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const pool = '#?%:(0x█▓▒░/\\=+*&';
    const order = [3, 0, 5, 1, 6, 2, 4];
    let locked = 0;
    for (let i = 0; i < word.length; i++) {
      const isLocked = reveal > (order[i] + 1) / 8;
      if (isLocked) locked++;
      const ch = isLocked ? word[i] : pool[Math.floor(hash1(i * 7.7 + Math.floor(time * 11) * 3.3) * pool.length)];
      g.fillStyle = isLocked ? '#ffffff' : 'rgba(255,255,255,0.5)';
      const jy = isLocked ? 0 : (hash1(i * 3.1 + Math.floor(time * 11)) - 0.5) * 26;
      g.fillText(ch, 512 + (i - 3) * 132, 132 + jy);
    }
    this.secretTex.needsUpdate = true;
    this.secretLocked = locked;
  }
  /** soft collision against the world boundary, monoliths and the tower */
  collide(p: THREE.Vector3) {
    const r = Math.hypot(p.x, p.z);
    if (r > WORLD.radius) {
      p.x *= WORLD.radius / r;
      p.z *= WORLD.radius / r;
    }
    for (const c of this.colliders) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      const rr = c.r + 0.55;
      if (d < rr && d > 1e-5) {
        p.x = c.x + (dx / d) * rr;
        p.z = c.z + (dz / d) * rr;
      }
    }
  }
  triggerAnomaly(strength: number) {
    this.anomaly = Math.max(this.anomaly, strength);
    this.onAnomaly?.(strength);
  }
  reset() {
    const u = this.u;
    u.uCollapseT.value = 0;
    u.uHole.value.set(0, 0, 1e5);
    u.uHoleR.value = 0;
    u.uCrackLen.value = 0;
    u.uSkyBreak.value = 0;
    u.uSkyDark.value = 0;
    u.uStretch.value = 0;
    u.uGlitch.value = 0;
    u.uBeam.value = 1;
    u.uOffset.value.set(0, 0, 0);
    u.uFogColor.value.set('#3f93ea');
    u.uFogNear.value = 26;
    u.uFogFar.value = 430;
    this.group.position.set(0, 0, 0);
    for (const s of this.slabs) {
      s.mesh.position.copy(s.pos);
      s.mesh.rotation.copy(s.rot);
    }
    this.timeScale = 1;
    this.anomaly = 0;
    this.nextAnomaly = 16;
    this.sky.visible = true;
    this.reveal = 0;
    this.secretSeen = false;
    this.secretDrawn = -1;
  }
  update(dt: number, camLocal: THREE.Vector3, exploring: boolean) {
    const u = this.u;
    this.time += dt * this.timeScale;
    const t = this.time;
    u.uTime.value = t;
    u.uCamLocal.value.copy(camLocal);
    u.uOffset.value.copy(this.group.position);
    this.sky.position.copy(camLocal);
    const ts = this.timeScale;
    this.rings[0].rotation.z += dt * 0.08 * ts;
    this.rings[1].rotation.z -= dt * 0.13 * ts;
    this.rings[2].rotation.z += dt * 0.04 * ts;
    this.core.rotation.y += dt * 0.7 * ts;
    this.core.rotation.x += dt * 0.31 * ts;
    this.core.position.y = 2.9 + Math.sin(t * 0.9) * 0.25;
    for (let i = 0; i < this.cubes.length; i++) {
      const c = this.cubes[i];
      c.rotation.y += dt * (0.1 + i * 0.03) * ts;
      c.rotation.x += dt * 0.05 * ts;
    }
    // calm ... then, rarely, the world hiccups
    if (exploring) {
      this.nextAnomaly -= dt;
      if (this.nextAnomaly <= 0) {
        this.nextAnomaly = 17 + Math.random() * 20;
        this.triggerAnomaly(0.55 + Math.random() * 0.45);
        // the colossi all turn their faces a little further toward you
        for (const tt of this.totems) tt.rotation.y += (Math.random() - 0.5) * 0.5;
      }
    }
    this.anomaly = Math.max(0, this.anomaly - dt * 1.1);
    u.uGlitch.value = this.anomaly > 0.05 ? this.anomaly : 0;
    if (u.uSkyBreak.value < 0.2) u.uSkyBreak.value = this.anomaly * 0.18;
    // the secret decodes itself as you approach the tower
    const dist = Math.hypot(camLocal.x, camLocal.z);
    const target = 1 - smooth(22, 78, dist);
    this.reveal += clamp(target - this.reveal, -dt * 0.8, dt * 0.45);
    const frame = Math.floor(t * 11);
    const full = this.reveal > 0.9;
    if (!(full && this.secretLocked === WORLD.secret.length) && frame !== this.secretDrawn) {
      this.secretDrawn = frame;
      this.drawSecret(this.reveal, t);
    }
    if (full && !this.secretSeen && exploring) {
      this.secretSeen = true;
      this.onReveal?.();
    }
    const pulse = full ? 1.0 + 0.25 * Math.sin(t * 1.7) : 0.8;
    this.secretMat.color.setRGB(1.5 * pulse, 1.6 * pulse, 1.8 * pulse);
  }
}
