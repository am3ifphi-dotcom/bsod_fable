import * as THREE from 'three';
import type { Engine } from './Engine';
import type { Tile } from './bsodScreen';
import { ROOM } from './room';
import { WORLD, groundHeight } from './world';
import { Spring, TAU, clamp, damp, fnoise, hash1, lerp, lookAngles, mulberry, smooth } from './utils';
const L = 150;
const TUNNEL_VERT = /* glsl */ `
uniform float uR;
uniform float uLen;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;
varying float vDist;
vec2 bend(float d) {
  float a = smoothstep(4.0, 40.0, d) * 5.0;
  return vec2(sin(d * 0.045 + 0.7) * a, sin(d * 0.031 + 2.1) * a * 0.7);
}
void main() {
  vUv = uv;
  float d = -position.z;
  float rad = uR * (1.0 + pow(d / uLen, 1.6) * 7.0);
  rad *= 1.0 + 0.1 * sin(d * 0.7 - uTime * 7.0) * smoothstep(0.0, 6.0, d);
  vec3 p = vec3(position.xy * rad + bend(d), position.z);
  vDepth = d;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const TUNNEL_FRAG = /* glsl */ `
uniform sampler2D tText;
uniform float uTime;
uniform float uLen;
uniform float uDissolve;
uniform vec3 uGlow;
varying vec2 vUv;
varying float vDepth;
varying float vDist;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float d = vDepth;
  float cell = h(floor(vec2(vUv.x * 28.0, d * 0.3)));
  if (cell < uDissolve * 1.6 - (1.0 - d / uLen) * 0.9) discard;
  float txt = texture2D(tText, vec2(vUv.x * 5.0, d * 0.035 - uTime * 0.25)).r;
  float pulse = smoothstep(0.9, 1.0, sin(d * 0.55 - uTime * 9.0));
  vec3 blue = vec3(0.0, 0.19, 0.68);
  vec3 col = mix(vec3(0.0, 0.004, 0.03), blue * 0.55, smoothstep(0.0, 22.0, d));
  col *= 0.65 + 0.35 * sin(d * 2.4 + sin(vUv.x * 18.85) * 0.8);
  col += blue * pulse * 0.8 + vec3(0.85, 0.93, 1.0) * txt * (0.2 + 0.9 * smoothstep(2.0, 26.0, d));
  col = mix(col, uGlow, 1.0 - exp(-vDist * 0.022));
  gl_FragColor = vec4(col, 1.0);
}`;
const EYE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const EYE_FRAG = /* glsl */ `
uniform vec2 uLook;
uniform float uOpen;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float lid = uOpen * sqrt(max(0.0, 1.0 - p.x * p.x));
  if (abs(p.y) > lid * 0.74 || length(p) > 1.0) discard;
  vec2 q = p - uLook * 0.45;
  float r = length(q);
  vec3 col = vec3(1.7, 1.8, 2.0);
  float a = atan(p.y, p.x);
  float v = smoothstep(0.9, 1.0, sin(a * 9.0 + sin(length(p) * 14.0 + uTime * 3.0) * 1.3)) * smoothstep(0.3, 1.0, length(p));
  col = mix(col, vec3(0.0, 0.25, 0.9), v * 0.75);
  col = mix(col, vec3(0.0, 0.3, 1.0), 1.0 - smoothstep(0.3, 0.34, r));
  col = mix(col, vec3(0.0), 1.0 - smoothstep(0.1, 0.13, r));
  gl_FragColor = vec4(col, 1.0);
}`;
function bend(d: number): [number, number] {
  const a = smooth(4, 40, d) * 5;
  return [Math.sin(d * 0.045 + 0.7) * a, Math.sin(d * 0.031 + 2.1) * a * 0.7];
}
interface Debris {
  o: THREE.Vector3;
  size: THREE.Vector3;
  release: number;
  dur: number;
  spin: number;
  axis: THREE.Vector3;
}
interface Flake {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  vr: THREE.Vector3;
  sx: number;
  sy: number;
  rest: boolean;
}
type Stage = 'struggle' | 'yank' | 'tunnel' | 'flight' | 'land';
/**
 * Being eaten by the monitor: room -> mouth -> throat -> the sky of the other world,
 * as one continuous camera move.
 */
export class Devour {
  group = new THREE.Group();
  active = false;
  private e: Engine;
  private tu = {
    uR: { value: 0.05 },
    uLen: { value: L },
    uTime: { value: 0 },
    uDissolve: { value: 0 },
    uGlow: { value: new THREE.Color('#3f93ea') },
    tText: { value: null as THREE.Texture | null },
  };
  private eyeU = [
    { uLook: { value: new THREE.Vector2() }, uOpen: { value: 0 }, uTime: { value: 0 } },
    { uLook: { value: new THREE.Vector2() }, uOpen: { value: 0 }, uTime: { value: 0 } },
  ];
  private tunnel: THREE.Mesh;
  private ring: THREE.Mesh;
  private teeth: THREE.InstancedMesh;
  private eyes: THREE.Mesh[] = [];
  private debris: THREE.InstancedMesh;
  private debrisData: Debris[] = [];
  private flakeMesh: THREE.InstancedMesh;
  private flakes: Flake[] = [];
  private dummy = new THREE.Object3D();
  private t = 0;
  private stage: Stage = 'struggle';
  private local = new THREE.Vector3();
  private start = new THREE.Vector3();
  private zYank = 0;
  private depth = 0;
  private speed = 0;
  private swapped = false;
  private bitten = false;
  private popped = false;
  private stageT = 0;
  private ev = 0;
  private recoil = new Spring(0, 3, 0.6);
  private yawS = new Spring(0, 2.5, 0.6);
  private pitchS = new Spring(0, 2.5, 0.6);
  private rollS = new Spring(0, 2, 0.6);
  private landS = new Spring(0, 2.2, 0.45);
  private flashV = 0;
  private dark = 0;
  private p0 = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private p2 = new THREE.Vector3();
  private p3 = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private vy = 0;
  private landed = false;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private envC = new THREE.Color();
  constructor(engine: Engine) {
    this.e = engine;
    this.tu.tText.value = engine.world.u.tText.value;
    const tg = new THREE.CylinderGeometry(1, 1, L, 40, 150, true);
    tg.rotateX(Math.PI / 2);
    tg.translate(0, 0, -L / 2);
    this.tunnel = new THREE.Mesh(
      tg,
      new THREE.ShaderMaterial({ vertexShader: TUNNEL_VERT, fragmentShader: TUNNEL_FRAG, uniforms: this.tu, side: THREE.BackSide })
    );
    this.tunnel.frustumCulled = false;
    this.group.add(this.tunnel);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.06, 10, 72),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.9, 2.5), fog: false })
    );
    this.ring.frustumCulled = false;
    this.group.add(this.ring);
    this.teeth = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.5, 1, 5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.1, 2.2, 2.4), fog: false }),
      30
    );
    this.teeth.frustumCulled = false;
    this.group.add(this.teeth);
    for (let i = 0; i < 2; i++) {
      const eye = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.ShaderMaterial({ vertexShader: EYE_VERT, fragmentShader: EYE_FRAG, uniforms: this.eyeU[i] })
      );
      eye.frustumCulled = false;
      this.group.add(eye);
      this.eyes.push(eye);
    }
    this.group.visible = false;
    // chunks of the room that get ripped off and swallowed
    const rnd = mulberry(4242);
    const N = 260;
    this.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ fog: false }), N);
    const portal = engine.room.screenCenter;
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const o = new THREE.Vector3();
      const s = rnd();
      if (s < 0.42) o.set((rnd() * 2 - 1) * ROOM.hw, rnd() * ROOM.h, -ROOM.hd + 0.02);
      else if (s < 0.6) o.set(-ROOM.hw + 0.02, rnd() * ROOM.h, (rnd() * 2 - 1) * ROOM.hd);
      else if (s < 0.74) o.set(ROOM.hw - 0.02, rnd() * ROOM.h, (rnd() * 2 - 1) * ROOM.hd);
      else if (s < 0.9) o.set((rnd() * 2 - 1) * ROOM.hw, 0.02, (rnd() * 2 - 1) * ROOM.hd);
      else o.set((rnd() * 2 - 1) * ROOM.hw, ROOM.h - 0.02, (rnd() * 2 - 1) * ROOM.hd);
      const dist = o.distanceTo(portal);
      this.debrisData.push({
        o,
        size: new THREE.Vector3(0.1 + rnd() * 0.3, 0.08 + rnd() * 0.26, 0.015 + rnd() * 0.03),
        release: 0.3 + dist * 0.33 + rnd() * 0.4,
        dur: 0.5 + rnd() * 0.35,
        spin: (rnd() - 0.5) * 16,
        axis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
      });
      const k = rnd();
      if (k < 0.4) col.setRGB(0.0, 0.2, 0.75);
      else if (k < 0.6) col.setRGB(1.6, 1.8, 2.1);
      else col.setRGB(0.25, 0.23, 0.2);
      this.debris.setColorAt(i, col);
    }
    this.debris.frustumCulled = false;
    this.debris.visible = false;
    engine.room.group.add(this.debris);
    // flakes of the picture that peel off the monitor before it opens
    this.flakeMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0, 0.32, 1.15), side: THREE.DoubleSide, fog: false }),
      48
    );
    this.flakeMesh.frustumCulled = false;
    for (let i = 0; i < 48; i++) {
      this.flakes.push({
        alive: false,
        p: new THREE.Vector3(),
        v: new THREE.Vector3(),
        r: new THREE.Euler(),
        vr: new THREE.Vector3(),
        sx: 0,
        sy: 0,
        rest: false,
      });
    }
    engine.room.group.add(this.flakeMesh);
    this.updateFlakes(0, 0);
  }
  spawnFlake(tile: Tile) {
    const room = this.e.room;
    const f = this.flakes.find((x) => !x.alive) ?? this.flakes[Math.floor(Math.random() * this.flakes.length)];
    f.alive = true;
    f.rest = false;
    f.sx = (tile.w / 1024) * room.screenW;
    f.sy = (tile.h / 576) * room.screenH;
    f.p.set(
      room.screenCenter.x + ((tile.x + tile.w / 2) / 1024 - 0.5) * room.screenW,
      room.screenCenter.y + (0.5 - (tile.y + tile.h / 2) / 576) * room.screenH,
      room.screenCenter.z + 0.006
    );
    f.v.set((Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 0.5, 0.35 + Math.random() * 0.7);
    f.r.set(0, 0, 0);
    f.vr.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6);
  }
  clearFlakes() {
    for (const f of this.flakes) f.alive = false;
    this.updateFlakes(0, 0);
  }
  /** suck = 0 while they just fall; > 0 while the mouth is inhaling */
  updateFlakes(dt: number, suck: number) {
    const portal = this.e.room.screenCenter;
    const d = this.dummy;
    for (let i = 0; i < this.flakes.length; i++) {
      const f = this.flakes[i];
      if (!f.alive) {
        d.position.set(0, -50, 0);
        d.scale.setScalar(0.0001);
        d.updateMatrix();
        this.flakeMesh.setMatrixAt(i, d.matrix);
        continue;
      }
      let scale = 1;
      if (suck > 0) {
        this.tmp.copy(portal).sub(f.p);
        const dist = this.tmp.length();
        f.v.addScaledVector(this.tmp.normalize(), dt * (4 + suck * 30));
        f.v.multiplyScalar(1 - dt * 1.5);
        f.p.addScaledVector(f.v, dt);
        f.r.x += dt * 9;
        f.r.y += dt * 7;
        scale = clamp(dist * 2.5);
        if (dist < 0.12) f.alive = false;
      } else if (!f.rest) {
        f.v.y -= 2.6 * dt;
        f.v.multiplyScalar(1 - dt * 0.8);
        f.p.addScaledVector(f.v, dt);
        f.r.x += f.vr.x * dt;
        f.r.y += f.vr.y * dt;
        f.r.z += f.vr.z * dt;
        const onDesk = f.p.x > -1.2 && f.p.x < 0.4 && f.p.z < -1.76;
        const floorY = onDesk ? 0.745 : 0.008;
        if (f.p.y < floorY + 0.004) {
          f.p.y = floorY + 0.003 + i * 0.0002;
          f.rest = true;
          f.r.set(-Math.PI / 2, 0, f.r.z);
        }
      }
      d.position.copy(f.p);
      d.rotation.copy(f.r);
      d.scale.set(f.sx * scale, f.sy * scale, 1);
      d.updateMatrix();
      this.flakeMesh.setMatrixAt(i, d.matrix);
    }
    this.flakeMesh.instanceMatrix.needsUpdate = true;
  }
  start_() {
    const e = this.e;
    this.active = true;
    this.t = 0;
    this.stage = 'struggle';
    this.stageT = 0;
    this.ev = 0;
    this.swapped = false;
    this.bitten = false;
    this.popped = false;
    this.landed = false;
    this.depth = 0;
    this.speed = 0;
    this.flashV = 0;
    this.dark = 0;
    this.group.position.copy(e.room.screenCenter);
    this.group.quaternion.identity();
    this.group.visible = true;
    this.ring.visible = false;
    this.teeth.visible = false;
    this.eyes.forEach((x) => (x.visible = false));
    this.tu.uDissolve.value = 0;
    this.tu.uR.value = 0.05;
    this.debris.visible = true;
    this.start.copy(e.camera.position).sub(e.room.screenCenter);
    this.local.copy(this.start);
    this.recoil.set(0);
    this.yawS.set(0);
    this.pitchS.set(0);
    this.rollS.set(e.camRoll);
    this.landS.set(0);
    e.audio.devourRoar();
    e.addTrauma(0.9);
  }
  private events: [number, () => void][] = [
    [
      0,
      () => {
        // flinch: the body throws itself backwards, the head turns away
        this.recoil.to(0.36, 3.4, 0.55);
        this.yawS.to(0.44, 2.6, 0.6);
        this.pitchS.to(0.1, 2.6, 0.6);
        this.rollS.to(-0.07, 2, 0.6);
      },
    ],
    [
      0.7,
      () => {
        // ...and is dragged back, slowly, against its will
        this.recoil.to(0.14, 0.9, 0.9);
        this.yawS.to(-0.07, 1.25, 0.32);
        this.pitchS.to(-0.03, 1.4, 0.4);
        this.rollS.to(0.1, 1.2, 0.5);
      },
    ],
    [1.2, () => this.yawS.to(0.24, 3.2, 0.6)],
    [
      1.42,
      () => {
        this.yawS.to(0, 2.4, 0.4);
        this.pitchS.to(0, 2, 0.5);
        this.recoil.to(0, 1.4, 0.8);
        this.rollS.to(0.24, 1, 0.6);
      },
    ],
  ];
  /** returns true when the player has arrived and control can be handed back */
  update(dt: number): boolean {
    const e = this.e;
    const room = e.room;
    const post = e.post.params;
    this.t += dt;
    this.stageT += dt;
    const T = this.t;
    this.tu.uTime.value = T;
    while (this.ev < this.events.length && T >= this.events[this.ev][0]) this.events[this.ev++][1]();
    this.recoil.step(dt);
    this.yawS.step(dt);
    this.pitchS.step(dt);
    this.rollS.step(dt);
    this.flashV = Math.max(0, this.flashV - dt * 1.2);
    this.dark = Math.max(0, this.dark - dt * 9);
    let yaw = 0;
    let pitch = 0;
    let roll = this.rollS.x;
    let fov = 60;
    // ---------------- room side ----------------
    if (!this.swapped) {
      const grow = smooth(0.3, 2.2, T);
      const r = T < 0.35 ? 0 : lerp(0.05, 0.8, smooth(0.35, 1.7, T)) + smooth(1.7, 2.3, T) * 1.5;
      e.bsod.scream = smooth(0, 0.5, T);
      e.bsod.rage = 1;
      room.fx.uSuck.value = 0.125 + 0.875 * Math.pow(grow, 1.3);
      room.fx.uInfect.value = lerp(1.3, 9.5, smooth(0.05, 2.0, T));
      room.fx.uTear.value = 0.75 * smooth(0.4, 2.3, T);
      room.fx.uMawR.value = r * 0.985;
      this.tu.uR.value = Math.max(0.05, r);
      if (!this.popped && T > 0.22) {
        this.popped = true;
        room.lampOn = 0;
        e.audio.pop();
      }
      room.screenGain = 2.2 + fnoise(T * 30, 1) * 1.2 - grow * 1.6;
      room.hemi.intensity = 0.55 + grow * 1.5;
      this.envC.set('#000000').lerp(this.tu.uGlow.value, smooth(0.3, 1.9, T));
      e.setEnv(this.envC, lerp(30, 5, grow), lerp(120, 75, grow));
      this.updateFlakes(dt, 0.2 + grow);
      this.updateDebris(T);
      // the mouth
      const vis = r > 0.1;
      this.ring.visible = vis;
      this.teeth.visible = vis;
      if (vis) {
        const jit = 1 + fnoise(T * 40, 3) * 0.03;
        this.ring.scale.set(r * jit, r * (2 - jit), r);
        this.ring.rotation.z = fnoise(T * 9, 6) * 0.2;
        const bite = smooth(1.75, 2.25, T);
        const d = this.dummy;
        for (let i = 0; i < 30; i++) {
          const a = (i / 30) * TAU + this.ring.rotation.z;
          const len = r * (0.3 + 0.38 * bite + hash1(i * 3.7) * 0.25 + fnoise(T * 30, i) * 0.06) * (i % 2 ? 1 : 0.62);
          const w = r * 0.17;
          d.position.set(Math.cos(a) * (r - len / 2), Math.sin(a) * (r - len / 2), 0.02);
          d.rotation.set(0, 0, a + Math.PI / 2);
          d.scale.set(w, len, w * 0.6);
          d.updateMatrix();
          this.teeth.setMatrixAt(i, d.matrix);
        }
        this.teeth.instanceMatrix.needsUpdate = true;
      }
      // the eyes open on the wall above
      const open = smooth(0.28, 0.62, T) * (1 + 0.25 * Math.sin(Math.min(1, (T - 0.28) / 0.5) * Math.PI));
      for (let i = 0; i < 2; i++) {
        const eye = this.eyes[i];
        eye.visible = open > 0.01;
        const s = i === 0 ? -1 : 1;
        const er = 0.26 + r * 0.5;
        const sh = 0.012 + r * 0.03;
        eye.position.set(
          s * (r * 0.95 + 0.36) + fnoise(T * 33, 10 + i) * sh,
          r * 0.8 + 0.44 + fnoise(T * 37, 20 + i) * sh,
          -0.2
        );
        eye.scale.set(er * (i === 0 ? 1.15 : 0.9), er * (i === 0 ? 1.15 : 0.9), 1);
        eye.rotation.z = s * -0.15 + fnoise(T * 12, 30 + i) * 0.2;
        const u = this.eyeU[i];
        u.uOpen.value = open;
        u.uTime.value = T;
        u.uLook.value.set(
          clamp((this.local.x - eye.position.x) / 0.9, -1, 1) + fnoise(T * 50, 40 + i) * 0.12,
          clamp((this.local.y - eye.position.y) / 0.9, -1, 1) + fnoise(T * 53, 50 + i) * 0.12
        );
      }
    }
    // ---------------- camera ----------------
    if (this.stage === 'struggle' || this.stage === 'yank') {
      const settle = smooth(0.4, 2.2, T);
      const tremor = 0.008 + 0.03 * smooth(0.5, 1.7, T);
      let z: number;
      if (this.stage === 'struggle') {
        z = this.start.z - 0.1 * smooth(0, 1.7, T) + this.recoil.x;
        fov = lerp(e.fov, 50 + this.recoil.x * 34 + smooth(0.8, 1.7, T) * 16, clamp(T * 5));
        if (T >= 1.7) {
          this.stage = 'yank';
          this.stageT = 0;
          this.zYank = z;
          e.addTrauma(0.6);
        }
      } else {
        const k = clamp(this.stageT / 0.95);
        z = lerp(this.zYank, -3, k * k * k) + this.recoil.x * (1 - k);
        fov = lerp(66, 108, smooth(0, 0.8, k));
        if (!this.bitten && z < 0.06) {
          this.bitten = true;
          this.dark = 1;
          e.audio.bite();
          e.audio.setCorruption(0);
          e.audio.setRoom(0, 0.05);
          e.addTrauma(1);
        }
        if (k >= 1) {
          this.stage = 'tunnel';
          this.stageT = 0;
          this.depth = 3;
          this.speed = 11.5;
        }
      }
      this.local.set(
        this.start.x * (1 - settle) + fnoise(T * 7, 1) * 0.02 + this.yawS.x * -0.06,
        this.start.y * (1 - settle) + this.recoil.x * 0.07 + fnoise(T * 8, 2) * 0.015,
        z
      );
      e.camera.position.copy(this.local).add(this.group.position);
      const base = lookAngles(this.local.x, this.local.y, this.local.z, 0, 0, Math.min(-0.4, this.local.z - 2));
      yaw = base.yaw + this.yawS.x + fnoise(T * 19, 5) * tremor;
      pitch = base.pitch + this.pitchS.x + fnoise(T * 21, 6) * tremor;
      const pull = smooth(0.4, 2.2, T);
      post.warp = damp(post.warp, 0.1 + pull * 0.5 + Math.max(0, fnoise(T * 11, 8)) * 0.2, 12, dt);
      post.aberr = 0.004 + pull * 0.016;
      post.blur = pull * 0.75;
      post.glitch = T < 0.3 ? 0.7 : Math.max(0, fnoise(T * 13, 4) - 0.25) * 1.2 + (this.bitten ? 0.8 : 0);
      post.vignette = 1.0;
      post.exposure = 1.5 + pull * 0.2;
      e.audio.setWind(pull * 0.85, pull * 0.6);
      // the suction centre on screen = where the mouth is
      this.tmp.copy(this.group.position).project(e.camera);
      post.cx = clamp(this.tmp.x * 0.5 + 0.5, 0.2, 0.8);
      post.cy = clamp(this.tmp.y * 0.5 + 0.5, 0.2, 0.8);
    } else if (this.stage === 'tunnel') {
      this.speed = Math.min(52, this.speed + 42 * dt);
      this.depth += this.speed * dt;
      const d = this.depth;
      if (!this.swapped && d > L * 0.42) this.swap();
      const [bx, by] = bend(d);
      const [ax, ay] = bend(d + 12);
      const wob = 0.25 + (d / L) * 1.2;
      this.local.set(bx + fnoise(T * 2.3, 11) * wob, by + fnoise(T * 2.7, 12) * wob, -d);
      this.tmp.copy(this.local);
      this.group.localToWorld(this.tmp);
      e.camera.position.copy(this.tmp);
      this.tmp2.set(ax, ay, -(d + 12));
      this.group.localToWorld(this.tmp2);
      const la = lookAngles(this.tmp.x, this.tmp.y, this.tmp.z, this.tmp2.x, this.tmp2.y, this.tmp2.z);
      yaw = la.yaw + fnoise(T * 3.1, 13) * 0.06;
      pitch = la.pitch + fnoise(T * 3.7, 14) * 0.06;
      this.rollS.set(0.24 * (1 - smooth(0, 20, d)));
      roll = this.rollS.x + Math.sin((d / L) * Math.PI) * 1.25 + fnoise(T * 1.9, 15) * 0.12;
      fov = 108 + Math.sin(T * 9) * 2 - smooth(L * 0.7, L, d) * 16;
      this.tu.uDissolve.value = smooth(L * 0.52, L * 0.97, d);
      const beat = Math.max(0, Math.sin(T * 9));
      post.warp = 0.28 + beat * 0.12;
      post.aberr = 0.014;
      post.blur = 0.55 * (1 - smooth(L * 0.6, L, d));
      post.glitch = Math.max(0, fnoise(T * 9, 4) - 0.45) * 1.4;
      post.cx = damp(post.cx, 0.5, 6, dt);
      post.cy = damp(post.cy, 0.5, 6, dt);
      post.exposure = 1.5;
      e.audio.setWind(1, 0.45 + 0.55 * (d / L));
      if (d >= L) {
        // out — into open sky, and sudden quiet
        this.stage = 'flight';
        this.stageT = 0;
        this.p0.copy(e.camera.position);
        this.p1.copy(this.p0).addScaledVector(this.dir, 46);
        const s = WORLD.spawn;
        this.p3.set(s.x, groundHeight(s.x, s.z) + WORLD.eye + 1.3, s.z);
        this.p2.copy(this.p3).add(this.tmp.set(0, 12, 30));
        this.yawS.set(yaw);
        this.pitchS.set(pitch);
        this.rollS.set(roll);
        this.rollS.to(0, 0.7, 0.8);
        this.flashV = 0.75;
        e.audio.setWind(0.25, 0.2);
        e.audio.emerge();
        e.audio.setWorld(1, 2.5);
      }
    } else if (this.stage === 'flight') {
      const Td = 3.3;
      const k = clamp(this.stageT / Td);
      const u = 1 - Math.pow(1 - k, 1.25);
      const a = 1 - u;
      const pos = e.camera.position;
      pos.set(0, 0, 0)
        .addScaledVector(this.p0, a * a * a)
        .addScaledVector(this.p1, 3 * a * a * u)
        .addScaledVector(this.p2, 3 * a * u * u)
        .addScaledVector(this.p3, u * u * u);
      // tangent
      this.tmp
        .set(0, 0, 0)
        .addScaledVector(this.p0, -3 * a * a)
        .addScaledVector(this.p1, 3 * a * a - 6 * a * u)
        .addScaledVector(this.p2, 6 * a * u - 3 * u * u)
        .addScaledVector(this.p3, 3 * u * u)
        .normalize();
      // the eyes find the tower before the body has stopped moving
      this.tmp2.set(0, 40, 0).sub(pos).normalize();
      this.tmp.lerp(this.tmp2, smooth(0.05, 0.6, k)).normalize();
      this.yawS.to(Math.atan2(-this.tmp.x, -this.tmp.z), 1.3, 0.85);
      this.pitchS.to(Math.asin(clamp(this.tmp.y, -1, 1)), 1.3, 0.85);
      yaw = this.yawS.x + fnoise(T * 1.3, 21) * 0.02;
      pitch = this.pitchS.x + fnoise(T * 1.5, 22) * 0.02;
      roll = this.rollS.x;
      fov = lerp(92, 78, smooth(0, 1, k));
      post.warp = damp(post.warp, 0, 3, dt);
      post.aberr = damp(post.aberr, 0.002, 2.5, dt);
      post.blur = damp(post.blur, 0, 4, dt);
      post.glitch = damp(post.glitch, 0, 6, dt);
      post.vignette = damp(post.vignette, 0.6, 2, dt);
      e.audio.setWind(0.25 * (1 - k), 0.2);
      if (k >= 1) {
        this.stage = 'land';
        this.stageT = 0;
        this.vy = -1.5;
      }
    } else {
      // last metre: gravity remembers you
      const s = WORLD.spawn;
      const ground = groundHeight(s.x, s.z) + WORLD.eye;
      const pos = e.camera.position;
      if (!this.landed) {
        this.vy -= 15 * dt;
        pos.y += this.vy * dt;
        if (pos.y <= ground) {
          pos.y = ground;
          this.landed = true;
          this.stageT = 0;
          this.landS.kick(-2.6);
          this.pitchS.kick(-1.6);
          this.pitchS.to(0.1, 1.1, 0.6);
          this.yawS.to(0, 1.1, 0.8);
          e.audio.step('world', 2.4);
          e.audio.boom(0.35);
          e.audio.setWind(0, 0);
          e.addTrauma(0.35);
        }
      } else {
        this.landS.step(dt);
        pos.y = ground + this.landS.x;
      }
      yaw = this.yawS.x;
      pitch = this.pitchS.x;
      roll = this.rollS.x;
      fov = lerp(78, 72, clamp(this.stageT));
      post.warp = damp(post.warp, 0, 3, dt);
      post.blur = damp(post.blur, 0, 4, dt);
      post.glitch = damp(post.glitch, 0, 6, dt);
      if (this.landed && this.stageT > 1.5) {
        e.player.pos.set(s.x, groundHeight(s.x, s.z), s.z);
        e.player.yaw = yaw;
        e.player.pitch = pitch;
        e.camRoll = 0;
        e.fov = 72;
        this.finish();
        return true;
      }
    }
    post.flash = this.flashV;
    post.fade = this.dark * 0.92;
    e.camera.rotation.set(pitch, yaw, roll, 'YXZ');
    e.fov = fov;
    return false;
  }
  private updateDebris(T: number) {
    const portal = this.e.room.screenCenter;
    const d = this.dummy;
    for (let i = 0; i < this.debrisData.length; i++) {
      const b = this.debrisData[i];
      const k = (T - b.release) / b.dur;
      if (k <= 0 || k >= 1) {
        d.position.set(0, -50, 0);
        d.scale.setScalar(0.0001);
      } else {
        const kk = Math.pow(k, 2.2);
        this.tmp.copy(b.o).sub(portal);
        const ang = kk * 3.2 * (i % 2 ? 1 : -1);
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const x = this.tmp.x * cs - this.tmp.y * sn;
        const y = this.tmp.x * sn + this.tmp.y * cs;
        d.position.set(portal.x + x * (1 - kk), portal.y + y * (1 - kk), portal.z + this.tmp.z * (1 - kk) + Math.sin(k * Math.PI) * 0.5);
        d.quaternion.setFromAxisAngle(b.axis, b.spin * k);
        const s = 1 - kk * kk;
        d.scale.set(b.size.x * s, b.size.y * s, b.size.z);
      }
      d.updateMatrix();
      this.debris.setMatrixAt(i, d.matrix);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }
  /** hidden inside the throat: the room is gone, the tunnel now hangs in the other sky */
  private swap() {
    const e = this.e;
    this.swapped = true;
    e.showRoom(false);
    e.showWorld(true);
    this.ring.visible = false;
    this.teeth.visible = false;
    this.eyes.forEach((x) => (x.visible = false));
    this.debris.visible = false;
    const exit = this.tmp.set(5, 96, 288);
    this.dir.set(0, 13, 150).sub(exit).normalize();
    this.group.position.copy(exit).addScaledVector(this.dir, -L);
    this.group.lookAt(this.tmp2.copy(this.group.position).sub(this.dir));
    this.group.updateMatrixWorld(true);
    e.camera.near = 0.3;
    e.camera.far = 3200;
    e.camera.updateProjectionMatrix();
    const u = e.world.u;
    e.setEnv(u.uFogColor.value, u.uFogNear.value, u.uFogFar.value);
  }
  private finish() {
    this.active = false;
    this.group.visible = false;
    this.debris.visible = false;
    this.clearFlakes();
    const post = this.e.post.params;
    post.flash = 0;
    post.fade = 0;
  }
  /** hard reset (restart from the beginning) */
  reset() {
    this.active = false;
    this.group.visible = false;
    this.debris.visible = false;
    this.clearFlakes();
  }
}
