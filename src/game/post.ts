import * as THREE from 'three';
const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
const BRIGHT = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(tMap, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(tMap, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(tMap, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(clamp(c * k, 0.0, 8.0), 1.0);
}`;
const BLUR = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb * 0.227027;
  c += (texture2D(tMap, vUv + uDir * 1.3846).rgb + texture2D(tMap, vUv - uDir * 1.3846).rgb) * 0.316216;
  c += (texture2D(tMap, vUv + uDir * 3.2308).rgb + texture2D(tMap, vUv - uDir * 3.2308).rgb) * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}`;
const FINAL = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uGlitch, uAberr, uVignette, uGrain, uFade, uFlash, uWarp, uBloom;
uniform float uExposure, uScan, uBlur, uSat, uLid;
uniform vec2 uCenter;
uniform vec3 uTint;
uniform vec3 uFlashColor;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 tonemap(vec3 c) {
  float l = max(c.r, max(c.g, c.b));
  float nl = l / (1.0 + l);
  return c * (nl / max(l, 1e-4));
}
void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  // suction: the image is pinched toward uCenter
  vec2 d = uv - uCenter;
  vec2 da = d * vec2(asp, 1.0);
  uv = uCenter + d * (1.0 + uWarp * (dot(da, da) - 0.12));
  float gt = floor(uTime * 20.0);
  if (uGlitch > 0.002) {
    float rows = mix(6.0, 46.0, hash(vec2(gt, 3.7)));
    float by = floor(uv.y * rows);
    float n = hash(vec2(by, gt));
    uv.x += step(1.0 - uGlitch * 0.55, n) * (hash(vec2(by, gt + 3.0)) - 0.5) * 0.22 * uGlitch;
    vec2 bl = floor(uv * vec2(10.0, 7.0));
    float bn = hash(bl + gt);
    uv += step(1.0 - uGlitch * 0.2, bn) * (vec2(hash(bl + gt + 7.0), hash(bl + gt + 11.0)) - 0.5) * 0.12 * uGlitch;
  }
  vec2 dir = uv - 0.5;
  float ab = uAberr * (0.35 + dot(dir, dir) * 2.4) + uGlitch * 0.008 * hash(vec2(gt, 9.0));
  vec3 col;
  col.r = texture2D(tScene, uv + dir * ab).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - dir * ab).b;
  if (uBlur > 0.002) {
    vec3 acc = col;
    for (int i = 1; i < 7; i++) {
      float s = 1.0 - uBlur * 0.035 * float(i);
      acc += texture2D(tScene, uCenter + (uv - uCenter) * s).rgb;
    }
    col = acc / 7.0;
  }
  col += texture2D(tBloom, uv).rgb * uBloom;
  col = max(col, 0.0) * uExposure;
  col = tonemap(col);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSat) * uTint;
  col = pow(col, vec3(1.0 / 2.2));
  col *= 1.0 - uScan * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.6));
  vec2 vd = vUv - 0.5;
  col *= 1.0 - uVignette * smoothstep(0.25, 0.95, length(vd) * 1.35);
  col += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
  // eyelids (waking up)
  if (uLid > 0.001) {
    float open = 1.0 - uLid;
    float y = abs(vUv.y - 0.5) * 2.0 + 0.14 * (1.0 - cos(vd.x * 3.1416));
    col *= 1.0 - smoothstep(open * 1.2 - 0.28, open * 1.2, y);
  }
  col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
  col *= 1.0 - clamp(uFade, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}`;
export class Post {
  params = {
    glitch: 0,
    aberr: 0.0015,
    vignette: 0.85,
    grain: 0.045,
    fade: 1,
    flash: 0,
    warp: 0,
    bloom: 0.9,
    exposure: 1.5,
    scan: 0,
    blur: 0,
    sat: 1,
    lid: 0,
    cx: 0.5,
    cy: 0.5,
  };
  tint = new THREE.Color(1, 1, 1);
  flashColor = new THREE.Color(0.75, 0.88, 1);
  /** multiplier for flashes / glitches (photosensitivity option) */
  reduce = 1;
  samples = 4;
  private renderer: THREE.WebGLRenderer;
  private rtMain: THREE.WebGLRenderTarget | null = null;
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private mBright: THREE.ShaderMaterial;
  private mBlur: THREE.ShaderMaterial;
  private mFinal: THREE.ShaderMaterial;
  private type: THREE.TextureDataType;
  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const hdr =
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float');
    this.type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms,
        depthTest: false,
        depthWrite: false,
      });
    this.mBright = mk(BRIGHT, {
      tMap: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0.85 },
    });
    this.mBlur = mk(BLUR, { tMap: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.mFinal = mk(FINAL, {
      tScene: { value: null },
      tBloom: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uGlitch: { value: 0 },
      uAberr: { value: 0 },
      uVignette: { value: 0 },
      uGrain: { value: 0 },
      uFade: { value: 0 },
      uFlash: { value: 0 },
      uWarp: { value: 0 },
      uBloom: { value: 0 },
      uExposure: { value: 1 },
      uScan: { value: 0 },
      uBlur: { value: 0 },
      uSat: { value: 1 },
      uLid: { value: 0 },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uTint: { value: this.tint },
      uFlashColor: { value: this.flashColor },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mFinal);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }
  setSize(w: number, h: number) {
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    this.rtMain?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtMain = new THREE.WebGLRenderTarget(w, h, {
      type: this.type,
      samples: this.samples,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const bw = Math.max(2, Math.floor(w / 4));
    const bh = Math.max(2, Math.floor(h / 4));
    const opts = {
      type: this.type,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    };
    this.rtA = new THREE.WebGLRenderTarget(bw, bh, opts);
    this.rtB = new THREE.WebGLRenderTarget(bw, bh, opts);
    (this.mFinal.uniforms.uRes.value as THREE.Vector2).set(w, h);
    (this.mBright.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
  }
  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }
  render(scene: THREE.Scene, camera: THREE.Camera, time: number) {
    if (!this.rtMain || !this.rtA || !this.rtB) return;
    const r = this.renderer;
    r.setRenderTarget(this.rtMain);
    r.render(scene, camera);
    this.mBright.uniforms.tMap.value = this.rtMain.texture;
    this.pass(this.mBright, this.rtA);
    const dir = this.mBlur.uniforms.uDir.value as THREE.Vector2;
    const tx = 1 / this.rtA.width;
    const ty = 1 / this.rtA.height;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : 2.4;
      this.mBlur.uniforms.tMap.value = this.rtA.texture;
      dir.set(tx * s, 0);
      this.pass(this.mBlur, this.rtB);
      this.mBlur.uniforms.tMap.value = this.rtB.texture;
      dir.set(0, ty * s);
      this.pass(this.mBlur, this.rtA);
    }
    const u = this.mFinal.uniforms;
    const p = this.params;
    u.tScene.value = this.rtMain.texture;
    u.tBloom.value = this.rtA.texture;
    u.uTime.value = time;
    u.uGlitch.value = p.glitch * this.reduce;
    u.uAberr.value = p.aberr;
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uFade.value = p.fade;
    u.uFlash.value = p.flash * this.reduce;
    u.uWarp.value = p.warp;
    u.uBloom.value = p.bloom;
    u.uExposure.value = p.exposure;
    u.uScan.value = p.scan;
    u.uBlur.value = p.blur;
    u.uSat.value = p.sat;
    u.uLid.value = p.lid;
    (u.uCenter.value as THREE.Vector2).set(p.cx, p.cy);
    this.pass(this.mFinal, null);
  }
  dispose() {
    this.rtMain?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.mBright.dispose();
    this.mBlur.dispose();
    this.mFinal.dispose();
    this.quad.geometry.dispose();
  }
}