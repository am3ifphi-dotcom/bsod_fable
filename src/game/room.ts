import * as THREE from 'three';
import {
  calendarTexture,
  cityTexture,
  clockTexture,
  keyboardTexture,
  noteTexture,
  posterTexture,
  rainTexture,
  rugTexture,
  wallTexture,
  woodTexture,
} from './textures';
import { TAU, clamp, fnoise, mulberry } from './utils';
const FX_DECL = /* glsl */ `
uniform vec3 uPortal;
uniform float uSuck;
uniform float uInfect;
uniform float uTear;
uniform float uMawR;
uniform float uRfxTime;
uniform vec3 uRfxBlue;
varying vec3 vRfxW;
varying float vRfxPull;
float rfxHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float rfxHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
const FX_FRAG_TAIL = /* glsl */ `
#include <dithering_fragment>
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
export const ROOM = { hw: 2.2, hd: 2.5, h: 2.5 };
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
  };
  screenMesh!: THREE.Mesh;
  screenCenter = new THREE.Vector3(-0.4, 1.08, -2.262);
  screenW = 0.61;
  screenH = 0.343;
  focusPos = new THREE.Vector3(-0.4, 1.1, -1.66);
  startPos = new THREE.Vector3(0.55, 1.62, 1.55);
  landPos = new THREE.Vector3(-0.3, 0, -0.75);
  hemi!: THREE.HemisphereLight;
  monitorLight!: THREE.SpotLight;
  monitorFill!: THREE.PointLight;
  lamp!: THREE.SpotLight;
  lampGlow!: THREE.PointLight;
  moon!: THREE.SpotLight;
  ceiling!: THREE.Mesh;
  lampOn = 1;
  screenGain = 1;
  aftermath = false;
  clockTime = 2 * 3600 + 47 * 60 + 12;
  private lampBulb!: THREE.MeshBasicMaterial;
  private screenMat!: THREE.MeshBasicMaterial;
  private chair = new THREE.Group();
  private shard = new THREE.Group();
  private shardLight!: THREE.PointLight;
  private poster!: THREE.Mesh;
  private posterA!: THREE.Texture;
  private posterB!: THREE.Texture;
  private hands: THREE.Object3D[] = [];
  private pcLed!: THREE.MeshBasicMaterial;
  private rainTex!: THREE.Texture;
  private windowMat!: THREE.MeshBasicMaterial;
  private colliders: Collider[] = [];
  private chairCollider!: Collider;
  private lastSecond = -1;
  private ceilingParts: THREE.Object3D[] = [];
  constructor(screenTexture: THREE.Texture) {
    this.fx.uPortal.value.copy(this.screenCenter);
    this.build(screenTexture);
  }
  patch<T extends THREE.Material>(mat: T, noInfect = false): T {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.fx);
      shader.vertexShader = FX_DECL + shader.vertexShader.replace('#include <project_vertex>', FX_VERT);
      shader.fragmentShader =
        (noInfect ? '#define RFX_NO_INFECT\n' : '') +
        FX_DECL +
        shader.fragmentShader
          .replace('void main() {', 'void main() {\n' + FX_FRAG_HEAD)
          .replace('#include <dithering_fragment>', FX_FRAG_TAIL);
    };
    mat.customProgramCacheKey = () => (noInfect ? 'rfx-ni' : 'rfx');
    return mat;
  }
  private build(screenTexture: THREE.Texture) {
    const G = this.group;
    const rnd = mulberry(2024);
    const cache = new Map<string, THREE.MeshStandardMaterial>();
    const std = (color: string, rough = 0.85, metal = 0) => {
      const key = `${color}|${rough}|${metal}`;
      let m = cache.get(key);
      if (!m) {
        m = this.patch(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
        cache.set(key, m);
      }
      return m;
    };
    const basic = (params: THREE.MeshBasicMaterialParameters) => this.patch(new THREE.MeshBasicMaterial(params));
    const box = (
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent: THREE.Object3D = G,
      cast = true
    ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = cast;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const cyl = (
      rt: number,
      rb: number,
      h: number,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent: THREE.Object3D = G,
      open = false
    ) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 18, 1, open), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const plane = (w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, ry = 0, sx = 1, sy = 1) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h, sx, sy), mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      G.add(m);
      return m;
    };
    const { hw, hd, h: RH } = ROOM;
    // ---------- shell ----------
    const wallTex = wallTexture();
    const wallMat = this.patch(new THREE.MeshStandardMaterial({ map: wallTex, color: '#a7a299', roughness: 0.95 }));
    wallTex.repeat.set(3, 2);
    plane(hw * 2, RH, wallMat, 0, RH / 2, -hd, 0, 26, 14);
    plane(hw * 2, RH, wallMat, 0, RH / 2, hd, Math.PI, 26, 14);
    plane(hd * 2, RH, wallMat, -hw, RH / 2, 0, Math.PI / 2, 28, 14);
    plane(hd * 2, RH, wallMat, hw, RH / 2, 0, -Math.PI / 2, 28, 14);
    const woodTex = woodTexture();
    woodTex.repeat.set(2.4, 2.8);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 2, hd * 2, 26, 28),
      this.patch(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.62, color: '#c9b8a6' }))
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    G.add(floor);
    this.ceiling = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, hd * 2, 22, 24), std('#8f8c86', 1));
    this.ceiling.rotation.x = Math.PI / 2;
    this.ceiling.position.y = RH;
    G.add(this.ceiling);
    this.ceilingParts.push(this.ceiling);
    const baseMat = std('#2a2622', 0.7);
    box(hw * 2, 0.07, 0.015, baseMat, 0, 0.035, -hd + 0.008, G, false);
    box(hw * 2, 0.07, 0.015, baseMat, 0, 0.035, hd - 0.008, G, false);
    box(0.015, 0.07, hd * 2, baseMat, -hw + 0.008, 0.035, 0, G, false);
    box(0.015, 0.07, hd * 2, baseMat, hw - 0.008, 0.035, 0, G, false);
    this.ceilingParts.push(cyl(0.24, 0.26, 0.05, std('#b9b6ae', 0.6), 0, RH - 0.03, 0.2));
    // ---------- desk ----------
    const deskMat = std('#3a2a1f', 0.6);
    const sx = this.screenCenter.x;
    const sy = this.screenCenter.y;
    const sz = this.screenCenter.z;
    box(1.6, 0.04, 0.72, deskMat, -0.4, 0.72, -2.12);
    box(0.04, 0.7, 0.68, deskMat, -1.18, 0.35, -2.12);
    box(0.04, 0.7, 0.68, deskMat, 0.38, 0.35, -2.12);
    box(1.52, 0.3, 0.02, deskMat, -0.4, 0.52, -2.44);
    box(0.4, 0.5, 0.6, std('#30241b', 0.6), 0.16, 0.44, -2.12);
    box(0.14, 0.012, 0.012, std('#888', 0.3, 0.8), 0.16, 0.56, -1.815, G, false);
    box(0.14, 0.012, 0.012, std('#888', 0.3, 0.8), 0.16, 0.36, -1.815, G, false);
    // ---------- monitor ----------
    const plastic = std('#0d0d10', 0.45);
    box(0.64, 0.375, 0.028, plastic, sx, sy, sz - 0.016);
    box(0.05, 0.3, 0.04, plastic, sx, 0.9, sz - 0.05);
    box(0.24, 0.012, 0.18, plastic, sx, 0.746, sz - 0.04);
    this.screenMat = this.patch(new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false }), true);
    this.screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(this.screenW, this.screenH, 20, 12), this.screenMat);
    this.screenMesh.position.copy(this.screenCenter);
    G.add(this.screenMesh);
    const note1 = new THREE.Mesh(
      new THREE.PlaneGeometry(0.075, 0.075),
      this.patch(new THREE.MeshStandardMaterial({ map: noteTexture(['〆切', '朝 9:00']), roughness: 0.9 }))
    );
    note1.position.set(sx + 0.345, sy + 0.1, sz - 0.001);
    note1.rotation.z = -0.08;
    G.add(note1);
    const note2 = new THREE.Mesh(
      new THREE.PlaneGeometry(0.07, 0.07),
      this.patch(new THREE.MeshStandardMaterial({ map: noteTexture(['寝るな'], '#f0a6b4'), roughness: 0.9 }))
    );
    note2.position.set(sx + 0.35, sy - 0.02, sz - 0.0005);
    note2.rotation.z = 0.1;
    G.add(note2);
    // ---------- desk clutter ----------
    box(0.43, 0.02, 0.145, plastic, sx, 0.75, -1.95);
    const keys = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.138),
      this.patch(new THREE.MeshStandardMaterial({ map: keyboardTexture(), roughness: 0.5, emissive: '#223', emissiveIntensity: 0.4 }))
    );
    keys.rotation.x = -Math.PI / 2;
    keys.position.set(sx, 0.7606, -1.95);
    G.add(keys);
    box(0.27, 0.004, 0.23, std('#15161a', 0.9), 0.02, 0.742, -1.94, G, false);
    const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), plastic);
    mouse.scale.set(0.62, 0.36, 1);
    mouse.position.set(0.02, 0.758, -1.94);
    mouse.castShadow = true;
    G.add(mouse);
    // mug
    cyl(0.042, 0.037, 0.09, std('#c8c2b5', 0.4), -1.0, 0.785, -1.96);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.007, 8, 14), std('#c8c2b5', 0.4));
    handle.position.set(-1.045, 0.787, -1.96);
    G.add(handle);
    cyl(0.038, 0.038, 0.004, std('#1b0f08', 0.3), -1.0, 0.822, -1.96);
    // energy drinks
    cyl(0.027, 0.027, 0.125, std('#1f6b3a', 0.3, 0.7), 0.26, 0.802, -2.32);
    cyl(0.027, 0.027, 0.125, std('#1f6b3a', 0.3, 0.7), 0.19, 0.802, -2.36);
    const can = cyl(0.027, 0.027, 0.125, std('#1f6b3a', 0.3, 0.7), -0.72, 0.767, -1.84);
    can.rotation.set(Math.PI / 2, 0, 0.6);
    // cup noodle
    cyl(0.052, 0.036, 0.1, std('#d8d3c6', 0.8), -0.78, 0.79, -2.32);
    cyl(0.0525, 0.045, 0.035, std('#a8322a', 0.8), -0.78, 0.8, -2.32);
    const stick = box(0.005, 0.005, 0.23, std('#b38a57', 0.8), -0.775, 0.846, -2.3, G, false);
    stick.rotation.y = 0.5;
    const stick2 = box(0.005, 0.005, 0.23, std('#b38a57', 0.8), -0.785, 0.846, -2.31, G, false);
    stick2.rotation.y = 0.62;
    // books + papers
    const bookCols = ['#6b2f2a', '#28405e', '#4b5a33', '#73603a', '#3b3550', '#7a3f55', '#2d4f4f'];
    for (let i = 0; i < 4; i++) {
      const b = box(0.2 + rnd() * 0.04, 0.022 + rnd() * 0.02, 0.27, std(bookCols[i], 0.8), 0.2, 0.752 + i * 0.03, -2.16);
      b.rotation.y = (rnd() - 0.5) * 0.4;
    }
    for (let i = 0; i < 5; i++) {
      const p = box(0.21, 0.0015, 0.297, std('#d9d5ca', 0.9), -0.82 + rnd() * 0.06, 0.742 + i * 0.002, -2.0, G, false);
      p.rotation.y = (rnd() - 0.5) * 0.5;
    }
    const phone = box(0.07, 0.008, 0.145, plastic, 0.27, 0.746, -1.84, G, false);
    phone.rotation.y = 0.35;
    box(0.23, 0.07, 0.12, std('#5a84a8', 0.8), -0.42, 0.775, -2.4);
    box(0.09, 0.02, 0.05, std('#e8e8e8', 0.9), -0.42, 0.815, -2.4, G, false);
    // desk lamp
    cyl(0.07, 0.08, 0.02, std('#20302a', 0.4, 0.5), -1.05, 0.75, -2.33);
    const arm = box(0.014, 0.42, 0.014, std('#20302a', 0.4, 0.5), -1.03, 0.95, -2.31);
    arm.rotation.z = -0.1;
    const arm2 = box(0.014, 0.26, 0.014, std('#20302a', 0.4, 0.5), -0.95, 1.2, -2.26);
    arm2.rotation.set(0.5, 0, -1.0);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.085, 0.12, 18, 1, true),
      this.patch(new THREE.MeshStandardMaterial({ color: '#20302a', roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }))
    );
    shade.position.set(-0.86, 1.2, -2.2);
    shade.rotation.set(0.25, 0, -0.25);
    G.add(shade);
    this.lampBulb = basic({ color: new THREE.Color(3.2, 2.1, 1.1) });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), this.lampBulb);
    bulb.position.set(-0.855, 1.175, -2.195);
    G.add(bulb);
    // ---------- PC tower ----------
    box(0.2, 0.44, 0.46, std('#101114', 0.5, 0.3), -0.95, 0.22, -2.1);
    this.pcLed = basic({ color: new THREE.Color(0.2, 1.6, 2.4) });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.3, 0.004), this.pcLed);
    led.position.set(-0.89, 0.24, -1.868);
    G.add(led);
    const led2 = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.004), basic({ color: new THREE.Color(0.3, 2.2, 0.6) }));
    led2.position.set(-1.0, 0.4, -1.868);
    G.add(led2);
    box(0.3, 0.03, 0.06, std('#d6d2c8', 0.7), -1.55, 0.015, -2.32, G, false);
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.008, 0.02), basic({ color: new THREE.Color(2.4, 0.3, 0.15) }));
    sw.position.set(-1.67, 0.034, -2.32);
    G.add(sw);
    // ---------- chair ----------
    const fabric = std('#1a1c22', 0.9);
    const C = this.chair;
    box(0.46, 0.07, 0.46, fabric, 0, 0.46, 0, C);
    box(0.44, 0.62, 0.06, fabric, 0, 0.84, 0.24, C);
    box(0.05, 0.03, 0.3, plastic, -0.25, 0.62, 0.02, C);
    box(0.05, 0.03, 0.3, plastic, 0.25, 0.62, 0.02, C);
    cyl(0.028, 0.028, 0.36, std('#555', 0.3, 0.8), 0, 0.25, 0, C);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const leg = box(0.3, 0.028, 0.04, plastic, Math.cos(a) * 0.15, 0.06, Math.sin(a) * 0.15, C);
      leg.rotation.y = -a;
      const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), plastic);
      wheel.position.set(Math.cos(a) * 0.29, 0.028, Math.sin(a) * 0.29);
      C.add(wheel);
    }
    C.position.set(-0.36, 0, -1.3);
    C.rotation.y = 0.32;
    G.add(C);
    // ---------- bed ----------
    box(1.05, 0.26, 2.05, std('#3b2d22', 0.7), 1.66, 0.13, 0.85);
    box(1.0, 0.16, 2.0, std('#bdb8ae', 0.95), 1.66, 0.34, 0.85);
    box(1.04, 0.06, 1.25, std('#27324d', 0.95), 1.66, 0.45, 0.42);
    const fold = box(0.75, 0.1, 0.5, std('#27324d', 0.95), 1.5, 0.5, 1.0);
    fold.rotation.set(0.08, 0.5, -0.06);
    const fold2 = box(0.5, 0.08, 0.42, std('#2d3a58', 0.95), 1.82, 0.5, 0.75);
    fold2.rotation.set(-0.06, -0.3, 0.1);
    const pillow = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), std('#cfcbc2', 0.95));
    pillow.scale.set(0.33, 0.09, 0.2);
    pillow.position.set(1.66, 0.47, 1.62);
    pillow.rotation.y = 0.15;
    pillow.castShadow = true;
    G.add(pillow);
    box(1.05, 0.55, 0.05, std('#3b2d22', 0.7), 1.66, 0.42, 1.9);
    // ---------- shelf ----------
    const shelfMat = std('#4a382a', 0.7);
    box(0.32, 1.8, 0.03, shelfMat, -2.03, 0.9, 0.55);
    box(0.32, 1.8, 0.03, shelfMat, -2.03, 0.9, 1.6);
    box(0.02, 1.8, 1.05, shelfMat, -2.18, 0.9, 1.075);
    for (let s = 0; s < 5; s++) {
      const y = 0.02 + s * 0.445;
      box(0.32, 0.025, 1.05, shelfMat, -2.03, y, 1.075);
      if (s === 4) break;
      let z = 0.6;
      while (z < 1.5) {
        const t = 0.02 + rnd() * 0.035;
        if (rnd() > 0.14) {
          const hgt = 0.2 + rnd() * 0.14;
          const b = box(0.17 + rnd() * 0.06, hgt, t, std(bookCols[Math.floor(rnd() * bookCols.length)], 0.85), -2.02, y + 0.0125 + hgt / 2, z + t / 2, G, false);
          if (rnd() > 0.88) b.rotation.x = 0.22;
        } else z += 0.06;
        z += t + 0.003;
      }
    }
    cyl(0.06, 0.045, 0.09, std('#8a5a3c', 0.9), -2.02, 1.86, 0.75);
    const plant = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), std('#2f4a2c', 0.9));
    plant.position.set(-2.02, 1.98, 0.75);
    plant.scale.set(1, 1.3, 1);
    G.add(plant);
    box(0.12, 0.16, 0.1, std('#c9c4b8', 0.6), -2.02, 1.89, 1.2);
    box(0.2, 0.05, 0.28, std('#17181c', 0.5), -2.02, 1.84, 1.42);
    // ---------- window ----------
    this.windowMat = basic({ map: cityTexture(), color: new THREE.Color(0.7, 0.75, 0.9) });
    plane(1.1, 1.0, this.windowMat, -hw + 0.012, 1.45, -0.9, Math.PI / 2, 6, 6);
    this.rainTex = rainTexture();
    this.rainTex.repeat.set(3, 1.5);
    plane(1.1, 1.0, basic({ map: this.rainTex, transparent: true, opacity: 0.6, depthWrite: false }), -hw + 0.018, 1.45, -0.9, Math.PI / 2);
    const frame = std('#cfcabf', 0.6);
    box(0.05, 0.05, 1.2, frame, -hw + 0.03, 1.97, -0.9, G, false);
    box(0.07, 0.04, 1.24, frame, -hw + 0.04, 0.94, -0.9, G, false);
    box(0.05, 1.0, 0.05, frame, -hw + 0.03, 1.45, -1.475, G, false);
    box(0.05, 1.0, 0.05, frame, -hw + 0.03, 1.45, -0.325, G, false);
    box(0.03, 1.0, 0.03, frame, -hw + 0.03, 1.45, -0.9, G, false);
    const curtainMat = this.patch(new THREE.MeshStandardMaterial({ color: '#3d3a4c', roughness: 1, side: THREE.DoubleSide }));
    for (const [z0, w] of [
      [-1.6, 0.42],
      [-0.3, 0.3],
    ]) {
      const cg = new THREE.PlaneGeometry(w, 1.45, 14, 1);
      const pos = cg.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 46) * 0.022);
      cg.computeVertexNormals();
      const cm = new THREE.Mesh(cg, curtainMat);
      cm.position.set(-hw + 0.1, 1.33, z0 + w / 2);
      cm.rotation.y = Math.PI / 2;
      cm.castShadow = true;
      G.add(cm);
    }
    const rod = cyl(0.012, 0.012, 1.5, std('#777', 0.3, 0.8), -hw + 0.1, 2.07, -0.9);
    rod.rotation.x = Math.PI / 2;
    box(0.24, 0.27, 0.8, std('#c9c6be', 0.6), -hw + 0.12, 2.3, 0.3);
    const acLed = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.012, 0.012), basic({ color: new THREE.Color(0.3, 2.0, 0.5) }));
    acLed.position.set(-hw + 0.243, 2.2, 0.62);
    G.add(acLed);
    // ---------- door ----------
    box(0.86, 2.02, 0.05, std('#5a4433', 0.7), -1.2, 1.01, hd - 0.03);
    box(0.06, 2.1, 0.07, std('#3a2c22', 0.7), -1.66, 1.05, hd - 0.035, G, false);
    box(0.06, 2.1, 0.07, std('#3a2c22', 0.7), -0.74, 1.05, hd - 0.035, G, false);
    box(0.98, 0.06, 0.07, std('#3a2c22', 0.7), -1.2, 2.08, hd - 0.035, G, false);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), std('#9a8a60', 0.3, 0.9));
    knob.position.set(-0.9, 1.0, hd - 0.08);
    G.add(knob);
    box(0.5, 0.75, 0.06, std('#22242c', 0.95), -1.2, 1.5, hd - 0.09);
    // ---------- walls ----------
    this.posterA = posterTexture(0);
    this.posterB = posterTexture(2);
    this.poster = plane(0.52, 0.73, this.patch(new THREE.MeshStandardMaterial({ map: this.posterA, roughness: 0.8 })), 0.82, 1.55, -hd + 0.006);
    plane(0.5, 0.7, this.patch(new THREE.MeshStandardMaterial({ map: posterTexture(1), roughness: 0.8 })), hw - 0.006, 1.6, 0.95, -Math.PI / 2);
    plane(0.34, 0.34, this.patch(new THREE.MeshStandardMaterial({ map: calendarTexture(), roughness: 0.9 })), hw - 0.006, 1.5, -1.3, -Math.PI / 2);
    // clock
    const clock = new THREE.Group();
    clock.position.set(1.62, 1.98, -hd + 0.02);
    const cf = new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), this.patch(new THREE.MeshStandardMaterial({ map: clockTexture(), roughness: 0.6 })));
    clock.add(cf);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.152, 0.012, 8, 32), std('#1c1c1f', 0.4));
    clock.add(rim);
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
    // ---------- floor clutter ----------
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.4, 10, 8), this.patch(new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 1 })));
    rug.rotation.x = -Math.PI / 2;
    rug.rotation.z = 0.12;
    rug.position.set(0.15, 0.006, 0.35);
    rug.receiveShadow = true;
    G.add(rug);
    cyl(0.13, 0.1, 0.28, this.patch(new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.6, side: THREE.DoubleSide })), 0.72, 0.14, -2.2, G, true);
    const paper = std('#d6d2c7', 0.95);
    for (let i = 0; i < 7; i++) {
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035 + rnd() * 0.015, 0), paper);
      if (i < 3) p.position.set(0.72 + (rnd() - 0.5) * 0.1, 0.2 + rnd() * 0.08, -2.2 + (rnd() - 0.5) * 0.1);
      else p.position.set(0.55 + rnd() * 0.6, 0.035, -2.0 + rnd() * 0.5);
      p.rotation.set(rnd() * 3, rnd() * 3, 0);
      p.castShadow = true;
      G.add(p);
    }
    for (const [x, z, s, col] of [
      [1.0, -0.55, 0.3, '#3a3f52'],
      [0.82, -0.3, 0.22, '#5c2f2f'],
      [0.95, -1.9, 0.26, '#30342f'],
    ] as [number, number, number, string][]) {
      const cl = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), std(col, 1));
      cl.scale.set(s, 0.045, s * 0.8);
      cl.position.set(x, 0.03, z);
      cl.rotation.y = rnd() * 3;
      G.add(cl);
    }
    const bag = box(0.3, 0.42, 0.16, std('#252a36', 0.9), -0.35, 0.21, hd - 0.12);
    bag.rotation.x = -0.12;
    box(0.42, 0.3, 0.32, std('#8a6a48', 0.9), -1.85, 0.15, 2.15);
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
    this.shard.position.set(0.25, 0.07, -0.55);
    this.shard.visible = false;
    G.add(this.shard);
    // ---------- lights ----------
    this.hemi = new THREE.HemisphereLight('#3a4866', '#0e0b09', 0.55);
    G.add(this.hemi);
    this.monitorLight = new THREE.SpotLight('#9db8ff', 9, 9, 1.2, 0.9, 1.4);
    this.monitorLight.position.set(sx, sy, sz + 0.06);
    this.monitorLight.target.position.set(sx + 0.45, 0.55, 1.2);
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
    this.lamp = new THREE.SpotLight('#ffb36b', 6, 3.4, 0.8, 0.7, 1.3);
    this.lamp.position.set(-0.86, 1.18, -2.2);
    this.lamp.target.position.set(-0.72, 0.74, -2.02);
    G.add(this.lamp, this.lamp.target);
    this.lampGlow = new THREE.PointLight('#ffb36b', 0.45, 3, 1.6);
    this.lampGlow.position.set(-0.86, 1.05, -2.1);
    G.add(this.lampGlow);
    this.moon = new THREE.SpotLight('#6f8fd0', 5, 7, 0.55, 1, 1.2);
    this.moon.position.set(-hw + 0.05, 1.9, -0.9);
    this.moon.target.position.set(0.3, 0, 0.1);
    G.add(this.moon, this.moon.target);
    // ---------- colliders ----------
    this.chairCollider = { x0: -0.64, x1: -0.08, z0: -1.58, z1: -1.02, on: true };
    this.colliders = [
      { x0: -1.22, x1: 0.42, z0: -2.5, z1: -1.74, on: true },
      this.chairCollider,
      { x0: 1.1, x1: 2.2, z0: -0.2, z1: 1.95, on: true },
      { x0: -2.2, x1: -1.85, z0: 0.5, z1: 1.65, on: true },
      { x0: 0.57, x1: 0.87, z0: -2.36, z1: -2.05, on: true },
    ];
    this.setClock();
  }
  /** keeps the player inside the walls and out of the furniture */
  collide(p: THREE.Vector3, r = 0.27) {
    p.x = clamp(p.x, -ROOM.hw + r, ROOM.hw - r);
    p.z = clamp(p.z, -ROOM.hd + r, ROOM.hd - r);
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
  private setClock() {
    const t = this.clockTime;
    const s = Math.floor(t) % 60;
    const m = (t / 60) % 60;
    const h = (t / 3600) % 12;
    this.hands[0].rotation.z = -(h / 12) * TAU;
    this.hands[1].rotation.z = -(m / 60) * TAU;
    this.hands[2].rotation.z = -(s / 60) * TAU;
  }
  setScreenLight(color: THREE.ColorRepresentation, intensity: number) {
    this.monitorLight.color.set(color);
    this.monitorFill.color.set(color);
    this.screenGain = intensity;
  }
  setCeiling(on: boolean) {
    for (const p of this.ceilingParts) p.visible = on;
  }
  /** the small things that are different after you come back */
  setAftermath(on: boolean) {
    this.aftermath = on;
    this.shard.visible = on;
    this.shardLight.intensity = on ? 1.4 : 0;
    (this.poster.material as THREE.MeshStandardMaterial).map = on ? this.posterB : this.posterA;
    if (on) {
      this.chair.position.set(0.62, 0.25, -1.0);
      this.chair.rotation.set(0, 1.9, Math.PI / 2 - 0.08);
      this.chairCollider.x0 = 0.3;
      this.chairCollider.x1 = 1.3;
      this.chairCollider.z0 = -1.3;
      this.chairCollider.z1 = -0.75;
      this.windowMat.color.setRGB(0.25, 0.75, 2.2);
      this.moon.color.set('#2a7cff');
      this.moon.intensity = 7;
    } else {
      this.chair.position.set(-0.36, 0, -1.3);
      this.chair.rotation.set(0, 0.32, 0);
      this.chairCollider.x0 = -0.64;
      this.chairCollider.x1 = -0.08;
      this.chairCollider.z0 = -1.58;
      this.chairCollider.z1 = -1.02;
      this.windowMat.color.setRGB(0.7, 0.75, 0.9);
      this.moon.color.set('#6f8fd0');
      this.moon.intensity = 5;
      this.clockTime = 2 * 3600 + 47 * 60 + 12;
    }
  }
  /** returns true on the frames the second hand moves (for the tick sound) */
  update(time: number, dt: number, flicker: number): boolean {
    this.fx.uRfxTime.value = time;
    this.clockTime += dt * (this.aftermath ? -1 : 1);
    this.setClock();
    const sec = Math.floor(this.clockTime);
    const ticked = sec !== this.lastSecond;
    this.lastSecond = sec;
    this.rainTex.offset.y = (time * 0.35) % 1;
    const pulse = 0.6 + 0.4 * Math.sin(time * 1.3);
    this.pcLed.color.setRGB(0.2 * pulse, 1.6 * pulse, 2.4 * pulse);
    // lamp: steady, until the corruption starts starving it
    let lampK = this.lampOn;
    if (flicker > 0.01) {
      const n = fnoise(time * 17, 3) * 0.5 + 0.5;
      const cut = fnoise(time * 43, 9) > 0.6 - flicker * 0.9 ? 0.15 : 1;
      lampK *= clamp(1 - flicker * 0.75 * n) * (flicker > 0.3 ? cut : 1);
    }
    this.lamp.intensity = 6 * lampK;
    this.lampGlow.intensity = 0.45 * lampK;
    this.lampBulb.color.setRGB(3.2 * lampK + 0.02, 2.1 * lampK + 0.015, 1.1 * lampK + 0.01);
    const g = this.screenGain * (0.96 + 0.04 * Math.sin(time * 61));
    this.monitorLight.intensity = 9 * g;
    this.monitorFill.intensity = 0.5 * g;
    this.screenMat.color.setScalar(Math.min(1.9, 1.15 + 0.2 * (g - 1)));
    if (this.aftermath) this.shardLight.intensity = 1.2 + Math.sin(time * 2.1) * 0.35 + fnoise(time * 9, 2) * 0.2;
    return ticked;
  }
}
