import * as THREE from 'three';
import { Bedroom, type BedroomCtx, type PatchOpts, loadBedroomAssets, roomToWorld, sharedNoiseTexture } from './bedroom';
import { clockTexture } from './textures';
import { TAU, clamp, fnoise } from './utils';
const FX_DECL = /* glsl */ `
uniform vec3 uPortal;
uniform float uSuck;
uniform float uInfect;
uniform float uTear;
uniform float uMawR;
uniform float uRfxTime;
uniform vec3 uRfxBlue;
uniform float uRfxRimGain;
varying vec3 vRfxW;
varying float vRfxPull;
float rfxHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float rfxHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
#ifdef RFX_CRAFT
uniform sampler2D uRfxNoise;
varying float vRfxWall;
#endif
#ifdef RFX_RIM
uniform vec3 uRfxRimCol;
uniform vec3 uRfxRimPar;
varying vec3 vRfxRim;
#endif
`;
// world-space vertex stage: the room is dragged, twisted and swallowed by the portal
const FX_VERT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 rfxW = modelMatrix * mvPosition;
vRfxW = rfxW.xyz;
vRfxPull = 0.0;
if (uSuck > 0.0005) {
  float rfxDist = distance(uPortal, rfxW.xyz);
  float rfxReach = 0.6 + uSuck * 7.5;
  float rfxP = uSuck * (1.0 - smoothstep(0.0, rfxReach, rfxDist));
  rfxP = clamp(pow(rfxP, 1.5) * 1.2, 0.0, 0.985);
  float rfxWob = sin(rfxDist * 5.0 - uRfxTime * 9.0) * 0.05 * uSuck * (1.0 - rfxP);
  vec2 rfxRel = rfxW.xy - uPortal.xy;
  float rfxAng = rfxP * 2.4 * uSuck;
  float rfxC = cos(rfxAng), rfxS = sin(rfxAng);
  rfxRel = vec2(rfxRel.x * rfxC - rfxRel.y * rfxS, rfxRel.x * rfxS + rfxRel.y * rfxC);
  rfxW.xy = uPortal.xy + rfxRel * (1.0 + rfxWob);
  rfxW.xyz = mix(rfxW.xyz, uPortal + vec3(0.0, 0.0, -0.5), rfxP);
  vRfxPull = rfxP;
}
mvPosition = viewMatrix * rfxW;
gl_Position = projectionMatrix * mvPosition;
#ifdef RFX_CRAFT
vRfxWall = 1.0 - smoothstep(0.32, 0.72, abs(normalize(mat3(modelMatrix) * objectNormal).y));
#endif
#ifdef RFX_RIM
{
  // fresnel rim + a soft sheen, per vertex: props keep some shape in a room this dark
  vec3 rfxV = normalize(-mvPosition.xyz);
  vec3 rfxN = normalize(transformedNormal);
  float rfxF = 1.0 - clamp(abs(dot(rfxN, rfxV)), 0.0, 1.0);
  rfxF = rfxF * rfxF * rfxF;
  float rfxSp = pow(max(dot(rfxN, normalize(normalize(vec3(-0.35, 0.65, 0.67)) + rfxV)), 0.0), uRfxRimPar.y) * uRfxRimPar.x;
  vRfxRim = uRfxRimCol * (rfxF * uRfxRimPar.z + rfxSp * 0.65) + vec3(rfxSp * 0.35);
}
#endif
`;
const FX_FRAG_HEAD = /* glsl */ `
  if (uMawR > 0.0) {
    if (length(vRfxW.xy - uPortal.xy) < uMawR && vRfxW.z < uPortal.z + 0.03) discard;
  }
  if (vRfxPull > 0.9) discard;
  if (uTear > 0.0) {
    float rfxCell = rfxHash(floor(vRfxW * 2.5 + 0.37));
    if (rfxCell < uTear * 1.25 - distance(vRfxW, uPortal) * 0.1) discard;
  }
`;
/** end of the fragment stage for anything the portal can drag in */
const FX_FRAG_PULL = /* glsl */ `
gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.7, 0.86, 1.0) * 2.2, smoothstep(0.3, 0.9, vRfxPull));
`;
const FX_FRAG_TAIL = /* glsl */ `
#include <dithering_fragment>
#ifdef RFX_CRAFT
{
  // plaster / board craft: grain, faint wallpaper seams, darkening into floor and cornice
  float rfxAxis = vRfxW.x + vRfxW.z;
  vec4 rfxNC = texture2D(uRfxNoise, vec2(rfxAxis * 0.28, vRfxW.y * 0.28));
  float rfxStripe = smoothstep(0.40, 0.50, abs(fract(rfxAxis * 1.92) - 0.5)) * vRfxWall;
  float rfxAO = (smoothstep(0.52, 0.0, vRfxW.y) * 0.40 + smoothstep(2.58, 3.15, vRfxW.y) * 0.32) * vRfxWall;
  gl_FragColor.rgb *= (1.0 - (rfxNC.g - 0.5) * 0.07 + (rfxNC.r - 0.5) * 0.11 + rfxStripe * 0.055) * (1.0 - rfxAO);
}
#endif
#ifdef RFX_RIM
gl_FragColor.rgb += vRfxRim * uRfxRimGain;
#endif
#ifndef RFX_NO_INFECT
{
  float rfxD = distance(vRfxW, uPortal);
  float rfxN = rfxHash(floor(vRfxW * 9.0 + 0.5)) * 0.28 + sin(vRfxW.x * 7.0 + vRfxW.y * 5.0 + vRfxW.z * 6.0) * 0.12;
  float rfxFront = uInfect - rfxD + rfxN * min(1.0, uInfect * 2.0);
  float rfxM = smoothstep(0.0, 0.2, rfxFront);
  if (rfxM > 0.0) {
    vec3 rfxAn = abs(normalize(cross(dFdx(vRfxW), dFdy(vRfxW))));
    vec2 rfxT = rfxAn.y > 0.6 ? vRfxW.xz : (rfxAn.x > 0.6 ? vRfxW.zy : vRfxW.xy);
    float rfxRow = floor(rfxT.y * 24.0);
    float rfxChr = step(0.42, rfxHash2(vec2(floor(rfxT.x * 80.0), rfxRow)))
      * step(0.3, rfxHash2(vec2(rfxRow, 3.0))) * step(fract(rfxT.y * 24.0), 0.5);
    rfxChr *= step(fract(rfxT.x * 0.8 + rfxHash2(vec2(rfxRow, 7.0))), 0.25 + 0.6 * rfxHash2(vec2(rfxRow, 9.0)));
    float rfxLum = dot(gl_FragColor.rgb, vec3(0.3, 0.5, 0.2));
    vec3 rfxInf = uRfxBlue * (0.5 + 0.5 * clamp(rfxLum * 5.0, 0.0, 1.0)) + vec3(rfxChr) * 0.8;
    float rfxEdge = smoothstep(0.0, 0.05, rfxFront) * (1.0 - smoothstep(0.05, 0.2, rfxFront));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, rfxInf, rfxM * 0.94) + vec3(0.7, 0.86, 1.0) * rfxEdge * 1.6;
  }
}
#endif
gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.7, 0.86, 1.0) * 2.2, smoothstep(0.3, 0.9, vRfxPull));
`;
interface Collider {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  on: boolean;
}
/** half extents of the shell around the origin (used for the debris torn off the walls) */
export const ROOM = { hw: 2.25, hd: 2.37, h: 3.15 };
/** where feet can go */
const WALK = { x0: -2.55, x1: 2.45, z0: -2.9, z1: 1.27 };
const DESK_TOP = 0.762;
const FLOOR = 0.017;
// office chair, in the bedroom's own space
const CHAIR_REST = { pos: [-0.82, FLOOR, 1.3], rot: [0, -2.25, 0] };
const CHAIR_FALLEN = { pos: [-0.78, 0.285, 1.18], rot: [0, 1.15, 0.55] };
const CHAIR_BOX = { x0: 0.84, x1: 1.39, z0: -1.63, z1: -1.13 };
const CHAIR_BOX_FALLEN = { x0: 0.75, x1: 1.65, z0: -1.7, z1: -0.3 };
/**
 * The bedroom. The place itself comes from bsod_ex (see bedroom.ts); this class owns what the
 * rest of the game talks to: the portal shader, the screen, the lights, the clock, collisions
 * and the handful of things that are different after you come back.
 */
export class Room {
  group = new THREE.Group();
  fx = {
    uPortal: { value: new THREE.Vector3() },
    uSuck: { value: 0 },
    uInfect: { value: 0 },
    uTear: { value: 0 },
    uMawR: { value: 0 },
    uRfxTime: { value: 0 },
    uRfxBlue: { value: new THREE.Color('#0078d7') },
    uRfxNoise: { value: sharedNoiseTexture() as THREE.Texture },
    uRfxRimGain: { value: 1 },
  };
  screenMesh!: THREE.Mesh;
  /** BSOD_SCREEN_NODE of the PC model, in world space */
  screenCenter = new THREE.Vector3(-1.335, 1.045, -2.053);
  screenW = 0.6636;
  screenH = 0.3655;
  focusPos = new THREE.Vector3(-1.335, 1.065, -1.42);
  startPos = new THREE.Vector3(-1.38, 1.62, -0.55);
  startYaw = 0.06;
  startPitch = -0.06;
  landPos = new THREE.Vector3(-0.78, 0, -1.05);
  /** things the ear can place (x, z) */
  fanPos = new THREE.Vector2(-0.48, -2.03);
  clockPos = new THREE.Vector2(-0.40, -2.35);
  hemi!: THREE.HemisphereLight;
  monitorLight!: THREE.SpotLight;
  monitorFill!: THREE.PointLight;
  lamp!: THREE.SpotLight;
  lampGlow!: THREE.PointLight;
  moon!: THREE.SpotLight;
  lampOn = 1;
  screenGain = 1;
  aftermath = false;
  loaded = false;
  clockTime = 2 * 3600 + 47 * 60 + 12;
  private amb = {
    uTime: this.fx.uRfxTime,
    uInfect: { value: 0 },
    uPortalPos: this.fx.uPortal,
    uCamForward: { value: new THREE.Vector3(0, 0, -1) },
    uNoiseTex: this.fx.uRfxNoise,
    uAfter: { value: 0 },
  };
  private ctx: BedroomCtx = {
    patch: (mat, opts) => this.patch(mat, opts),
    fxShader: (params) => this.fxShader(params),
    amb: this.amb,
  };
  private bed: Bedroom | null = null;
  private screenMat!: THREE.MeshBasicMaterial;
  private beamMat!: THREE.ShaderMaterial;
  private beam!: THREE.Mesh;
  private shard = new THREE.Group();
  private shardLight!: THREE.PointLight;
  private hands: THREE.Object3D[] = [];
  private colliders: Collider[] = [];
  private chairCollider!: Collider;
  private lastSecond = -1;
  private lastMinute = -1;
  private ceilingOn = true;
  constructor(screenTexture: THREE.Texture) {
    this.fx.uPortal.value.copy(this.screenCenter);
    this.build(screenTexture);
  }
  /** fetches the models and textures and puts the room together around the screen */
  async load(): Promise<void> {
    const assets = await loadBedroomAssets();
    this.bed = new Bedroom(this.ctx, assets);
    this.group.add(this.bed.inner);
    this.loaded = true;
    this.setAftermath(this.aftermath);
    this.setCeiling(this.ceilingOn);
    this.lastMinute = -1;
  }
  /** makes a built-in material obey the portal: dragged, twisted, torn, overwritten in blue */
  patch<T extends THREE.Material>(mat: T, opt: PatchOpts | boolean = false): T {
    const o: PatchOpts = typeof opt === 'boolean' ? { noInfect: opt } : opt;
    const defs = (o.noInfect ? '#define RFX_NO_INFECT\n' : '') + (o.craft ? '#define RFX_CRAFT\n' : '') + (o.rim ? '#define RFX_RIM\n' : '');
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.fx);
      if (o.rim) {
        shader.uniforms.uRfxRimCol = { value: o.rim.color };
        shader.uniforms.uRfxRimPar = { value: o.rim.params };
      }
      shader.vertexShader = defs + FX_DECL + shader.vertexShader.replace('#include <project_vertex>', FX_VERT);
      shader.fragmentShader =
        defs +
        FX_DECL +
        shader.fragmentShader
          .replace('void main() {', 'void main() {\n' + FX_FRAG_HEAD)
          .replace('#include <dithering_fragment>', FX_FRAG_TAIL);
    };
    mat.customProgramCacheKey = () => 'rfx' + (o.noInfect ? '-ni' : '') + (o.craft ? '-c' : '') + (o.rim ? '-r' : '');
    return mat;
  }
  /**
   * The same for hand-written shaders. The vertex stage must declare `vec3 transformed` and
   * contain the marker RFX_PROJECT where it would set gl_Position; the fragment stage may end
   * with the marker RFX_TAIL.
   */
  fxShader(params: THREE.ShaderMaterialParameters): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      ...params,
      uniforms: { ...params.uniforms, ...this.fx },
      vertexShader: FX_DECL + (params.vertexShader ?? '').replace('/*RFX_PROJECT*/', FX_VERT),
      fragmentShader:
        FX_DECL +
        (params.fragmentShader ?? '').replace('void main() {', 'void main() {\n' + FX_FRAG_HEAD).replace('/*RFX_TAIL*/', FX_FRAG_PULL),
    });
  }
  private build(screenTexture: THREE.Texture) {
    const G = this.group;
    const std = (color: string, rough = 0.85, metal = 0) => this.patch(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
    const basic = (params: THREE.MeshBasicMaterialParameters) => this.patch(new THREE.MeshBasicMaterial(params));
    const sx = this.screenCenter.x;
    const sy = this.screenCenter.y;
    const sz = this.screenCenter.z;
    // ---------- the screen (this game's own picture, in the frame of the PC model's monitor) ----------
    this.screenMat = this.patch(new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false }), true);
    this.screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(this.screenW, this.screenH, 20, 12), this.screenMat);
    this.screenMesh.position.copy(this.screenCenter);
    // the monitor leans back four degrees
    this.screenMesh.rotation.x = -0.0698;
    G.add(this.screenMesh);
    // its glow hanging in the air in front of it
    const beamLen = 1.95;
    const beamGeo = new THREE.CylinderGeometry(0.24, 0.8, beamLen, 20, 1, true);
    beamGeo.rotateX(Math.PI * 0.5);
    beamGeo.translate(0, -0.04, beamLen * 0.5 + 0.02);
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: this.fx.uRfxTime,
        uIntensity: { value: 1 },
        uColor: { value: new THREE.Color('#9db8ff') },
        uPortal: this.fx.uPortal,
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uColor;
        uniform vec3 uPortal;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float edgeSoft = pow(abs(dot(normalize(vNormalW), viewDir)), 1.65);
          float along = smoothstep(1.95, 0.05, vWorldPos.z - uPortal.z);
          float camDistFade = smoothstep(0.62, 1.25, length(cameraPosition - uPortal));
          float scan = 0.92 + 0.08 * sin(vWorldPos.y * 38.0 - uTime * 7.0);
          gl_FragColor = vec4(uColor, edgeSoft * along * camDistFade * 0.095 * uIntensity * scan);
        }
      `,
    });
    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.position.copy(this.screenCenter);
    G.add(this.beam);
    // ---------- wall clock (the one that ticks) ----------
    const clock = new THREE.Group();
    clock.position.set(this.clockPos.x, 2.13, this.clockPos.y);
    clock.add(new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), this.patch(new THREE.MeshStandardMaterial({ map: clockTexture(), roughness: 0.6 }))));
    clock.add(new THREE.Mesh(new THREE.TorusGeometry(0.152, 0.012, 8, 32), std('#1c1c1f', 0.4)));
    const handMat = std('#111', 0.5);
    const mkHand = (len: number, w: number, z: number, mat: THREE.Material) => {
      const piv = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.003), mat);
      m.position.y = len / 2 - 0.012;
      piv.add(m);
      piv.position.z = z;
      clock.add(piv);
      return piv;
    };
    this.hands = [mkHand(0.075, 0.011, 0.004, handMat), mkHand(0.115, 0.007, 0.007, handMat), mkHand(0.125, 0.003, 0.01, std('#b0281e', 0.5))];
    G.add(clock);
    // ---------- aftermath shard (hidden at first) ----------
    const shardMat = basic({ color: new THREE.Color(0.25, 0.9, 3.2) });
    const sh = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), shardMat);
    sh.scale.set(0.5, 1.9, 0.35);
    sh.rotation.set(0.3, 0.4, 0.5);
    this.shard.add(sh);
    const sh2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.035, 0), shardMat);
    sh2.position.set(0.12, -0.05, 0.08);
    sh2.rotation.set(1, 0.3, 0.2);
    this.shard.add(sh2);
    this.shardLight = new THREE.PointLight('#2a8cff', 0, 2.6, 1.6);
    this.shardLight.position.y = 0.08;
    this.shard.add(this.shardLight);
    this.shard.position.set(-0.78, 0.115, -0.95);
    this.shard.visible = false;
    G.add(this.shard);
    // ---------- lights ----------
    this.hemi = new THREE.HemisphereLight('#3c5a96', '#0b0e18', 0.55);
    G.add(this.hemi);
    this.monitorLight = new THREE.SpotLight('#9db8ff', 9, 9, 1.2, 0.9, 1.4);
    this.monitorLight.position.set(sx, sy, sz + 0.06);
    this.monitorLight.target.position.set(sx + 0.35, 0.55, 1.2);
    this.monitorLight.castShadow = true;
    this.monitorLight.shadow.mapSize.set(1024, 1024);
    this.monitorLight.shadow.bias = -0.0012;
    this.monitorLight.shadow.normalBias = 0.02;
    this.monitorLight.shadow.camera.near = 0.08;
    this.monitorLight.shadow.camera.far = 8;
    G.add(this.monitorLight, this.monitorLight.target);
    this.monitorFill = new THREE.PointLight('#9db8ff', 0.5, 2.4, 1.5);
    this.monitorFill.position.set(sx, 0.98, sz + 0.32);
    G.add(this.monitorFill);
    // desk lamp (the prop itself is part of the bedroom)
    const bulb = roomToWorld(-1.74, 1.031, 1.2);
    this.lamp = new THREE.SpotLight('#ffb36b', 6, 3.4, 0.8, 0.7, 1.3);
    this.lamp.position.copy(bulb);
    this.lamp.target.position.set(bulb.x + 0.14, DESK_TOP + 0.02, bulb.z + 0.18);
    G.add(this.lamp, this.lamp.target);
    this.lampGlow = new THREE.PointLight('#ffb36b', 0.45, 3, 1.6);
    this.lampGlow.position.set(bulb.x + 0.01, bulb.y - 0.06, bulb.z + 0.08);
    G.add(this.lampGlow);
    // moon through the big window opposite the desk
    this.moon = new THREE.SpotLight('#6f8fd0', 5, 7, 0.55, 1, 1.2);
    this.moon.position.copy(roomToWorld(2.95, 2.25, -0.55));
    this.moon.target.position.copy(roomToWorld(1.7, 0.05, -0.55));
    G.add(this.moon, this.moon.target);
    // ---------- colliders (the furniture of the bedroom, turned into this world's axes) ----------
    this.chairCollider = { ...CHAIR_BOX, on: true };
    this.colliders = [
      // bed platform & mattress
      { x0: -1.716, x1: 1.436, z0: -2.67, z1: -0.8, on: true },
      // bedside nightstand
      { x0: 1.436, x1: 2.136, z0: -2.39, z1: -1.69, on: true },
      // PC desk against the monitor wall
      { x0: -0.79, x1: 0.81, z0: -2.67, z1: -1.07, on: true },
      this.chairCollider,
      // window counter / bookshelf / plant
      { x0: -2.25, x1: 1.62, z0: 1.35, z1: 2.22, on: true },
      // small storage box under the counter
      { x0: 1.11, x1: 1.49, z0: -0.83, z1: -0.43, on: true },
    ];
    this.setClock();
  }
  /** keeps the player inside the walls and out of the furniture */
  collide(p: THREE.Vector3, r = 0.27) {
    p.x = clamp(p.x, WALK.x0 + r, WALK.x1 - r);
    p.z = clamp(p.z, WALK.z0 + r, WALK.z1 - r);
    for (const b of this.colliders) {
      if (!b.on) continue;
      const cx = clamp(p.x, b.x0, b.x1);
      const cz = clamp(p.z, b.z0, b.z1);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        const l = p.x - b.x0;
        const rr = b.x1 - p.x;
        const n = p.z - b.z0;
        const f = b.z1 - p.z;
        const m = Math.min(l, rr, n, f);
        if (m === l) p.x = b.x0 - r;
        else if (m === rr) p.x = b.x1 + r;
        else if (m === n) p.z = b.z0 - r;
        else p.z = b.z1 + r;
      }
    }
  }
  /** height at which something small dropped at (x, z) comes to rest: the desk top or the floor */
  restY(x: number, z: number) {
    return x > -0.81 && x < 0.81 && z < -1.08 ? DESK_TOP : FLOOR + 0.004;
  }
  private setClock() {
    const t = this.clockTime;
    const s = Math.floor(t) % 60;
    const m = (t / 60) % 60;
    const h = (t / 3600) % 12;
    this.hands[0].rotation.z = -(h / 12) * TAU;
    this.hands[1].rotation.z = -(m / 60) * TAU;
    this.hands[2].rotation.z = -(s / 60) * TAU;
    // the bedside alarm clock agrees with it
    const minute = Math.floor(t / 60);
    if (this.bed && minute !== this.lastMinute) {
      this.lastMinute = minute;
      const hh = Math.floor(minute / 60) % 24;
      this.bed.setClock(`${String(hh).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, this.aftermath);
    }
  }
  setScreenLight(color: THREE.ColorRepresentation, intensity: number) {
    this.monitorLight.color.set(color);
    this.monitorFill.color.set(color);
    this.screenGain = intensity;
  }
  setCeiling(on: boolean) {
    this.ceilingOn = on;
    if (!this.bed) return;
    for (const p of this.bed.ceilingParts) p.visible = on;
    // from above there is no window to look through either
    this.bed.exterior.visible = on;
  }
  /** the small things that are different after you come back */
  setAftermath(on: boolean) {
    this.aftermath = on;
    this.shard.visible = on;
    this.shardLight.intensity = on ? 1.4 : 0;
    // the painting over the bed, and the night outside
    this.amb.uAfter.value = on ? 1 : 0;
    const pose = on ? CHAIR_FALLEN : CHAIR_REST;
    Object.assign(this.chairCollider, on ? CHAIR_BOX_FALLEN : CHAIR_BOX);
    if (this.bed) {
      this.bed.chair.position.fromArray(pose.pos);
      this.bed.chair.rotation.set(pose.rot[0], pose.rot[1], pose.rot[2]);
    }
    if (on) {
      this.moon.color.set('#2a7cff');
      this.moon.intensity = 7;
    } else {
      this.moon.color.set('#6f8fd0');
      this.moon.intensity = 5;
      this.clockTime = 2 * 3600 + 47 * 60 + 12;
    }
    this.lastMinute = -1;
  }
  /** returns true on the frames the second hand moves (for the tick sound) */
  update(time: number, dt: number, flicker: number, camera?: THREE.Camera): boolean {
    const fx = this.fx;
    fx.uRfxTime.value = time;
    this.clockTime += dt * (this.aftermath ? -1 : 1);
    this.setClock();
    const sec = Math.floor(this.clockTime);
    const ticked = sec !== this.lastSecond;
    this.lastSecond = sec;
    // lamp: steady, until the corruption starts starving it
    let lampK = this.lampOn;
    if (flicker > 0.01) {
      const n = fnoise(time * 17, 3) * 0.5 + 0.5;
      const cut = fnoise(time * 43, 9) > 0.6 - flicker * 0.9 ? 0.15 : 1;
      lampK *= clamp(1 - flicker * 0.75 * n) * (flicker > 0.3 ? cut : 1);
    }
    this.lamp.intensity = 6 * lampK;
    this.lampGlow.intensity = 0.45 * lampK;
    const g = this.screenGain * (0.96 + 0.04 * Math.sin(time * 61));
    this.monitorLight.intensity = 9 * g;
    this.monitorFill.intensity = 0.5 * g;
    this.screenMat.color.setScalar(Math.min(1.9, 1.15 + 0.2 * (g - 1)));
    if (this.aftermath) this.shardLight.intensity = 1.2 + Math.sin(time * 2.1) * 0.35 + fnoise(time * 9, 2) * 0.2;
    // the bedroom's own ambience follows the same state
    const spread = clamp(fx.uInfect.value / 2);
    this.amb.uInfect.value = spread;
    if (camera) camera.getWorldDirection(this.amb.uCamForward.value);
    const calm = 1 - clamp(fx.uSuck.value * 3);
    fx.uRfxRimGain.value = clamp(0.35 + 0.65 * g, 0, 2.2);
    this.beamMat.uniforms.uColor.value.copy(this.monitorLight.color);
    this.beamMat.uniforms.uIntensity.value = clamp(g, 0, 2.6) * calm;
    this.beam.visible = calm > 0.01;
    if (this.bed) {
      this.bed.lampBulb.color.setRGB(3.2 * lampK + 0.02, 2.1 * lampK + 0.015, 1.1 * lampK + 0.01);
      const dust = this.bed.dustMat.uniforms;
      dust.uPull.value = clamp(fx.uSuck.value * 1.4);
      dust.uGain.value = clamp(g, 0, 2);
      dust.uColor.value.copy(this.monitorLight.color).lerp(WHITE, 0.35);
    }
    return ticked;
  }
}
const WHITE = new THREE.Color('#ffffff');
