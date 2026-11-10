import * as THREE from 'three';
import type { Engine } from './Engine';
import { WORLD, terrainHeight } from './world';
import { Spring, TAU, clamp, fnoise, lerp, lookAngles, mulberry, smooth, stepNoise, wrapAngle } from './utils';
const PATCH_R = 12.4;
const FALL_T = 8.3;
const FALL_START = 7.0;
const CRACK_AT = 4.4;
const SHATTER_AT = 5.6;
const PATCH_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aRnd;
attribute float aFace;
uniform float uT;
uniform float uFallT;
varying vec3 vP0;
varying float vFace;
varying float vDist;
varying float vCrack;
void main() {
  vec3 p = position - aCenter;
  float ct = clamp((uT - aRnd.w) * 3.0, 0.0, 1.0);
  float ft = max(0.0, uFallT - aRnd.x);
  vec3 a = normalize(vec3(cos(aRnd.z * 6.283), 0.15, sin(aRnd.z * 6.283)));
  float ang = ct * (aRnd.y - 0.5) * 0.2 + ft * (aRnd.y - 0.5) * 3.2;
  p *= 1.0 - ct * 0.05;
  p = p * cos(ang) + cross(a, p) * sin(ang) + a * dot(a, p) * (1.0 - cos(ang));
  vec3 wp = aCenter + p;
  wp.y += ct * (aRnd.z - 0.5) * 0.18 - 28.0 * (ft - 2.0 * (1.0 - exp(-ft / 2.0)));
  vP0 = position;
  vFace = aFace;
  vCrack = ct;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const PATCH_FRAG = /* glsl */ `
uniform sampler2D tText;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vP0;
varying float vFace;
varying float vDist;
varying float vCrack;
void main() {
  vec3 col;
  vec2 p = vP0.xz;
  vec2 g4 = abs(fract(p / 4.0 - 0.5) - 0.5) / fwidth(p / 4.0);
  float line = 1.0 - min(min(g4.x, g4.y), 1.0);
  vec2 g1 = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  float line1 = 1.0 - min(min(g1.x, g1.y), 1.0);
  if (vFace < 0.5) {
    float r = length(p);
    float tBig = texture2D(tText, p * 0.0065).r;
    float tSmall = texture2D(tText, p * 0.045 + 0.3).r;
    col = mix(vec3(0.0, 0.06, 0.34), vec3(0.0, 0.19, 0.68), 0.9 * (0.55 + 0.45 * smoothstep(-3.0, 4.0, vP0.y)));
    float ringD = (0.5 - abs(fract(r / 3.5) - 0.5)) * 3.5;
    float rings = (1.0 - smoothstep(0.04, 0.1, ringD)) * (1.0 - smoothstep(30.0, 42.0, r));
    col += vec3(0.75, 0.88, 1.0) * (line * 0.42 + line1 * 0.15 + tBig * 0.09 + tSmall * 0.2 + rings * 0.55);
  } else if (vFace < 1.5) {
    col = vec3(0.7, 0.88, 1.0) * (0.5 + 1.6 * vCrack);
  } else {
    col = vec3(0.0, 0.03, 0.14) + vec3(0.5, 0.75, 1.0) * line * 0.5;
  }
  gl_FragColor = vec4(mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vDist)), 1.0);
}`;
const HALO_FRAG = /* glsl */ `
uniform float uK;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  vec3 c = vec3(1.0, 0.7, 0.42) * exp(-r * 5.0) * 1.2 + vec3(0.15, 0.45, 1.0) * exp(-r * 2.2) * 0.3;
  gl_FragColor = vec4(c * uK * (1.0 - smoothstep(0.8, 1.0, r)), 1.0);
}`;
const UV_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
type Stage = 'panic' | 'fall' | 'wake';
interface Falling {
  obj: THREE.Object3D;
  v: THREE.Vector3;
  w: THREE.Vector3;
  at: number;
}
/**
 * WAKE_UP: the world breaks, the ground goes, you fall out of it and land in your room.
 * Fully scripted first-person camera; every rotation goes through springs so the
 * head has weight, reaction delay and overshoot instead of keyframed turns.
 */
export class Collapse {
  active = false;
  private e: Engine;
  private stage: Stage = 'panic';
  private t = 0;
  private st = 0;
  private ev = 0;
  private events: [number, () => void][] = [];
  private yawS = new Spring(0, 2, 0.6);
  private pitchS = new Spring(0, 2, 0.6);
  private rollS = new Spring(0, 2, 0.6);
  private yS = new Spring(0, 3, 0.5);
  private swayS = new Spring(0, 1.6, 0.6);
  private local = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private fwd = new THREE.Vector2();
  private crackDir = new THREE.Vector2();
  private yawC = 0;
  private back = 0;
  private fallDist = 0;
  private fallen = 0;
  private fallTop = 0;
  private drift = new THREE.Vector2();
  private roomShown = false;
  private falling: Falling[] = [];
  private patch: THREE.Mesh | null = null;
  private patchU: Record<string, THREE.IUniform>;
  private glow: THREE.Mesh;
  private fallSet = new THREE.Group();
  private rings: THREE.Mesh[] = [];
  private slabs: THREE.InstancedMesh;
  private halo: THREE.Mesh;
  private haloU = { uK: { value: 0 } };
  private envC = new THREE.Color();
  private cA = new THREE.Color('#3f93ea');
  private cB = new THREE.Color('#0b2f7c');
  private cC = new THREE.Color('#04060b');
  private dummy = new THREE.Object3D();
  private yawDesk = 0;
  private lookedAtCrack = false;
  constructor(engine: Engine) {
    this.e = engine;
    const wu = engine.world.u;
    this.patchU = {
      uT: { value: 0 },
      uFallT: { value: 0 },
      tText: wu.tText,
      uFogColor: wu.uFogColor,
      uFogNear: wu.uFogNear,
      uFogFar: wu.uFogFar,
    };
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(PATCH_R + 1.5, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.8, 2.4), transparent: true, opacity: 0, fog: false, depthWrite: false })
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.visible = false;
    engine.world.group.add(this.glow);
    // things you fall past: rings of light and slabs hanging in the void
    const ringGeo = new THREE.TorusGeometry(1, 0.012, 6, 72);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.55, 2.2) });
    for (let i = 0; i < 16; i++) {
      const r = new THREE.Mesh(ringGeo, ringMat);
      r.frustumCulled = false;
      this.fallSet.add(r);
      this.rings.push(r);
    }
    this.slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), engine.world.towerMat, 80);
    this.slabs.frustumCulled = false;
    this.fallSet.add(this.slabs);
    this.halo = new THREE.Mesh(
      new THREE.CircleGeometry(20, 48),
      new THREE.ShaderMaterial({
        vertexShader: UV_VERT,
        fragmentShader: HALO_FRAG,
        uniforms: this.haloU,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = -0.04;
    this.fallSet.add(this.halo);
    this.fallSet.visible = false;
    engine.scene.add(this.fallSet);
  }
  private buildPatch(cx: number, cz: number) {
    const rnd = mulberry(Math.floor(cx * 31 + cz * 17) + 99);
    const radii = [1.05, 2.3, 3.9, 5.9, 8.5, PATCH_R];
    const N = 14;
    const pts = radii.map((r, j) =>
      Array.from({ length: N }, (_, i) => {
        const last = j === radii.length - 1;
        const a = ((i + (j % 2) * 0.5 + (rnd() - 0.5) * 0.5) / N) * TAU;
        const rr = r * (last ? 1 + rnd() * 0.06 : 0.88 + rnd() * 0.24);
        return new THREE.Vector2(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr);
      })
    );
    const pos: number[] = [];
    const cen: number[] = [];
    const rn: number[] = [];
    const face: number[] = [];
    const ca = Math.atan2(this.crackDir.y, this.crackDir.x);
    const addShard = (poly: THREE.Vector2[], isCenter = false) => {
      let mx = 0;
      let mz = 0;
      for (const p of poly) {
        mx += p.x;
        mz += p.y;
      }
      mx /= poly.length;
      mz /= poly.length;
      const th = 0.35 + rnd() * 0.35;
      const top = poly.map((p) => new THREE.Vector3(p.x, terrainHeight(p.x, p.y) + 0.02, p.y));
      const cy = terrainHeight(mx, mz) - th / 2;
      const r = Math.hypot(mx - cx, mz - cz);
      const da = Math.abs(wrapAngle(Math.atan2(mz - cz, mx - cx) - ca));
      const crackTime = isCenter ? 0 : (r / PATCH_R) * 0.5 + (da / Math.PI) * 1.1;
      const fallDelay = isCenter
        ? FALL_START - SHATTER_AT
        : Math.min(1.3, 1.3 * lerp(Math.pow(1 - r / (PATCH_R * 1.07), 0.8), 1, smooth(0, Math.PI, da) * 0.55));
      const r1 = rnd();
      const r2 = rnd();
      const push = (v: THREE.Vector3, f: number, dy = 0) => {
        pos.push(v.x, v.y + dy, v.z);
        cen.push(mx, cy, mz);
        rn.push(fallDelay, r1, r2, crackTime);
        face.push(f);
      };
      const n = top.length;
      const mid = new THREE.Vector3(mx, terrainHeight(mx, mz) + 0.02, mz);
      for (let i = 0; i < n; i++) {
        const a = top[i];
        const b = top[(i + 1) % n];
        push(mid, 0);
        push(a, 0);
        push(b, 0);
        push(mid, 2, -th);
        push(b, 2, -th);
        push(a, 2, -th);
        push(a, 1);
        push(b, 1);
        push(b, 1, -th);
        push(a, 1);
        push(b, 1, -th);
        push(a, 1, -th);
      }
    };
    addShard(pts[0], true);
    for (let j = 0; j < radii.length - 1; j++) {
      for (let i = 0; i < N; i++) {
        const A = pts[j][i];
        const B = pts[j][(i + 1) % N];
        const C = pts[j + 1][(i + 1) % N];
        const D = pts[j + 1][i];
        if (j >= 2) {
          if ((i + j) % 2) {
            addShard([A, B, C]);
            addShard([A, C, D]);
          } else {
            addShard([A, B, D]);
            addShard([B, C, D]);
          }
        } else addShard([A, B, C, D]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCenter', new THREE.Float32BufferAttribute(cen, 3));
    g.setAttribute('aRnd', new THREE.Float32BufferAttribute(rn, 4));
    g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 1));
    if (this.patch) {
      this.patch.geometry.dispose();
      this.patch.geometry = g;
    } else {
      this.patch = new THREE.Mesh(
        g,
        new THREE.ShaderMaterial({ vertexShader: PATCH_VERT, fragmentShader: PATCH_FRAG, uniforms: this.patchU, side: THREE.DoubleSide })
      );
      this.patch.frustumCulled = false;
      this.e.world.group.add(this.patch);
    }
    this.patch.visible = false;
  }
  private speedAt(tf: number) {
    const v = 58 * (1 - Math.exp(-tf / 1.6));
    if (tf < 6.6) return v;
    return lerp(58 * (1 - Math.exp(-6.6 / 1.6)), 21, smooth(6.6, FALL_T, tf));
  }
  begin() {
    const e = this.e;
    const w = e.world;
    this.active = true;
    this.stage = 'panic';
    this.t = 0;
    this.st = 0;
    this.ev = 0;
    this.back = 0;
    this.fallen = 0;
    this.roomShown = false;
    this.lookedAtCrack = false;
    this.falling = [];
    this.origin.copy(e.player.pos);
    const yaw0 = e.player.yaw;
    this.fwd.set(-Math.sin(yaw0), -Math.cos(yaw0));
    const toC = new THREE.Vector2(-this.origin.x, -this.origin.z);
    if (toC.length() > 10) this.crackDir.copy(toC).normalize();
    else this.crackDir.copy(this.fwd);
    this.yawC = yaw0 + wrapAngle(Math.atan2(-this.crackDir.x, -this.crackDir.y) - yaw0);
    this.yawS.set(yaw0);
    this.pitchS.set(e.player.pitch);
    this.rollS.set(0);
    this.yS.set(0);
    this.swayS.set(0);
    this.buildPatch(this.origin.x, this.origin.z);
    this.patchU.uT.value = 0;
    this.patchU.uFallT.value = 0;
    this.glow.position.set(this.origin.x, terrainHeight(this.origin.x, this.origin.z) - 1.0, this.origin.z);
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0;
    w.u.uHole.value.set(this.origin.x, 0, this.origin.z);
    w.u.uCrackDir.value.copy(this.crackDir);
    // total fall distance (numerically integrated speed profile)
    let d = 0;
    for (let t = 0; t < FALL_T; t += 1 / 240) d += this.speedAt(t) / 240;
    this.fallDist = d;
    // lay out the void between the world and the room
    const land = e.room.landPos;
    const rnd = mulberry(5150);
    this.rings.forEach((r, i) => {
      const rad = 12 + rnd() * 30;
      r.scale.set(rad, rad, rad * (20 + rnd() * 60));
      r.position.set(land.x + (rnd() - 0.5) * 12, 45 + (i * (d - 95)) / 15, land.z + (rnd() - 0.5) * 12);
      r.rotation.set(Math.PI / 2 + (rnd() - 0.5) * 0.5, 0, (rnd() - 0.5) * 0.5);
    });
    for (let i = 0; i < 80; i++) {
      const a = rnd() * TAU;
      const rr = 13 + rnd() * rnd() * 90;
      this.dummy.position.set(land.x + Math.cos(a) * rr, 30 + rnd() * (d - 70), land.z + Math.sin(a) * rr);
      this.dummy.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      this.dummy.scale.set(1.5 + rnd() * 7, 3 + rnd() * rnd() * 34, 1.5 + rnd() * 7);
      this.dummy.updateMatrix();
      this.slabs.setMatrixAt(i, this.dummy.matrix);
    }
    this.slabs.instanceMatrix.needsUpdate = true;
    this.haloU.uK.value = 0;
    const A = e.audio;
    const yawTo = (dy: number, f: number, z: number) => this.yawS.to(dy, f, z);
    this.events = [
      [
        0,
        () => {
          // everything stops. even the air.
          A.setWorld(0, 0.04);
          w.timeScale = 0;
          w.anomaly = 0;
        },
      ],
      [1.0, () => e.closeConsole(true)],
      [
        1.25,
        () => {
          A.crack(-0.9, 0.55);
          e.addTrauma(0.3);
          w.u.uSkyBreak.value = 0.3;
          w.timeScale = 1;
        },
      ],
      [
        1.37,
        () => {
          // reaction delay, then the head whips left (overshoots, settles)
          yawTo(yaw0 + 1.15, 2.7, 0.52);
          this.pitchS.to(0.07, 2.4, 0.6);
          this.swayS.to(0.1, 1.6, 0.6);
        },
      ],
      [
        2.05,
        () => {
          A.crack(0.9, 0.75);
          A.boom(0.3);
          e.addTrauma(0.4);
          w.u.uSkyBreak.value = 0.5;
          w.triggerAnomaly(0.6);
        },
      ],
      [
        2.15,
        () => {
          yawTo(yaw0 - 1.35, 3.1, 0.5);
          this.pitchS.to(-0.05, 2.6, 0.6);
          this.swayS.to(-0.12, 1.8, 0.6);
        },
      ],
      [
        2.8,
        () => {
          A.boom(0.6);
          A.crack(0, 0.5);
          e.addTrauma(0.45);
          yawTo(this.yawC, 3.0, 0.58);
          this.pitchS.to(0.24, 2.6, 0.6);
          this.swayS.to(0, 1.4, 0.7);
        },
      ],
      [3.5, () => A.setRumble(0.45)],
      [
        3.9,
        () => {
          // a held breath — then the eyes go down, slowly, not wanting to know
          this.pitchS.to(-1.15, 1.45, 0.8);
        },
      ],
      [
        CRACK_AT,
        () => {
          A.crack(0, 1);
          e.addTrauma(0.55);
          this.yS.kick(-0.5);
          w.u.uHoleR.value = PATCH_R - 0.8;
          this.patch!.visible = true;
          this.glow.visible = true;
        },
      ],
      [
        SHATTER_AT,
        () => {
          A.boom(0.9);
          A.crack(0.3, 0.8);
          this.startTower();
        },
      ],
      [
        5.85,
        () => {
          // the ground drops a hand's width. the stomach follows.
          A.crack(-0.3, 1);
          A.setRumble(1);
          e.addTrauma(0.7);
          this.yS.kick(-2.6);
          this.yS.to(-0.22, 2.2, 0.45);
          this.rollS.kick(1.4);
          this.pitchS.to(-1.25, 3.4, 0.6);
          w.u.uSkyBreak.value = 0.8;
        },
      ],
      [
        6.3,
        () => {
          // run — backwards, half turning, nowhere to go
          yawTo(this.yawC + 2.3, 2.0, 0.7);
          this.pitchS.to(-0.5, 2.1, 0.7);
          this.rollS.to(-0.1, 1.5, 0.6);
        },
      ],
    ];
  }
  private startTower() {
    const w = this.e.world;
    const hole = this.origin;
    const rnd = mulberry(31);
    const add = (obj: THREE.Object3D, at: number) => {
      const v = new THREE.Vector3((hole.x - obj.position.x) * 0.16, 0, (hole.z - obj.position.z) * 0.16);
      v.x += (rnd() - 0.5) * 3;
      v.z += (rnd() - 0.5) * 3;
      this.falling.push({ obj, v, w: new THREE.Vector3((rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.7), at });
    };
    w.slabs.forEach((s, i) => add(s.mesh, this.t + 0.15 + i * 0.13));
    w.gates.forEach((g, i) => add(g, this.t + 0.6 + i * 0.25));
    add(w.core, this.t + 0.1);
    w.rings.forEach((r, i) => add(r, this.t + 1.2 + i * 0.3));
  }
  /** returns true once the player is standing in the room again */
  update(dt: number): boolean {
    const e = this.e;
    const w = e.world;
    const post = e.post.params;
    this.t += dt;
    this.st += dt;
    const T = this.t;
    while (this.ev < this.events.length && T >= this.events[this.ev][0]) this.events[this.ev++][1]();
    this.yawS.step(dt);
    this.pitchS.step(dt);
    this.rollS.step(dt);
    this.yS.step(dt);
    this.swayS.step(dt);
    // world destruction that runs regardless of stage
    if (this.stage !== 'wake') {
      if (T > 2.8) w.u.uBeam.value = Math.max(0, 1 - (T - 2.8) * 2.2) * (stepNoise(T, 18, 3) > 0.45 ? 1 : 0.15);
      this.patchU.uT.value = Math.max(0, T - CRACK_AT);
      this.patchU.uFallT.value = Math.max(0, T - SHATTER_AT);
      w.u.uCrackLen.value = T > CRACK_AT ? 170 * Math.pow(clamp((T - CRACK_AT) / 1.3), 2) : 0;
      (this.glow.material as THREE.MeshBasicMaterial).opacity = smooth(CRACK_AT, CRACK_AT + 0.5, T) * (1 - smooth(SHATTER_AT + 0.3, FALL_START, T));
      for (const f of this.falling) {
        if (T < f.at) continue;
        f.v.y = Math.max(-34, f.v.y - 13 * dt);
        f.obj.position.addScaledVector(f.v, dt);
        f.obj.rotation.x += f.w.x * dt;
        f.obj.rotation.y += f.w.y * dt;
        f.obj.rotation.z += f.w.z * dt;
      }
    }
    let yaw = this.yawS.x;
    let pitch = this.pitchS.x;
    let roll = this.rollS.x;
    const pos = e.camera.position;
    if (this.stage === 'panic') {
      const fear = smooth(1.2, 6.5, T);
      // the eyes follow the crack as it runs away from the feet
      if (T > CRACK_AT + 0.12 && T < 5.8) {
        this.lookedAtCrack = true;
        const tip = Math.min(70, 170 * Math.pow(clamp((T - CRACK_AT - 0.1) / 1.3), 2));
        this.pitchS.to(-Math.atan2(WORLD.eye, Math.max(1.1, tip)), 2.3, 0.75);
        this.yawS.to(this.yawC + fnoise(tip * 0.2, 3) * 0.12, 2.3, 0.75);
      }
      // stumbling backwards
      if (T > 6.3) {
        const k = clamp((T - 6.3) / 0.7);
        this.back = 1.5 * (1 - Math.pow(1 - k, 2));
      }
      const bx = this.origin.x - this.crackDir.x * this.back + -this.crackDir.y * this.swayS.x;
      const bz = this.origin.z - this.crackDir.y * this.back + this.crackDir.x * this.swayS.x;
      const stepBob = T > 6.3 ? Math.abs(Math.sin((T - 6.3) * 9)) * 0.09 : 0;
      this.local.set(bx, terrainHeight(bx, bz) + WORLD.eye + this.yS.x - stepBob + fnoise(T * 14, 4) * 0.012 * fear, bz);
      pos.copy(this.local).add(w.group.position);
      const tremor = 0.004 + fear * 0.016;
      yaw += fnoise(T * 9, 1) * tremor + fnoise(T * 0.9, 5) * 0.012;
      pitch += fnoise(T * 10, 2) * tremor + Math.sin(T * 2.4) * 0.006 * (1 + fear * 2);
      roll += fnoise(T * 6, 7) * tremor * 1.5;
      e.fov = lerp(e.fov, 72 + fear * 6, clamp(dt * 3));
      post.sat = lerp(post.sat, T < 1.25 ? 0.55 : 1, clamp(dt * 4));
      post.aberr = 0.0018 + fear * 0.006;
      post.glitch = Math.max(w.anomaly * 0.7, Math.max(0, fnoise(T * 7, 9) - 0.5) * fear * 1.6);
      post.vignette = 0.6 + fear * 0.3;
      post.grain = 0.04 + fear * 0.04;
      w.u.uCollapseT.value = 0;
      if (T >= FALL_START) this.startFall();
    } else if (this.stage === 'fall') {
      const tf = this.st;
      const v = this.speedAt(tf);
      this.fallen += v * dt;
      const k = clamp(tf / FALL_T);
      const end = smooth(0.7, 1, k);
      const camY = Math.max(0.2, this.fallTop - this.fallen);
      const land = e.room.landPos;
      const wob = (1 - end) * 1.6;
      pos.set(
        land.x + this.drift.x * (1 - smooth(0, 0.6, k)) + fnoise(tf * 0.7, 11) * wob,
        camY,
        land.z + this.drift.y * (1 - smooth(0, 0.6, k)) + fnoise(tf * 0.8, 12) * wob
      );
      w.u.uCollapseT.value = tf + 0.01;
      w.u.uStretch.value = v * 0.09;
      w.u.uSkyBreak.value = 0.8 + 0.2 * Math.sin(tf * 3);
      w.u.uSkyDark.value = smooth(2.5, 6.2, tf);
      // fog: bright world blue -> abyss -> the dark of a bedroom
      if (tf < 4) this.envC.copy(this.cA).lerp(this.cB, smooth(0.3, 3.6, tf));
      else this.envC.copy(this.cB).lerp(this.cC, smooth(4.4, 7.3, tf));
      w.u.uFogColor.value.copy(this.envC);
      w.u.uFogFar.value = lerp(430, 250, smooth(0.5, 3, tf)) - smooth(7.2, FALL_T, tf) * 150;
      w.u.uFogNear.value = lerp(26, 12, smooth(0.5, 3, tf));
      e.setEnv(this.envC, w.u.uFogNear.value, w.u.uFogFar.value);
      if (!this.roomShown && camY < 170) {
        this.roomShown = true;
        e.prepareReturnRoom();
      }
      this.haloU.uK.value = smooth(170, 60, camY) * (1 - smooth(6, 0.5, camY) * 0.0);
      // tumbling, buffeted
      const buff = (1 - end * 0.7) * (0.02 + 0.05 * smooth(0, 2, tf));
      yaw += fnoise(tf * 2.1, 1) * buff * 2 + fnoise(tf * 11, 5) * 0.012;
      pitch += fnoise(tf * 2.4, 2) * buff + fnoise(tf * 12, 6) * 0.012;
      roll += fnoise(tf * 1.7, 3) * buff * 3;
      e.fov = lerp(e.fov, 86 + smooth(0, 2, tf) * 16 - end * 14, clamp(dt * 3));
      post.aberr = 0.004 + 0.008 * smooth(0, 2, tf);
      post.blur = 0.25 * smooth(0, 2, tf) * (1 - end * 0.6);
      post.cx = 0.5;
      post.cy = 0.5;
      post.glitch = Math.max(0, fnoise(tf * 5, 9) - 0.42) * 1.5 * (1 - end);
      post.vignette = 0.9;
      post.sat = 1;
      e.audio.setWind(clamp(v / 50), 0.3 + 0.7 * clamp(v / 58));
      e.audio.setRumble(Math.max(0, 1 - tf * 0.5));
      if (tf >= FALL_T || this.fallTop - this.fallen <= 0.2) this.impact();
    } else {
      // ---------------- waking up on the floor ----------------
      const tw = this.st;
      const land = e.room.landPos;
      const sway = smooth(2.4, 4.4, tw) * (1 - smooth(5.2, 6.2, tw));
      pos.set(
        land.x + Math.sin(tw * 1.1) * 0.05 * sway,
        this.yS.x + Math.sin(tw * 1.9) * 0.012,
        land.z + 0.25 * (1 - smooth(2.6, 5, tw)) + Math.cos(tw * 0.9) * 0.04 * sway
      );
      yaw += Math.sin(tw * 0.8) * 0.03 * (1 + sway);
      pitch += Math.sin(tw * 1.3) * 0.015 + fnoise(tw * 3, 4) * 0.01;
      roll += Math.sin(tw * 1.0) * 0.03 * sway;
      // black -> heavy eyelids -> a slow blink -> the room
      post.fade = 1 - smooth(0.6, 1.0, tw);
      let lid = 1 - 0.55 * smooth(0.8, 1.9, tw);
      lid = Math.max(lid * (1 - smooth(2.25, 3.3, tw)), smooth(1.95, 2.15, tw) * (1 - smooth(2.2, 2.45, tw)));
      post.lid = lid;
      post.blur = 0.9 * (1 - smooth(1, 5.5, tw));
      post.aberr = 0.012 * (1 - smooth(1, 5.5, tw)) + 0.0018;
      post.glitch = tw > 1.2 && tw < 1.35 ? 0.5 : 0;
      post.vignette = lerp(1.1, 0.85, smooth(2, 6, tw));
      post.sat = lerp(0.5, 1, smooth(1, 5, tw));
      e.fov = lerp(60, 72, smooth(0.5, 5.5, tw));
      if (tw > 6.3) {
        e.player.pos.set(pos.x, 0, pos.z);
        e.player.yaw = wrapAngle(this.yawS.x);
        e.player.pitch = this.pitchS.x;
        e.camRoll = 0;
        e.fov = 72;
        post.fade = 0;
        post.lid = 0;
        post.blur = 0;
        this.active = false;
        return true;
      }
    }
    e.camera.rotation.set(pitch, yaw, roll, 'YXZ');
    return false;
  }
  private startFall() {
    const e = this.e;
    const w = e.world;
    this.stage = 'fall';
    this.st = 0;
    this.ev = 0;
    this.fallen = 0;
    // slide the whole world sideways/upwards so that "down" ends in the bedroom
    const land = e.room.landPos;
    this.drift.set(0, 0);
    this.fallTop = this.fallDist + 0.2;
    w.group.position.set(land.x - this.local.x, this.fallTop - this.local.y, land.z - this.local.z);
    w.group.updateMatrixWorld(true);
    w.u.uOffset.value.copy(w.group.position);
    this.fallSet.visible = true;
    e.camera.far = 3200;
    e.camera.updateProjectionMatrix();
    e.audio.shatter();
    e.audio.fallTone(FALL_T);
    e.addTrauma(1);
    const y = this.yawS.x;
    this.events = [
      [
        FALL_START,
        () => {
          this.pitchS.to(-1.3, 3, 0.6);
          this.rollS.to(0.28, 1.4, 0.6);
        },
      ],
      [
        FALL_START + 0.45,
        () => {
          // rolling onto the back: the hole, the light, the world you fell out of
          this.pitchS.to(1.22, 1.15, 0.72);
          this.rollS.to(-0.38, 0.8, 0.7);
          this.yawS.to(y + 0.7, 0.6, 0.9);
        },
      ],
      [
        FALL_START + 3.1,
        () => {
          // turning over to face what is coming
          this.yawS.to(y + 2.9, 0.5, 0.85);
          this.pitchS.to(-1.36, 0.72, 0.8);
          this.rollS.to(0.22, 0.6, 0.8);
        },
      ],
      [
        FALL_START + 6.3,
        () => {
          this.rollS.to(0, 1, 0.8);
          this.pitchS.to(-1.47, 1.6, 0.9);
          this.yawS.to(this.yawS.x + wrapAngle(this.yawDeskTarget() - this.yawS.x), 0.9, 0.9);
        },
      ],
    ];
  }
  private yawDeskTarget() {
    const e = this.e;
    const land = e.room.landPos;
    const s = e.room.screenCenter;
    this.yawDesk = lookAngles(land.x, 0, land.z, s.x, 0, s.z).yaw;
    return this.yawDesk;
  }
  private impact() {
    const e = this.e;
    const w = e.world;
    this.stage = 'wake';
    this.st = 0;
    this.ev = 0;
    e.audio.impact();
    e.audio.setWind(0, 0);
    e.audio.setRumble(0);
    e.audio.setRoom(1, 2.5);
    e.showWorld(false);
    this.fallSet.visible = false;
    if (this.patch) this.patch.visible = false;
    this.glow.visible = false;
    e.finishReturnRoom();
    e.addTrauma(1);
    const post = e.post.params;
    post.fade = 1;
    post.flash = 0;
    post.warp = 0;
    w.u.uStretch.value = 0;
    // lying on your side on the floor, cheek to the boards, facing the desk
    const yd = this.yawDeskTarget();
    this.yawS.set(yd + 0.35);
    this.pitchS.set(0.12);
    this.rollS.set(1.32);
    this.yS.set(0.17);
    this.rollS.kick(-1.2);
    const mon = lookAngles(e.room.landPos.x, 1.62, e.room.landPos.z, e.room.screenCenter.x, e.room.screenCenter.y, e.room.screenCenter.z);
    this.events = [
      [
        2.7,
        () => {
          // pushing up on one arm
          this.yS.to(0.88, 0.55, 0.72);
          this.rollS.to(0.3, 0.55, 0.8);
          this.pitchS.to(-0.55, 0.7, 0.8);
          this.yawS.to(yd + 0.15, 0.6, 0.8);
          e.audio.chairCreak();
        },
      ],
      [
        4.3,
        () => {
          // standing; the eyes go straight to the monitor
          this.yS.to(1.62, 0.6, 0.8);
          this.rollS.to(0, 0.7, 0.8);
          this.pitchS.to(mon.pitch, 0.75, 0.85);
          this.yawS.to(mon.yaw, 0.75, 0.85);
          e.audio.step('room', 0.8);
        },
      ],
      [5.0, () => e.audio.step('room', 0.6)],
    ];
    // events for the wake stage are timed on stage time
    this.t = 0;
  }
  reset() {
    this.active = false;
    this.fallSet.visible = false;
    if (this.patch) this.patch.visible = false;
    this.glow.visible = false;
    this.falling = [];
  }
  /** true once the gaze has followed the crack (used only for debugging/telemetry) */
  get sawCrack() {
    return this.lookedAtCrack;
  }
}
