import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MONO_FONT } from './textures';
/**
 * The bedroom from bsod_ex (GLB diorama + its procedural shell, night exterior and props).
 *
 * Everything in here is authored in bsod_ex's own coordinates ("room space": the monitor sits on
 * the -X wall and faces +X). The whole thing lives in `inner`, which is turned a quarter and
 * re-centred so that in world space the monitor faces +Z from the -Z wall, which is what the
 * rest of this game (portal shader, devour camera, cursor mapping) is built around.
 *
 *   world = (-room.z + OX, room.y, room.x + OZ)
 */
export const OX = -0.6;
export const OZ = -0.33;
export const roomToWorld = (x: number, y: number, z: number, out = new THREE.Vector3()) => out.set(-z + OX, y, x + OZ);
/** GLSL twins of the transform above, for the shaders that work in absolute coordinates */
const RM_GLSL = /* glsl */ `
vec3 rmW(vec3 p) { return vec3(-p.z + (${OX.toFixed(3)}), p.y, p.x + (${OZ.toFixed(3)})); }
vec3 rmL(vec3 w) { return vec3(w.z - (${OZ.toFixed(3)}), w.y, -w.x + (${OX.toFixed(3)})); }
`;
export interface RimOpts {
  color: THREE.Color;
  /** x: specular strength, y: shininess, z: rim strength */
  params: THREE.Vector3;
}
export interface PatchOpts {
  noInfect?: boolean;
  /** plaster / floor surface craft: grain, wallpaper seams, floor + ceiling occlusion */
  craft?: boolean;
  /** cheap vertex-stage fresnel rim + sheen for the Lambert props */
  rim?: RimOpts;
}
export interface BedroomCtx {
  patch<T extends THREE.Material>(mat: T, opts?: PatchOpts | boolean): T;
  /** ShaderMaterial that is dragged / torn by the portal like everything else (see room.ts) */
  fxShader(params: THREE.ShaderMaterialParameters): THREE.ShaderMaterial;
  amb: {
    uTime: THREE.IUniform<number>;
    /** 0..1, how far the blue has spread through the room */
    uInfect: THREE.IUniform<number>;
    /** world-space screen centre */
    uPortalPos: THREE.IUniform<THREE.Vector3>;
    uCamForward: THREE.IUniform<THREE.Vector3>;
    uNoiseTex: THREE.IUniform<THREE.Texture>;
    /** 1 after coming back: the painting has changed, the night outside is the wrong colour */
    uAfter: THREE.IUniform<number>;
  };
}
export interface BedroomAssets {
  bedroom: THREE.Group;
  pc: THREE.Group;
  chair: THREE.Group;
  cables: THREE.Group;
  clockTex: THREE.Texture;
  lampTex: THREE.Texture;
  artTex: THREE.Texture;
  wallDiff: THREE.Texture;
  wallNrm: THREE.Texture;
  floorDiff: THREE.Texture;
  floorNrm: THREE.Texture;
  rugDiff: THREE.Texture;
  rugNrm: THREE.Texture;
}
export async function loadBedroomAssets(): Promise<BedroomAssets> {
  const gltf = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const [bedroom, pc, chair, cables, clockTex, lampTex, artTex, wallDiff, wallNrm, floorDiff, floorNrm, rugDiff, rugNrm] =
    await Promise.all([
      gltf.loadAsync('/models/bedroom.glb'),
      gltf.loadAsync('/models/gaming_pc.glb'),
      gltf.loadAsync('/models/office_chair.glb'),
      gltf.loadAsync('/models/cables.glb'),
      tex.loadAsync('/textures/alarm_clock_diff.webp'),
      tex.loadAsync('/textures/desk_lamp_diff.webp'),
      // Henry Fuseli, "The Nightmare" (1781), public domain
      tex.loadAsync('/textures/art/nightmare_fuseli.jpg'),
      tex.loadAsync('/textures/room/wall_plaster_diff.png'),
      tex.loadAsync('/textures/room/wall_plaster_nrm.png'),
      tex.loadAsync('/textures/room/floor_parquet_diff.png'),
      tex.loadAsync('/textures/room/floor_parquet_nrm.png'),
      tex.loadAsync('/textures/room/rug_wool_diff.png'),
      tex.loadAsync('/textures/room/rug_wool_nrm.png'),
    ]);
  const surf = (t: THREE.Texture, srgb: boolean, clampEdge = false) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = clampEdge ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };
  for (const t of [clockTex, lampTex, artTex]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  }
  artTex.wrapS = artTex.wrapT = THREE.ClampToEdgeWrapping;
  return {
    bedroom: bedroom.scene,
    pc: pc.scene,
    chair: chair.scene,
    cables: cables.scene,
    clockTex,
    lampTex,
    artTex,
    wallDiff: surf(wallDiff, true),
    wallNrm: surf(wallNrm, false),
    floorDiff: surf(floorDiff, true),
    floorNrm: surf(floorNrm, false),
    // the rug map is a complete design, not a tile
    rugDiff: surf(rugDiff, true, true),
    rugNrm: surf(rugNrm, false, true),
  };
}
// ------------------------------------------------------------------ shared noise atlas
let noiseTex: THREE.DataTexture | null = null;
function hash2(ix: number, iy: number, seed: number) {
  let n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function tileValueNoise(x: number, y: number, period: number, seed: number) {
  const gx = x * period;
  const gy = y * period;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y0 = ((iy % period) + period) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function tileWorley(x: number, y: number, cells: number, seed: number) {
  const gx = x * cells;
  const gy = y * cells;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let d1 = 99;
  let d2 = 99;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = (((ix + dx) % cells) + cells) % cells;
      const cy = (((iy + dy) % cells) + cells) % cells;
      const px = ix + dx + hash2(cx, cy, seed);
      const py = iy + dy + hash2(cx, cy, seed + 97);
      const q = (gx - px) * (gx - px) + (gy - py) * (gy - py);
      if (q < d1) {
        d2 = d1;
        d1 = q;
      } else if (q < d2) d2 = q;
    }
  }
  return Math.min(1, Math.max(0, (Math.sqrt(d2) - Math.sqrt(d1)) * 1.35));
}
/** 256² tileable RGBA atlas — R: fbm, G: fine grain, B: streaks, A: cell edges */
export function sharedNoiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const q = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
  for (let y = 0; y < size; y++) {
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const i = (y * size + x) * 4;
      data[i] = q(
        tileValueNoise(nx, ny, 4, 11) * 0.5 +
          tileValueNoise(nx, ny, 8, 23) * 0.25 +
          tileValueNoise(nx, ny, 16, 37) * 0.15 +
          tileValueNoise(nx, ny, 32, 53) * 0.1
      );
      data[i + 1] = q(tileValueNoise(nx, ny, 48, 71) * 0.6 + tileValueNoise(nx, ny, 96, 89) * 0.4);
      data[i + 2] = q(tileValueNoise(nx, ny, 24, 103) * 0.35 + tileValueNoise(nx, ny * 0.25, 32, 131) * 0.65);
      data[i + 3] = q(tileWorley(nx, ny, 10, 173));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}
// ------------------------------------------------------------------ helpers
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const isStd = (m: THREE.Material): m is THREE.MeshStandardMaterial => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
function pushBox(batch: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.applyMatrix4(
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1))
  );
  batch.push(geo);
}
function merged(batch: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh | null {
  if (!batch.length) return null;
  const g = mergeGeometries(batch, false);
  for (const b of batch) b.dispose();
  return g ? new THREE.Mesh(g, mat) : null;
}
interface AtmoOpts {
  rimColor?: number;
  rimStrength?: number;
  specStrength?: number;
  shininess?: number;
}
const RAIN_STREAKS = 420;
const RAIN_SPLASHES = 96;
/** monitor screen quad of gaming_pc.glb once placed, in room space (BSOD_SCREEN_NODE) */
export const SCREEN_ROOM = new THREE.Vector3(-1.72298, 1.04514, 0.73543);
export class Bedroom {
  /** room space -> world */
  inner = new THREE.Group();
  /** everything outside the glass */
  exterior = new THREE.Group();
  /** whatever is overhead (hidden while falling back in through where the ceiling was) */
  ceilingParts: THREE.Object3D[] = [];
  chair!: THREE.Object3D;
  lampBulb!: THREE.MeshBasicMaterial;
  dustMat!: THREE.ShaderMaterial;
  private ctx: BedroomCtx;
  private a: BedroomAssets;
  private rimColors = new Map<number, THREE.Color>();
  private atmoCache = new Map<string, THREE.MeshLambertMaterial>();
  private clockCanvas!: HTMLCanvasElement;
  private clockTex!: THREE.CanvasTexture;
  private clockKey = '';
  constructor(ctx: BedroomCtx, assets: BedroomAssets) {
    this.ctx = ctx;
    this.a = assets;
    this.inner.rotation.y = -Math.PI / 2;
    this.inner.position.set(OX, 0, OZ);
    this.inner.updateMatrixWorld(true);
    this.inner.add(this.exterior);
    const wallMat = this.buildShell();
    this.buildEnclosure(wallMat);
    this.applyBoxUVs(2.45, 'Walls');
    this.applyBoxUVs(3.05, 'Floor');
    this.buildNightExterior();
    this.buildPc();
    this.buildDeskLegsAndCables();
    this.buildChair();
    this.buildProps();
    this.buildDust();
    this.buildPracticals();
    this.buildTrim();
    this.inner.traverse((o) => {
      if (!isMesh(o)) return;
      const m = o.material as THREE.Material;
      const lit = !Array.isArray(m) && ((m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial || isStd(m));
      if (!lit) return;
      o.receiveShadow = true;
      if (o.userData.noCast !== true && !m.transparent) o.castShadow = true;
    });
  }
  // ---------------------------------------------------------------- materials
  private surface(kind: 'wall' | 'floor' | 'rug'): THREE.MeshPhongMaterial {
    const a = this.a;
    const wall = kind === 'wall';
    const rug = kind === 'rug';
    const ns = wall ? 0.4 : rug ? 0.85 : 0.7;
    return this.ctx.patch(
      new THREE.MeshPhongMaterial({
        name: wall ? 'Walls' : rug ? 'material_54' : 'Floor',
        map: wall ? a.wallDiff : rug ? a.rugDiff : a.floorDiff,
        normalMap: wall ? a.wallNrm : rug ? a.rugNrm : a.floorNrm,
        normalScale: new THREE.Vector2(ns, ns),
        color: wall ? 0xf7f3ea : rug ? 0xffffff : 0xf3ebdd,
        specular: wall ? 0x0e1420 : rug ? 0x05060a : 0x241f16,
        shininess: wall ? 4 : rug ? 12 : 22,
        side: THREE.FrontSide,
      }),
      { craft: true }
    );
  }
  /** architecture-ish GLB materials: plain Lambert + surface craft */
  private arch(src: THREE.Material): THREE.Material {
    if (!isStd(src)) return this.ctx.patch(src);
    const name = src.name || '';
    if (src.map) src.map.anisotropy = 8;
    return this.ctx.patch(
      new THREE.MeshLambertMaterial({
        name,
        color: src.color.clone(),
        map: src.map,
        emissive: src.emissive.clone(),
        emissiveMap: src.emissiveMap,
        emissiveIntensity: src.emissiveIntensity,
        transparent: src.transparent,
        opacity: src.opacity,
        alphaTest: src.alphaTest,
        depthWrite: src.depthWrite,
        side: /Curtain|Window/i.test(name) ? THREE.DoubleSide : THREE.FrontSide,
      }),
      { craft: true }
    );
  }
  /** PBR prop material -> Lambert with a vertex-stage rim / sheen (what bsod_ex calls "atmospheric") */
  private atmo(src: THREE.Material, opts: AtmoOpts = {}, dedupe = true): THREE.Material {
    if (!isStd(src)) return this.ctx.patch(src);
    const rough = THREE.MathUtils.clamp(src.roughness ?? 0.65, 0.08, 1);
    const metal = THREE.MathUtils.clamp(src.metalness ?? 0.1, 0, 1);
    const needsDouble = src.transparent || src.alphaTest > 0 || /curtain|plant|leaf|glass|shade|paper|blanket/i.test(src.name || '');
    const side = needsDouble ? src.side : THREE.FrontSide;
    const rimHex = opts.rimColor ?? 0x4da8ff;
    const spec = opts.specStrength ?? 0.14 + (1 - rough) * 0.4 + metal * 0.34;
    const shin = opts.shininess ?? 14 + (1 - rough) * 52;
    const rim = opts.rimStrength ?? 0.08 + (1 - rough) * 0.16 + metal * 0.14;
    const sig = [
      src.map?.uuid ?? '-',
      src.emissiveMap?.uuid ?? '-',
      src.color.getHexString(),
      src.emissive.getHexString(),
      src.emissiveIntensity.toFixed(2),
      src.transparent ? 1 : 0,
      src.opacity.toFixed(2),
      src.alphaTest.toFixed(2),
      side,
      rimHex.toString(16),
      spec.toFixed(2),
      shin.toFixed(0),
      rim.toFixed(2),
    ].join('|');
    if (dedupe) {
      const hit = this.atmoCache.get(sig);
      if (hit) return hit;
    }
    if (src.map) {
      src.map.anisotropy = 8;
      if (src.map.generateMipmaps !== false) src.map.minFilter = THREE.LinearMipmapLinearFilter;
    }
    if (src.emissiveMap) src.emissiveMap.anisotropy = 8;
    const lam = new THREE.MeshLambertMaterial({
      name: src.name,
      color: src.color.clone(),
      map: src.map,
      emissive: src.emissive.clone(),
      emissiveMap: src.emissiveMap,
      emissiveIntensity: src.emissiveIntensity,
      transparent: src.transparent,
      opacity: src.opacity,
      alphaTest: src.alphaTest,
      depthWrite: src.depthWrite,
      side,
    });
    this.rimPatch(lam, rimHex, new THREE.Vector3(spec, shin, rim));
    if (dedupe) this.atmoCache.set(sig, lam);
    return lam;
  }
  private rimPatch(lam: THREE.MeshLambertMaterial, rimHex: number, params: THREE.Vector3) {
    let color = this.rimColors.get(rimHex);
    if (!color) {
      color = new THREE.Color(rimHex);
      this.rimColors.set(rimHex, color);
    }
    lam.userData.rim = { color, params } satisfies RimOpts;
    this.ctx.patch(lam, { rim: { color, params } });
  }
  /**
   * Folds the static sub-meshes of a GLB into as few draw calls as possible: one per shared
   * material, and all untextured solid-colour props into a single vertex-coloured batch.
   */
  private mergeStatic(root: THREE.Object3D, skip?: (o: THREE.Object3D) => boolean) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map<THREE.Material, THREE.Mesh[]>();
    const solid: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (o === root || skip?.(o) || !isMesh(o) || !o.visible || Array.isArray(o.material)) return;
      const mat = o.material as THREE.MeshLambertMaterial;
      if (!mat || mat.transparent || mat.alphaTest > 0) return;
      const geo = o.geometry;
      if (!geo.attributes.position || !geo.attributes.normal) return;
      const plain =
        mat.isMeshLambertMaterial &&
        mat.userData.rim !== undefined &&
        !mat.map &&
        !mat.emissiveMap &&
        mat.emissive.getHex() === 0 &&
        mat.side === THREE.FrontSide &&
        !geo.attributes.color;
      if (plain) {
        solid.push(o);
        return;
      }
      const b = buckets.get(mat);
      if (b) b.push(o);
      else buckets.set(mat, [o]);
    });
    const bake = (m: THREE.Mesh, keep: string[]) => {
      const g = m.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
      return g;
    };
    for (const [mat, meshes] of buckets) {
      if (meshes.length < 2) continue;
      const hasUv = Boolean(meshes[0].geometry.attributes.uv);
      if (!meshes.every((m) => Boolean(m.geometry.attributes.uv) === hasUv && !m.geometry.attributes.color)) continue;
      const mesh = merged(
        meshes.map((m) => bake(m, ['position', 'normal', 'uv'])),
        mat
      );
      if (!mesh) continue;
      for (const m of meshes) m.removeFromParent();
      mesh.name = `Merged_${mat.name || 'Static'}`;
      root.add(mesh);
    }
    if (solid.length >= 2) {
      const sample = solid[0].material as THREE.MeshLambertMaterial;
      const geos = solid.map((m) => {
        const c = (m.material as THREE.MeshLambertMaterial).color;
        const g = bake(m, ['position', 'normal']);
        const n = g.attributes.position.count;
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return g;
      });
      const vtx = new THREE.MeshLambertMaterial({ name: 'Merged_VertexColored', color: 0xffffff, vertexColors: true, side: THREE.FrontSide });
      const rim = sample.userData.rim as RimOpts;
      vtx.userData.rim = rim;
      this.ctx.patch(vtx, { rim });
      const mesh = merged(geos, vtx);
      if (mesh) {
        for (const m of solid) m.removeFromParent();
        mesh.name = 'Merged_Untextured_Props';
        root.add(mesh);
      }
    }
  }
  /** world-metre box projection, done in room space so plank and plaster directions match bsod_ex */
  private applyBoxUVs(tile: number, matName: string) {
    const inv = 1 / tile;
    const invInner = new THREE.Matrix4().copy(this.inner.matrixWorld).invert();
    const m4 = new THREE.Matrix4();
    const m3 = new THREE.Matrix3();
    const pos = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    this.inner.updateMatrixWorld(true);
    this.inner.traverse((o) => {
      if (!isMesh(o) || Array.isArray(o.material) || o.material.name !== matName) return;
      const geo = o.geometry;
      const pA = geo.getAttribute('position');
      const nA = geo.getAttribute('normal');
      if (!pA || !nA) return;
      m4.multiplyMatrices(invInner, o.matrixWorld);
      m3.getNormalMatrix(m4);
      const uv = new Float32Array(pA.count * 2);
      for (let i = 0; i < pA.count; i++) {
        pos.fromBufferAttribute(pA, i).applyMatrix4(m4);
        nrm.fromBufferAttribute(nA, i).applyMatrix3(m3).normalize();
        const ax = Math.abs(nrm.x);
        const ay = Math.abs(nrm.y);
        const az = Math.abs(nrm.z);
        let u: number;
        let w: number;
        if (ay >= ax && ay >= az) {
          u = pos.x;
          w = pos.z;
        } else if (ax >= az) {
          u = pos.z;
          w = pos.y;
        } else {
          u = pos.x;
          w = pos.y;
        }
        uv[i * 2] = u * inv;
        uv[i * 2 + 1] = w * inv;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    });
  }
  // ---------------------------------------------------------------- the diorama itself
  private buildShell(): THREE.MeshPhongMaterial {
    const root = this.a.bedroom;
    const cache = new Map<THREE.Material, THREE.Material>();
    let wallMat: THREE.MeshPhongMaterial | null = null;
    // the shell is a handful of huge triangles; the portal needs something it can actually bend
    const tess = new TessellateModifier(0.34, 14);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!isMesh(o)) return;
      const olds = Array.isArray(o.material) ? o.material : [o.material];
      const news = olds.map((m) => {
        let c = cache.get(m);
        if (c) return c;
        const n = m.name || '';
        const isArch =
          n.includes('Walls') ||
          n.includes('Floor') ||
          n.includes('material_54') ||
          n.includes('Blanket') ||
          n.includes('Bedspread') ||
          n.includes('BedUnit') ||
          n.includes('Curtain') ||
          n.includes('RoofWindow') ||
          n === 'Window' ||
          n === 'radiator' ||
          n === 'Stool' ||
          n === 'material_47';
        if (n === 'Walls' || n === 'Floor' || n === 'material_54') c = this.surface(n === 'Walls' ? 'wall' : n === 'Floor' ? 'floor' : 'rug');
        else if (isArch) c = this.arch(m);
        else c = this.atmo(m, { rimColor: 0x3b96ff });
        if (n === 'Walls') wallMat = c as THREE.MeshPhongMaterial;
        cache.set(m, c);
        return c;
      });
      o.material = Array.isArray(o.material) ? news : news[0];
      const first = olds[0]?.name || '';
      if (first === 'Walls' || first === 'Floor') {
        o.geometry = tess.modify(o.geometry);
        o.userData.noCast = true;
      }
      // the roof lights and the loose glass are what you would see from above
      if (/RoofWindow/i.test(o.name) || /Glass_0$/.test(o.name)) {
        o.userData.keep = true;
        this.ceilingParts.push(o);
      }
    });
    this.mergeStatic(root, (o) => o.userData.keep === true);
    this.inner.add(root);
    return wallMat ?? this.surface('wall');
  }
  /** the diorama is cut open on two sides: close it with the missing walls and a ceiling */
  private buildEnclosure(wallMat: THREE.MeshPhongMaterial) {
    const add = (w: number, h: number, sx: number, sy: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h, sx, sy), wallMat);
      m.userData.noCast = true;
      this.inner.add(m);
      return m;
    };
    // the wall behind the desk (the one that gets eaten)
    const west = add(4.56, 3.16, 34, 24);
    west.rotation.y = Math.PI * 0.5;
    west.position.set(-2.062, 1.59, -0.6);
    const south = add(4.86, 3.16, 30, 20);
    south.rotation.y = Math.PI;
    south.position.set(0.34, 1.59, 1.646);
    const ceiling = add(4.86, 3.18, 24, 16);
    ceiling.rotation.x = Math.PI * 0.5;
    ceiling.position.set(0.34, 3.152, 0.08);
    this.ceilingParts.push(ceiling);
    // light from the hallway under the door
    const crack = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.018), this.ctx.patch(new THREE.MeshBasicMaterial({ color: 0x45608a })));
    crack.rotation.y = Math.PI;
    crack.position.set(1.18, 0.029, 1.594);
    this.inner.add(crack);
  }
  private buildPc() {
    const root = this.a.pc;
    root.position.set(-1.58, 0.73, 0.42);
    root.scale.setScalar(0.105);
    root.updateMatrixWorld(true);
    const cache = new Map<THREE.Material, THREE.Material>();
    const isScreen = (o: THREE.Object3D) => o.name === 'BSOD_SCREEN_NODE';
    root.traverse((o) => {
      if (!isMesh(o)) return;
      const raw = Array.isArray(o.material) ? o.material[0] : o.material;
      if (isScreen(o) || raw?.name === 'BSOD_SCREEN_MAT') {
        // this game draws its own screen in that exact spot
        o.visible = false;
        return;
      }
      const olds = Array.isArray(o.material) ? o.material : [o.material];
      const news = olds.map((m) => {
        let c = cache.get(m);
        if (c) return c;
        if (m.name === 'Material' && isStd(m)) {
          // desk top
          if (m.map) m.map.anisotropy = 8;
          c = this.ctx.patch(new THREE.MeshLambertMaterial({ name: m.name, color: m.color.clone(), map: m.map, side: THREE.FrontSide }), { craft: true });
        } else c = this.atmo(m, { rimColor: 0x4ca8ff, specStrength: 0.36, shininess: 48 });
        cache.set(m, c);
        return c;
      });
      o.material = Array.isArray(o.material) ? news : news[0];
    });
    root.getObjectByName('BSOD_SCREEN_NODE')?.removeFromParent();
    this.mergeStatic(root);
    this.inner.add(root);
  }
  private buildDeskLegsAndCables() {
    const legs: THREE.BufferGeometry[] = [];
    for (const [x, z] of [
      [-1.98, -0.14],
      [-1.3, -0.14],
      [-1.98, 1.3],
      [-1.3, 1.3],
    ])
      pushBox(legs, 0.045, 0.7, 0.045, x, 0.365, z);
    const legMesh = merged(legs, this.ctx.patch(new THREE.MeshLambertMaterial({ color: 0x12151c })));
    if (legMesh) this.inner.add(legMesh);
    const cable = this.a.cables;
    cable.traverse((o) => {
      if (isMesh(o)) o.material = this.atmo(o.material as THREE.Material);
    });
    cable.position.set(-1.82, 0.72, 0.36);
    cable.rotation.set(0.3, Math.PI * 0.5, 0.45);
    cable.scale.setScalar(0.62);
    this.inner.add(cable);
  }
  private buildChair() {
    this.chair = this.a.chair;
    this.chair.scale.setScalar(0.75);
    this.chair.traverse((o) => {
      if (isMesh(o)) o.material = this.atmo(o.material as THREE.Material, { rimColor: 0x3b96ff, specStrength: 0.28 });
    });
    this.inner.add(this.chair);
  }
  private buildProps() {
    const P = <T extends THREE.Material>(m: T) => this.ctx.patch(m);
    const lampTex = this.a.lampTex;
    const lampMat = P(new THREE.MeshLambertMaterial({ map: lampTex, color: 0x9aa4b8 }));
    const lamp = new THREE.Group();
    lamp.position.set(-1.74, 0.756, 1.2);
    lamp.add(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.02, 12), lampMat));
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.012, 0.32, 8), lampMat);
    stem.position.set(-0.02, 0.16, 0);
    stem.rotation.z = -0.18;
    lamp.add(stem);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.075, 0.12, 12, 1, true),
      P(new THREE.MeshLambertMaterial({ map: lampTex, color: 0x7e8799, side: THREE.DoubleSide }))
    );
    shade.position.set(0.04, 0.3, -0.02);
    shade.rotation.z = 0.45;
    lamp.add(shade);
    this.lampBulb = P(new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.1, 1.1) }));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), this.lampBulb);
    bulb.position.set(0.045, 0.275, -0.02);
    lamp.add(bulb);
    this.inner.add(lamp);
    const mug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.036, 0.092, 12),
      this.atmo(new THREE.MeshStandardMaterial({ color: 0xd8dde8, roughness: 0.22, metalness: 0.05 }), { rimColor: 0x62b4ff })
    );
    mug.position.set(-1.38, 0.802, 1.06);
    this.inner.add(mug);
    // bedside alarm clock: LED digits on a canvas
    this.clockCanvas = document.createElement('canvas');
    this.clockCanvas.width = 512;
    this.clockCanvas.height = 256;
    this.clockTex = new THREE.CanvasTexture(this.clockCanvas);
    this.clockTex.colorSpace = THREE.SRGBColorSpace;
    this.clockTex.anisotropy = 8;
    this.setClock('02:47', false);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.065, 0.16), P(new THREE.MeshLambertMaterial({ map: this.a.clockTex, color: 0x333844 })));
    body.position.set(-1.62, 0.56, -2.12);
    body.rotation.y = 0.42;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.135, 0.05), P(new THREE.MeshBasicMaterial({ map: this.clockTex })));
    face.rotation.y = Math.PI * 0.5;
    face.position.set(0.056, 0.004, 0);
    body.add(face);
    this.inner.add(body);
  }
  setClock(text: string, blue: boolean) {
    const key = `${text}|${blue ? 1 : 0}`;
    if (key === this.clockKey) return;
    this.clockKey = key;
    const g = this.clockCanvas.getContext('2d')!;
    g.fillStyle = '#05070c';
    g.fillRect(0, 0, 512, 256);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold 132px ${MONO_FONT}`;
    // unlit segments behind the lit ones
    g.fillStyle = blue ? 'rgba(56, 168, 255, 0.08)' : 'rgba(255, 59, 59, 0.08)';
    g.fillText('88:88', 256, 132);
    g.fillStyle = blue ? '#38a8ff' : '#ff3b3b';
    g.fillText(text, 256, 132);
    this.clockTex.needsUpdate = true;
  }
  /** dust caught in the glow of the screen */
  private buildDust() {
    const n = 72;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = -1.65 + Math.random() * 1.9;
      pos[i * 3 + 1] = 0.55 + Math.random() * 1.25;
      pos[i * 3 + 2] = 0.05 + Math.random() * 1.35;
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: this.ctx.amb.uTime,
        uPull: { value: 0 },
        uGain: { value: 1 },
        uColor: { value: new THREE.Color(0.42, 0.78, 1.0) },
        uPortal: { value: SCREEN_ROOM.clone() },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uPull;
        uniform vec3 uPortal;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.35 + aSeed) * 0.06;
          p.y += mod(uTime * 0.035 + aSeed * 0.1, 0.9) - 0.45;
          p.z += cos(uTime * 0.31 + aSeed * 1.3) * 0.06;
          if (uPull > 0.01) {
            float t = fract(uTime * (0.8 + uPull * 2.5) + fract(aSeed));
            p = mix(p, uPortal, t * clamp(uPull * 1.5, 0.0, 1.0));
          }
          float dMon = distance(p, uPortal);
          vAlpha = smoothstep(2.1, 0.25, dMon) * (0.35 + 0.65 * sin(uTime * 1.8 + aSeed));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(5.5 / max(0.4, -mv.z), 1.2, 3.8);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        uniform float uGain;
        uniform vec3 uColor;
        void main() {
          float soft = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(uColor, soft * vAlpha * 0.55 * uGain);
        }
      `,
    });
    const pts = new THREE.Points(geo, this.dustMat);
    pts.frustumCulled = false;
    this.inner.add(pts);
  }
  // ---------------------------------------------------------------- outside the glass
  private buildNightExterior() {
    const amb = this.ctx.amb;
    const X = this.exterior;
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 9),
      new THREE.ShaderMaterial({
        depthWrite: false,
        fog: false,
        uniforms: { uInfect: amb.uInfect, uTime: amb.uTime, uAfter: amb.uAfter },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform float uInfect;
          uniform float uTime;
          uniform float uAfter;
          float h21(vec2 p) {
            p = fract(p * vec2(443.897, 441.423));
            p += dot(p, p + 19.19);
            return fract(p.x * p.y);
          }
          void main() {
            float h = clamp(vUv.y, 0.0, 1.0);
            vec3 col = mix(vec3(0.055, 0.085, 0.16), vec3(0.008, 0.014, 0.038), pow(h, 0.65));
            vec2 moon = vec2(0.30, 0.34);
            float d = length((vUv - moon) * vec2(1.0, 0.78));
            col += vec3(0.55, 0.68, 0.92) * exp(-d * 34.0) * 0.55;
            col += vec3(0.86, 0.92, 1.0) * smoothstep(0.016, 0.006, d) * 0.9;
            vec2 cell = floor(vUv * 90.0);
            float star = step(0.9955, h21(cell));
            col += vec3(0.75, 0.85, 1.0) * star * smoothstep(0.25, 0.9, h) * (0.6 + 0.4 * sin(uTime * 2.0 + cell.x));
            col = mix(col, vec3(0.02, 0.10, 0.28), clamp(uInfect, 0.0, 1.0) * 0.8);
            // afterwards the night is the colour of the screen
            col = mix(col, vec3(0.03, 0.2, 0.75) * (0.75 + 0.5 * pow(1.0 - h, 2.0)) + col * 0.6, uAfter);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    sky.rotation.y = -Math.PI * 0.5;
    sky.position.set(5.4, 2.4, -0.6);
    X.add(sky);
    // three receding rows of towers with a few lit windows
    const layers = [
      { x: 5.0, tint: 0x0a1428, count: 14, hMin: 1.4, hMax: 5.2, wMin: 0.34, wMax: 0.85, seed: 11 },
      { x: 4.4, tint: 0x070f20, count: 10, hMin: 1.0, hMax: 3.6, wMin: 0.4, wMax: 0.95, seed: 29 },
      { x: 3.9, tint: 0x050b18, count: 7, hMin: 0.8, hMax: 2.4, wMin: 0.5, wMax: 1.1, seed: 47 },
    ];
    let sc = 0;
    const wins: THREE.BufferGeometry[] = [];
    for (const L of layers) {
      const batch: THREE.BufferGeometry[] = [];
      let cursor = -4.2;
      for (let i = 0; i < L.count; i++) {
        const rnd = (n: number) => Math.abs(Math.sin((sc + n) * 12.9898 + L.seed) * 43758.5453) % 1;
        const w = L.wMin + rnd(1) * (L.wMax - L.wMin);
        const h = L.hMin + rnd(2) * (L.hMax - L.hMin);
        const z = cursor + w * 0.5;
        cursor += w + 0.1 + rnd(3) * 0.25;
        sc++;
        pushBox(batch, 0.3, h, w, L.x, h * 0.5 - 0.35, z);
        const rows = Math.max(2, Math.floor(h / 0.44));
        const cols = Math.max(2, Math.floor(w / 0.18));
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const lit = Math.abs(Math.sin((r * 37 + c * 91 + sc * 13 + L.seed) * 0.7)) % 1;
            if (lit < 0.74) continue;
            const wy = 0.16 + r * 0.44;
            if (wy > h - 0.35) continue;
            const wg = new THREE.PlaneGeometry(0.055, 0.075);
            wg.applyMatrix4(
              new THREE.Matrix4().compose(
                new THREE.Vector3(L.x - 0.16, wy, z - w * 0.5 + 0.09 + c * 0.18),
                new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI * 0.5, 0)),
                new THREE.Vector3(1, 1, 1)
              )
            );
            wins.push(wg);
          }
        }
      }
      const body = merged(batch, new THREE.MeshBasicMaterial({ color: L.tint }));
      if (body) X.add(body);
    }
    const winMesh = merged(wins, new THREE.MeshBasicMaterial({ color: 0x8cb8e4, transparent: true, opacity: 0.78, depthWrite: false }));
    if (winMesh) X.add(winMesh);
    // rain: sheets beyond the window, and a second field that dies on the skylight
    const streakGeo = new THREE.PlaneGeometry(0.0085, 0.42);
    const sd = new Float32Array(RAIN_STREAKS * 4);
    for (let i = 0; i < RAIN_STREAKS; i++) {
      const overSkylight = i >= 260;
      if (!overSkylight) {
        sd[i * 4] = 2.92 + Math.random() * 1.92;
        sd[i * 4 + 2] = -2.65 + Math.random() * 4.2;
      } else {
        sd[i * 4] = -1.78 + Math.random() * 4.24;
        sd[i * 4 + 2] = -2.82 + Math.random() * 1.28;
      }
      sd[i * 4 + 1] = Math.random();
      sd[i * 4 + 3] = (overSkylight ? 10 : 0) + 0.72 + Math.random() * 0.65;
    }
    streakGeo.setAttribute('aStreak4', new THREE.InstancedBufferAttribute(sd, 4));
    const streaks = new THREE.InstancedMesh(
      streakGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: amb.uTime, uInfect: amb.uInfect },
        vertexShader: /* glsl */ `
          attribute vec4 aStreak4;
          uniform float uTime;
          varying vec2 vUv;
          varying float vAlpha;
          ${RM_GLSL}
          void main() {
            vUv = uv;
            float isSky = step(5.0, aStreak4.w);
            float spdSeed = aStreak4.w - isSky * 10.0;
            float fallSpan = mix(4.6, 3.0, isSky);
            float yTop = mix(4.3, 4.9, isSky);
            float cycle = fract(aStreak4.y + uTime * (1.85 * spdSeed));
            float windZ = cycle * 0.42;
            // the sloped skylight: y = 2.33 + (z + 2.16) * 1.088. Rain above it must die ON the glass.
            float skyZ = aStreak4.z + windZ;
            float roofY = 2.33 + (skyZ + 2.16) * 1.088 + 0.10;
            float floorY = mix(yTop - fallSpan, roofY, isSky);
            float cy = yTop - cycle * max(0.12, yTop - floorY);
            vec3 camL = rmL(cameraPosition);
            vec3 center = vec3(aStreak4.x, cy, aStreak4.z + windZ);
            vec3 rainAxis = normalize(vec3(-0.04, -1.0, 0.11));
            vec3 sideAxis = normalize(cross(rainAxis, normalize(camL - center)));
            vec3 p = center + sideAxis * position.x + (-rainAxis) * (position.y * spdSeed);
            float distFade = smoothstep(5.4, 2.7, distance(camL, center));
            float impactFade = mix(1.0, smoothstep(1.0, 0.88, cycle), isSky);
            vAlpha = (0.30 + 0.45 * distFade) * impactFade;
            gl_Position = projectionMatrix * viewMatrix * vec4(rmW(p), 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          varying float vAlpha;
          uniform float uInfect;
          void main() {
            float taper = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.15, vUv.y);
            float core = smoothstep(0.5, 0.05, abs(vUv.x - 0.5));
            vec3 col = mix(vec3(0.58, 0.74, 0.98), vec3(0.22, 0.72, 1.0), uInfect);
            gl_FragColor = vec4(col, taper * core * vAlpha * 0.46);
          }
        `,
      }),
      RAIN_STREAKS
    );
    streaks.frustumCulled = false;
    streaks.renderOrder = 2;
    X.add(streaks);
    const splashGeo = new THREE.RingGeometry(0.18, 0.5, 10, 1);
    splashGeo.rotateX(-Math.PI * 0.5);
    const sp = new Float32Array(RAIN_SPLASHES * 4);
    for (let i = 0; i < RAIN_SPLASHES; i++) {
      sp[i * 4] = 2.84 + Math.random() * 0.22;
      sp[i * 4 + 1] = 0.65;
      sp[i * 4 + 2] = -1.95 + Math.random() * 2.8;
      sp[i * 4 + 3] = Math.random();
    }
    splashGeo.setAttribute('aSplash4', new THREE.InstancedBufferAttribute(sp, 4));
    const splashes = new THREE.InstancedMesh(
      splashGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: amb.uTime },
        vertexShader: /* glsl */ `
          attribute vec4 aSplash4;
          uniform float uTime;
          varying float vLife;
          ${RM_GLSL}
          void main() {
            float age = fract(uTime * 3.4 + aSplash4.w * 13.7);
            vLife = 1.0 - age;
            float r = 0.015 + age * 0.065;
            vec3 p = aSplash4.xyz + vec3(position.x * r, age * 0.018 * (1.0 - age), position.z * r);
            gl_Position = projectionMatrix * viewMatrix * vec4(rmW(p), 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vLife;
          void main() {
            gl_FragColor = vec4(0.68, 0.84, 1.0, vLife * 0.42);
          }
        `,
      }),
      RAIN_SPLASHES
    );
    splashes.frustumCulled = false;
    splashes.renderOrder = 2;
    X.add(splashes);
  }
  /** wet glass: sliding drops that refract an out-of-focus city, condensation wiped by their wakes */
  private rainGlass(aspX: number, aspY: number, skylight: boolean): THREE.ShaderMaterial {
    const amb = this.ctx.amb;
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      uniforms: {
        uTime: amb.uTime,
        uInfect: amb.uInfect,
        uPortalPos: amb.uPortalPos,
        uNoiseTex: amb.uNoiseTex,
        uGridAspect: { value: new THREE.Vector2(aspX, aspY) },
        uIsSkylight: { value: skylight ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vWorldTangent;
        varying vec3 vWorldBitangent;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          mat3 nMat = mat3(modelMatrix);
          vWorldNormal = normalize(nMat * normal);
          vWorldTangent = normalize(nMat * vec3(1.0, 0.0, 0.0));
          vWorldBitangent = normalize(nMat * vec3(0.0, 1.0, 0.0));
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vWorldTangent;
        varying vec3 vWorldBitangent;
        uniform float uTime;
        uniform float uInfect;
        uniform vec3 uPortalPos;
        uniform sampler2D uNoiseTex;
        uniform vec2 uGridAspect;
        uniform float uIsSkylight;
        vec3 hash13(float p) {
          vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.11369, 0.13787));
          p3 += dot(p3, p3.yzx + 19.19);
          return fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
        }
        // vec4(gradX, gradY, dropMask, wakeClear) for one octave of sliding drops
        vec4 rainDropLayer(vec2 uv, float t, float scale) {
          vec2 grid = vec2(8.0, 2.2) * scale;
          vec2 st = uv * grid;
          float colId = floor(st.x);
          st.y += fract(sin(colId * 127.1) * 43758.5453);
          vec2 cellId = floor(st);
          vec3 n = hash13(cellId.x * 37.0 + cellId.y * 251.0 + scale * 19.0);
          vec2 p = fract(st) - vec2(0.5, 0.0);
          // stick-slip: runs, pauses, slips again
          float phase = t * (0.68 + n.z * 0.55) + n.x * 6.2831853;
          float slip = phase + sin(phase + sin(phase * 0.55) * 0.65) * 0.42;
          float dropY = 0.84 - fract(slip * 0.24 + n.y) * 0.72;
          float wiggle = (n.x - 0.5) * 0.46 + sin(uv.y * 22.0 * scale + n.y * 12.0) * 0.10 * (0.5 + n.z);
          float dx = (p.x - wiggle) * (1.0 / 0.28);
          float dy = (p.y - dropY) * (grid.x / grid.y) * (1.0 / 0.28);
          float tearY = dy > 0.0 ? dy * 0.78 : dy * 1.12;
          float dist = length(vec2(dx, tearY));
          float mainDrop = smoothstep(1.0, 0.18, dist);
          float above = smoothstep(dropY - 0.02, dropY + 0.08, p.y);
          float trailEnv = smoothstep(1.0, dropY, p.y) * above;
          float trailSubY = fract(p.y * 5.0 - n.z * 3.0) - 0.5;
          float trailDist = length(vec2(dx * 1.75, trailSubY * 2.2));
          float trailBead = smoothstep(0.85, 0.15, trailDist) * trailEnv * 0.78;
          float wakeClear = smoothstep(0.95, 0.25, abs(dx)) * trailEnv;
          float mask = max(mainDrop, trailBead);
          vec2 grad = vec2(0.0);
          if (mainDrop > 0.01) grad += vec2(-dx, -tearY) * mainDrop * 0.95;
          if (trailBead > 0.01) grad += vec2(-dx * 1.75, -trailSubY * 2.2) * trailBead * 0.65;
          return vec4(grad, mask, wakeClear);
        }
        vec3 mistBeads(vec2 uv, float t) {
          vec2 st = uv * 42.0;
          vec2 id = floor(st);
          vec3 h = hash13(id.x * 73.1 + id.y * 193.7);
          vec2 p = fract(st) - 0.5 - (h.xy - 0.5) * 0.45;
          float r = length(p) * (1.35 + h.z * 0.9);
          float fade = smoothstep(0.0, 0.2, fract(t * 0.07 + h.z)) * smoothstep(1.0, 0.65, fract(t * 0.07 + h.z));
          float m = smoothstep(0.42, 0.08, r) * fade * step(0.32, h.x);
          return vec3(-p * 3.2 * m, m);
        }
        // out-of-focus wet night city + moon, as seen upside-down inside each drop
        vec3 sampleNightRefraction(vec2 refrUv, float lightning, float infect) {
          float h = clamp(refrUv.y, 0.0, 1.0);
          vec3 sky = mix(vec3(0.06, 0.11, 0.24), vec3(0.012, 0.024, 0.068), pow(h, 0.7));
          sky += vec3(0.35, 0.48, 0.78) * lightning * 0.55;
          vec2 bGrid = refrUv * vec2(11.0, 6.0);
          vec2 bId = floor(bGrid);
          vec3 bh = hash13(bId.x * 41.0 + bId.y * 157.0);
          vec2 bp = fract(bGrid) - 0.5 - (bh.xy - 0.5) * 0.35;
          float orb = smoothstep(0.44, 0.12, length(bp)) * step(0.56, bh.z) * smoothstep(0.72, 0.15, h);
          vec3 bokehCol = bh.x < 0.48 ? vec3(1.0, 0.68, 0.30) : (bh.x < 0.82 ? vec3(0.36, 0.76, 1.0) : vec3(1.0, 0.26, 0.38));
          sky += bokehCol * orb * (1.0 - uIsSkylight * 0.72) * 0.95;
          float moonD = length(refrUv - vec2(0.32, 0.68));
          sky += vec3(0.78, 0.88, 1.0) * exp(-moonD * 9.5) * 0.58;
          return mix(sky, vec3(0.02, 0.38, 0.92), infect * 0.72);
        }
        void main() {
          vec2 metricUv = vUv * uGridAspect;
          float t = uTime;
          float speedMul = mix(1.0, 1.28, uIsSkylight);
          vec4 d1 = rainDropLayer(metricUv, t * speedMul, 1.0);
          vec4 d2 = rainDropLayer(metricUv + vec2(0.37, 0.19), t * speedMul * 1.24 + 4.7, 1.85);
          vec3 mist = mistBeads(metricUv, t);
          // rings where rain strikes the pitched roof glass directly
          vec2 impGrad = vec2(0.0);
          float impRing = 0.0;
          if (uIsSkylight > 0.5) {
            vec2 rSt = metricUv * 4.5;
            vec2 rId = floor(rSt);
            vec3 rh = hash13(rId.x * 59.0 + rId.y * 131.0 + floor(t * 2.4));
            float rAge = fract(t * 2.4 + rh.z);
            vec2 rp = fract(rSt) - 0.5 - (rh.xy - 0.5) * 0.4;
            float wave = exp(-abs(length(rp) - rAge * 0.46) * 28.0) * (1.0 - rAge) * step(0.45, rh.x);
            impRing = wave;
            impGrad = normalize(rp + vec2(1e-4)) * wave * 0.85;
          }
          vec2 totalGrad = d1.xy + d2.xy * 0.82 + mist.xy * 0.38 + impGrad;
          float dropMask = clamp(max(max(d1.z, d2.z * 0.9), mist.z * 0.65) + impRing * 0.5, 0.0, 1.0);
          float wakeClear = clamp(d1.w + d2.w * 0.85, 0.0, 1.0);
          vec4 fogNoise = texture2D(uNoiseTex, metricUv * 0.42 + vec2(0.0, uTime * 0.004));
          float borderCool = 1.0 - (
            smoothstep(0.0, 0.26, vUv.x) * smoothstep(1.0, 0.74, vUv.x) *
            smoothstep(0.0, 0.26, vUv.y) * smoothstep(1.0, 0.74, vUv.y)
          );
          float condensation = clamp((0.22 + 0.52 * borderCool + (fogNoise.r - 0.5) * 0.18) * (1.0 - wakeClear * 0.88) * (1.0 - dropMask * 0.92), 0.0, 0.78);
          // far-off sheet lightning every ~19 s
          float flashWave = pow(max(0.0, sin(uTime * 0.33) * sin(uTime * 1.91)), 18.0);
          vec3 N = normalize(vWorldNormal + vWorldTangent * (totalGrad.x * 0.62) + vWorldBitangent * (totalGrad.y * 0.62));
          vec3 V = normalize(cameraPosition - vWorldPos);
          float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
          float fresnel = pow(1.0 - ndv, 3.2);
          vec2 refrUv = clamp(vUv - totalGrad * 0.14 + (vec2(-V.x, V.y) * 0.035), 0.0, 1.0);
          vec3 refrCol = sampleNightRefraction(refrUv, flashWave, uInfect);
          // highlights from the moon outside and from the monitor behind you
          vec3 moonDir = normalize(vec3(0.36, 0.54, 0.76));
          vec3 monDir = normalize(uPortalPos - vWorldPos);
          float moonSpec = pow(max(dot(N, normalize(moonDir + V)), 0.0), 72.0) * (0.35 + 1.85 * dropMask);
          float monSpec = pow(max(dot(N, normalize(monDir + V)), 0.0), 54.0) * (0.20 + 1.45 * dropMask);
          vec3 fogCol = mix(vec3(0.11, 0.17, 0.28), vec3(0.05, 0.28, 0.58), uInfect * 0.6) + vec3(0.22, 0.30, 0.48) * flashWave;
          vec3 col = mix(fogCol, refrCol * 1.35, dropMask);
          col += vec3(0.86, 0.93, 1.0) * moonSpec;
          col += mix(vec3(0.10, 0.56, 1.0), vec3(0.35, 0.85, 1.0), dropMask) * (monSpec * 0.85 + fresnel * 0.28);
          float paneEdge = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x)
                         * smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.97, vUv.y);
          float alpha = clamp((condensation * 0.42 + dropMask * 0.72 + moonSpec * 0.55 + monSpec * 0.40 + fresnel * 0.16) * paneEdge, 0.0, 0.92);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
  }
  // ---------------------------------------------------------------- things that only light does
  private buildPracticals() {
    const amb = this.ctx.amb;
    const P = <T extends THREE.Material>(m: T, o?: PatchOpts) => this.ctx.patch(m, o);
    // moonlight through the wet window, rippling across the floorboards
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 3.3),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: amb.uTime, uInfect: amb.uInfect, uAfter: amb.uAfter, uNoiseTex: amb.uNoiseTex },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform float uTime;
          uniform float uInfect;
          uniform float uAfter;
          uniform sampler2D uNoiseTex;
          void main() {
            vec2 c = (vUv - 0.5) * 2.0;
            float env = smoothstep(1.0, 0.18, length(c * vec2(1.05, 0.92)));
            // shadow of the mullion and sash bar
            float mullionX = smoothstep(0.025, 0.065, abs(vUv.x - 0.5));
            float mullionY = smoothstep(0.022, 0.060, abs(vUv.y - 0.52));
            vec4 nA = texture2D(uNoiseTex, vec2(vUv.y * 3.4, vUv.x * 1.6 - uTime * 0.085));
            vec4 nB = texture2D(uNoiseTex, vec2(vUv.y * 6.2 + 0.31, vUv.x * 2.4 - uTime * 0.085 * 1.45));
            float caustic = pow(clamp(1.0 - abs(nA.b - nB.g) * 2.4, 0.0, 1.0), 3.0);
            float flashWave = pow(max(0.0, sin(uTime * 0.33) * sin(uTime * 1.91)), 18.0);
            vec3 baseMoon = mix(vec3(0.32, 0.48, 0.86), vec3(0.06, 0.44, 0.96), max(uInfect, uAfter));
            vec3 col = baseMoon * (0.52 + caustic * 0.95 + flashWave * 1.35);
            float alpha = env * mullionX * mullionY * (0.14 + caustic * 0.16 + flashWave * 0.14);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      })
    );
    pool.rotation.x = -Math.PI * 0.5;
    pool.rotation.z = 0.2;
    pool.position.set(1.52, 0.024, -0.55);
    this.inner.add(pool);
    const shaft = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 2.3),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: amb.uTime, uInfect: amb.uInfect },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform float uTime;
          uniform float uInfect;
          void main() {
            float across = smoothstep(0.0, 0.55, vUv.x) * smoothstep(1.0, 0.55, vUv.x);
            float along = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
            float shimmer = 0.84 + 0.16 * sin(uTime * 0.6 + vUv.y * 2.0);
            vec3 col = mix(vec3(0.24, 0.42, 0.85), vec3(0.10, 0.28, 0.75), uInfect);
            gl_FragColor = vec4(col, across * along * shimmer * 0.068);
          }
        `,
      })
    );
    shaft.position.set(2.22, 1.35, -0.55);
    shaft.rotation.set(0, -Math.PI * 0.5, -0.34);
    this.inner.add(shaft);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(2.35, 1.92), this.rainGlass(2.35, 1.92, false));
    pane.rotation.y = -Math.PI * 0.5;
    pane.position.set(2.685, 1.66, -0.55);
    pane.renderOrder = 3;
    this.inner.add(pane);
    const skylight = new THREE.Mesh(new THREE.PlaneGeometry(4.32, 2.02), this.rainGlass(4.32, 2.02, true));
    skylight.rotation.x = 0.742;
    skylight.position.set(0.34, 2.33, -2.16);
    skylight.renderOrder = 3;
    this.inner.add(skylight);
    this.ceilingParts.push(skylight);
    // dead pendant under the ceiling rose
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.42, 6), P(new THREE.MeshLambertMaterial({ color: 0x15181f })));
    cord.position.set(0.34, 2.935, 0.1);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.14, 12, 1, true),
      P(new THREE.MeshLambertMaterial({ color: 0x2a2f3c, side: THREE.DoubleSide }), { craft: true })
    );
    shade.position.set(0.34, 2.66, 0.1);
    shade.rotation.x = Math.PI;
    this.inner.add(cord, shade);
    this.ceilingParts.push(cord, shade);
    this.buildPainting();
    this.buildMirror();
  }
  /**
   * The framed print above the bed: Fuseli's "The Nightmare", badly framed behind ribbed glass.
   * From the pillow it is only a dark old painting; from the desk the varnish catches the monitor
   * and the picture inside is not quite the same one.
   */
  private buildPainting() {
    const amb = this.ctx.amb;
    const P = <T extends THREE.Material>(m: T) => this.ctx.patch(m);
    const frame = new THREE.Group();
    frame.position.set(-2.044, 1.66, -0.98);
    frame.rotation.y = Math.PI * 0.5;
    const gold = P(new THREE.MeshStandardMaterial({ color: 0x6a5632, roughness: 0.42, metalness: 0.72 }));
    const W = 0.6;
    const H = 0.5;
    const bar = 0.035;
    const depth = 0.045;
    const bars: [number, number, number, number][] = [
      [W + bar * 2, bar, 0, H * 0.5 + bar * 0.5],
      [W + bar * 2, bar, 0, -H * 0.5 - bar * 0.5],
      [bar, H, -W * 0.5 - bar * 0.5, 0],
      [bar, H, W * 0.5 + bar * 0.5, 0],
    ];
    for (const [w, h, x, y] of bars) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), gold);
      b.position.set(x, y, 0.004);
      frame.add(b);
    }
    const liner = new THREE.Mesh(new THREE.BoxGeometry(W + 0.012, H + 0.012, 0.012), P(new THREE.MeshLambertMaterial({ color: 0xcfc6b2 })));
    liner.position.z = -0.004;
    const backing = new THREE.Mesh(new THREE.BoxGeometry(W + bar * 2, H + bar * 2, 0.02), P(new THREE.MeshLambertMaterial({ color: 0x0d1017 })));
    backing.position.z = -0.016;
    frame.add(liner, backing);
    const print = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H, 6, 5),
      this.ctx.fxShader({
        uniforms: { uTime: amb.uTime, uSpread: amb.uInfect, uAfter: amb.uAfter, uCamForward: amb.uCamForward, uArt: { value: this.a.artTex } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vTangentW;
          varying vec3 vNormalW;
          void main() {
            vUv = uv;
            mat3 nMat = mat3(modelMatrix);
            vNormalW = normalize(nMat * normal);
            vTangentW = normalize(nMat * vec3(1.0, 0.0, 0.0));
            vec3 transformed = position;
            /*RFX_PROJECT*/
            vWorldPos = vRfxW;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vTangentW;
          varying vec3 vNormalW;
          uniform float uTime;
          uniform float uSpread;
          uniform float uAfter;
          uniform vec3 uCamForward;
          uniform sampler2D uArt;
          float hash21(vec2 p) {
            p = fract(p * vec2(234.34, 435.345));
            p += dot(p, p + 34.23);
            return fract(p.x * p.y);
          }
          void main() {
            vec3 V = normalize(cameraPosition - vWorldPos);
            float inf = max(uSpread, uAfter * 0.55);
            // which of the two interleaved images the ribs show depends on where you stand and look
            float lateralAngle = dot(V, vTangentW) + dot(uCamForward, vTangentW) * 0.55;
            float flipFactor = clamp(smoothstep(-0.16, 0.26, lateralAngle) + inf * 0.9 + uAfter, 0.0, 1.0);
            // image B: the same painting after something inside it noticed you
            float luma = dot(texture2D(uArt, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
            float slab = floor(vUv.y * 18.0);
            float tearGate = step(0.55 - inf * 0.30, hash21(vec2(slab, 2.3)));
            float tearShift = (hash21(vec2(slab * 1.7, 9.1)) - 0.5) * (0.04 + inf * 0.09);
            vec2 bUv = vUv + vec2(tearShift * tearGate, 0.0);
            vec3 raw = texture2D(uArt, bUv).rgb;
            vec3 imgB = mix(raw, vec3(1.0) - raw, 0.35 + inf * 0.4);
            imgB = mix(imgB, vec3(0.02, 0.10, 0.26) + luma * vec3(0.30, 0.72, 1.0), 0.55);
            vec2 eyeC = vec2(0.545, 0.712);
            float eyeA = exp(-length((bUv - (eyeC + vec2(-0.026, 0.0))) * vec2(1.0, 1.2)) * 120.0);
            float eyeB = exp(-length((bUv - (eyeC + vec2(0.026, 0.0))) * vec2(1.0, 1.2)) * 120.0);
            imgB += vec3(0.86, 0.97, 1.0) * (eyeA + eyeB) * (0.9 + 0.35 * sin(uTime * 2.2));
            float slit = smoothstep(0.09, 0.0, abs(fract(vUv.y - uTime * 0.21) - 0.5) - 0.46) * inf;
            imgB += vec3(0.42, 0.92, 1.0) * slit * (0.06 + inf * 0.22);
            // lenticular ribs (catch the monitor glow, not the picture itself, until it wakes)
            float ridge = sin(vUv.x * 340.0 + lateralAngle * 22.0);
            float ridgeBlend = clamp(flipFactor + ridge * 0.055 * sin(flipFactor * 3.14159), 0.0, 1.0);
            float colShift = ridge * 0.0010 * flipFactor;
            // image A: the real painting under old amber varnish
            vec3 col = mix(texture2D(uArt, vUv + vec2(colShift, 0.0)).rgb * vec3(1.04, 0.94, 0.78), imgB, ridgeBlend);
            // glass: fresnel sheen and the monitor's smear raking across it
            float fres = pow(1.0 - clamp(dot(V, normalize(vNormalW)), 0.0, 1.0), 3.2);
            col += vec3(0.30, 0.52, 0.86) * fres * (0.18 + 0.30 * ridgeBlend);
            float rake = pow(max(0.0, 1.0 - abs(vUv.x - 0.18 - sin(uTime * 0.4) * 0.05) * 2.4), 6.0);
            col += vec3(0.16, 0.40, 0.85) * rake * (0.05 + inf * 0.16) * (1.0 - vUv.y * 0.4);
            float matBorder = step(0.018, vUv.x) * step(vUv.x, 0.982) * step(0.018, vUv.y) * step(vUv.y, 0.982);
            col = mix(vec3(0.66, 0.63, 0.55) * (0.5 + 0.25 * vUv.y), col, matBorder);
            // it hangs in a dark room: only what the room lends it
            gl_FragColor = vec4(col * 0.42, 1.0);
            /*RFX_TAIL*/
          }
        `,
      })
    );
    print.position.z = 0.006;
    frame.add(print);
    this.inner.add(frame);
  }
  /** in the vanity mirror, only at the edge of your vision: someone standing behind you */
  private buildMirror() {
    const amb = this.ctx.amb;
    const overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.54),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: amb.uTime, uInfect: amb.uInfect, uCamForward: amb.uCamForward },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormalW;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormalW;
          uniform float uTime;
          uniform float uInfect;
          uniform vec3 uCamForward;
          void main() {
            vec3 toFrag = normalize(vWorldPos - cameraPosition);
            vec3 V = -toFrag;
            float gazeAlign = dot(normalize(uCamForward), toFrag);
            float peripheral = smoothstep(0.965, 0.80, gazeAlign) * smoothstep(0.35, 0.68, gazeAlign);
            float grazing = smoothstep(0.88, 0.35, abs(dot(vNormalW, V)));
            float reveal = clamp(max(peripheral, grazing * 0.75) + uInfect * 0.65, 0.0, 1.0);
            vec2 p = vUv - vec2(0.5 - V.x * 0.14, 0.44 + V.y * 0.08);
            float head = smoothstep(0.14, 0.07, length((p - vec2(0.0, 0.16)) * vec2(1.2, 1.0)));
            float torso = smoothstep(0.24, 0.11, abs(p.x)) * smoothstep(0.12, -0.35, p.y);
            float eyeL = smoothstep(0.022, 0.007, length(p - vec2(-0.042, 0.17)));
            float eyeR = smoothstep(0.022, 0.007, length(p - vec2(0.042, 0.17)));
            float border = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x)
                         * smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
            vec3 col = vec3(0.12, 0.36, 0.72) * (head + torso * 0.65) * 0.32;
            col += vec3(0.75, 0.94, 1.0) * (eyeL + eyeR) * (0.85 + 0.15 * sin(uTime * 11.0));
            float alpha = clamp((head * 0.35 + torso * 0.22 + (eyeL + eyeR) * 0.95) * reveal * border, 0.0, 0.85);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      })
    );
    overlay.rotation.y = -Math.PI * 0.5 - 0.18;
    overlay.position.set(2.5, 0.985, -1.215);
    overlay.renderOrder = 3;
    this.inner.add(overlay);
  }
  /** wainscot, rails, cornice, the door and the soft shadows furniture leaves on the floor */
  private buildTrim() {
    const P = <T extends THREE.Material>(m: T, o?: PatchOpts) => this.ctx.patch(m, o);
    const trimMat = P(new THREE.MeshLambertMaterial({ color: 0x2b3140 }), { craft: true });
    const panelMat = P(new THREE.MeshLambertMaterial({ color: 0x232936 }), { craft: true });
    const trim: THREE.BufferGeometry[] = [];
    const panels: THREE.BufferGeometry[] = [];
    const top: THREE.BufferGeometry[] = [];
    const WEST_X = -2.055;
    const SOUTH_Z = 1.638;
    const CEIL_Y = 3.145;
    const RAIL_Y = 0.94;
    for (let i = 0; i < 7; i++) {
      const pz = -2.72 + i * 0.62 + 0.31;
      const ph = 0.62;
      const pw = 0.5;
      pushBox(panels, 0.018, ph, 0.045, WEST_X + 0.012, 0.52, pz - pw * 0.5);
      pushBox(panels, 0.018, ph, 0.045, WEST_X + 0.012, 0.52, pz + pw * 0.5);
      pushBox(panels, 0.018, 0.045, pw, WEST_X + 0.012, 0.52 + ph * 0.5, pz);
      pushBox(panels, 0.018, 0.045, pw, WEST_X + 0.012, 0.52 - ph * 0.5, pz);
      pushBox(panels, 0.01, ph - 0.09, pw - 0.09, WEST_X + 0.005, 0.52, pz);
    }
    pushBox(trim, 0.05, 0.055, 4.6, WEST_X + 0.028, RAIL_Y, -0.6);
    pushBox(trim, 0.07, 0.022, 4.6, WEST_X + 0.036, RAIL_Y - 0.036, -0.6);
    pushBox(trim, 0.026, 0.115, 4.6, WEST_X + 0.015, 0.058, -0.6);
    pushBox(trim, 0.045, 0.018, 4.6, WEST_X + 0.023, 0.118, -0.6);
    pushBox(top, 0.055, 0.05, 4.6, WEST_X + 0.028, CEIL_Y - 0.035, -0.6);
    pushBox(top, 0.085, 0.03, 4.6, WEST_X + 0.042, CEIL_Y - 0.082, -0.6);
    for (let i = 0; i < 7; i++) {
      const px = -2.0 + i * 0.62 + 0.31;
      const ph = 0.62;
      const pw = 0.5;
      if (px > 0.62 && px < 1.76) continue;
      pushBox(panels, 0.045, ph, 0.018, px - pw * 0.5, 0.52, SOUTH_Z - 0.012);
      pushBox(panels, 0.045, ph, 0.018, px + pw * 0.5, 0.52, SOUTH_Z - 0.012);
      pushBox(panels, pw, 0.045, 0.018, px, 0.52 + ph * 0.5, SOUTH_Z - 0.012);
      pushBox(panels, pw, 0.045, 0.018, px, 0.52 - ph * 0.5, SOUTH_Z - 0.012);
      pushBox(panels, pw - 0.09, ph - 0.09, 0.01, px, 0.52, SOUTH_Z - 0.005);
    }
    pushBox(trim, 4.9, 0.055, 0.05, 0.34, RAIL_Y, SOUTH_Z - 0.028);
    pushBox(trim, 4.9, 0.022, 0.07, 0.34, RAIL_Y - 0.036, SOUTH_Z - 0.036);
    pushBox(trim, 4.9, 0.115, 0.026, 0.34, 0.058, SOUTH_Z - 0.015);
    pushBox(trim, 4.9, 0.018, 0.045, 0.34, 0.118, SOUTH_Z - 0.023);
    pushBox(top, 4.9, 0.05, 0.055, 0.34, CEIL_Y - 0.035, SOUTH_Z - 0.028);
    pushBox(top, 4.9, 0.03, 0.085, 0.34, CEIL_Y - 0.082, SOUTH_Z - 0.042);
    pushBox(top, 4.9, 0.055, 0.05, 0.34, CEIL_Y - 0.035, -1.52);
    pushBox(top, 0.05, 0.055, 2.4, 2.66, CEIL_Y - 0.035, 0.06);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pushBox(top, 0.085, 0.014, 0.26, 0.34 + Math.cos(a) * 0.42, CEIL_Y - 0.012, 0.1 + Math.sin(a) * 0.42, 0, -a, 0);
    }
    // door leaf and casing
    const DOOR_X = 1.18;
    pushBox(trim, 0.075, 2.16, 0.055, DOOR_X - 0.49, 1.08, SOUTH_Z - 0.03);
    pushBox(trim, 0.075, 2.16, 0.055, DOOR_X + 0.49, 1.08, SOUTH_Z - 0.03);
    pushBox(trim, 1.05, 0.075, 0.055, DOOR_X, 2.19, SOUTH_Z - 0.03);
    pushBox(trim, 1.14, 0.035, 0.075, DOOR_X, 2.245, SOUTH_Z - 0.04);
    pushBox(panels, 0.9, 2.1, 0.05, DOOR_X, 1.06, SOUTH_Z - 0.012);
    pushBox(trim, 0.62, 0.9, 0.014, DOOR_X, 1.62, SOUTH_Z - 0.042);
    pushBox(trim, 0.62, 0.72, 0.014, DOOR_X, 0.55, SOUTH_Z - 0.042);
    pushBox(trim, 0.98, 0.022, 0.09, DOOR_X, 0.012, SOUTH_Z - 0.02);
    const trimMesh = merged(trim, trimMat);
    const panelMesh = merged(panels, panelMat);
    const topMesh = merged(top, trimMat);
    for (const m of [trimMesh, panelMesh, topMesh]) {
      if (!m) continue;
      m.userData.noCast = true;
      this.inner.add(m);
    }
    if (topMesh) this.ceilingParts.push(topMesh);
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.022, 0.028), P(new THREE.MeshLambertMaterial({ color: 0x8d9aae })));
    lever.position.set(DOOR_X - 0.33, 1.02, SOUTH_Z - 0.055);
    this.inner.add(lever);
    // contact shadows
    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    const g = sc.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.85)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.38)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const shadowMat = P(
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(sc),
        transparent: true,
        depthWrite: false,
        opacity: 0.72,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      { noInfect: true }
    );
    const spots: [number, number, number, number][] = [
      [0.34, -1.5, 3.4, 2.9],
      [-1.62, 0.6, 1.2, 2.2],
      [1.42, -2.2, 0.9, 1.2],
    ];
    const sg = spots.map(([x, z, w, d]) => {
      const p = new THREE.PlaneGeometry(w, d);
      p.rotateX(-Math.PI * 0.5);
      p.translate(x, 0.022, z);
      return p;
    });
    const shadows = merged(sg, shadowMat);
    if (shadows) {
      shadows.renderOrder = 1;
      this.inner.add(shadows);
    }
  }
}
