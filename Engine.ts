import * as THREE from 'three';
import { AudioEngine } from './audio';
import { BsodScreen } from './bsodScreen';
import { Collapse } from './collapse';
import { Devour } from './devour';
import { Post } from './post';
import { Room } from './room';
import { WORLD, World, groundHeight } from './world';
import { TAU, clamp, damp, easeInOut, fnoise, lerp, lerpAngle, lookAngles, smooth, wrapAngle } from './utils';
export type Phase = 'title' | 'room' | 'monitor' | 'devour' | 'world' | 'collapse' | 'after';
export interface UIState {
  phase: Phase;
  ready: boolean;
  prompt: string;
  hint: string;
  subtitle: string;
  consoleOpen: boolean;
  consoleLines: string[];
  consoleInput: string;
  consoleBusy: boolean;
  paused: boolean;
  cinematic: boolean;
  crosshair: boolean;
  fallback: boolean;
  muted: boolean;
}
const SENS = 0.0022;
const CLICKS = 16;
const BLACK = new THREE.Color('#000000');
const EYE = 1.62;
const UNKNOWN = [
  "'%' は内部コマンドまたは外部コマンドとして認識されていません。あなたも。",
  "コマンド '%' は存在しません。存在しないものが、また一つ増えました。",
  "エラー 0x0000:( ―― '%' を理解できません。理解されたいですか？",
  "'%' …… その言葉は、ここではもう意味を失っています。",
  "'%' を実行しました。何も起きませんでした。何も、起きていません。",
];
export class Engine {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  post: Post;
  audio = new AudioEngine();
  bsod = new BsodScreen();
  room: Room;
  world: World;
  devour: Devour;
  collapse: Collapse;
  player = { pos: new THREE.Vector3(), yaw: 0.22, pitch: -0.04, vel: new THREE.Vector3() };
  camRoll = 0;
  fov = 72;
  phase: Phase = 'title';
  loop = 0;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private onUI: (s: UIState) => void;
  private ui: UIState;
  private keys = new Set<string>();
  private locked = false;
  private everLocked = false;
  private fallback = false;
  private dragging = false;
  private lockReqAt = -1;
  private mdx = 0;
  private mdy = 0;
  private mouseNdc = new THREE.Vector2();
  private ray = new THREE.Raycaster();
  private time = 0;
  private last = 0;
  private raf = 0;
  private trauma = 0;
  private stepPhase = 0;
  private canInteract = false;
  private prevPhase: Phase = 'room';
  private mon = {
    t: 0,
    from: new THREE.Vector3(),
    fromYaw: 0,
    fromPitch: 0,
    crashAt: 1.9,
    freezeAt: -1,
    leaving: false,
    k: 0,
    idle: 0,
    hinted: false,
  };
  private clicks = 0;
  private corruptionTarget = 0;
  private consoleOpen = false;
  private consoleInput = '';
  private consoleLines: string[] = [];
  private subtitleText = '';
  private subtitleT = 0;
  private hintT = 0;
  private restartT = 0;
  private revealGlow = 0;
  private edgeWarn = 0;
  private quality = 1;
  private slowT = 0;
  private frameAvg = 1 / 60;
  private tmp = new THREE.Vector3();
  private disposed = false;
  constructor(container: HTMLElement, onUI: (s: UIState) => void) {
    this.container = container;
    this.onUI = onUI;
    this.ui = {
      phase: 'title',
      ready: true,
      prompt: '',
      hint: '',
      subtitle: '',
      consoleOpen: false,
      consoleLines: [],
      consoleInput: '',
      consoleBusy: false,
      paused: false,
      cinematic: false,
      crosshair: false,
      fallback: false,
      muted: false,
    };
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      depth: false,
      stencil: false,
    });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.toneMapping = THREE.NoToneMapping;
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';
    container.appendChild(this.canvas);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.04, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.fog = new THREE.Fog(0x000000, 30, 120);
    this.scene.background = new THREE.Color(0x000000);
    this.post = new Post(renderer);
    this.room = new Room(this.bsod.texture);
    this.scene.add(this.room.group);
    this.world = new World();
    this.scene.add(this.world.group);
    this.devour = new Devour(this);
    this.scene.add(this.devour.group);
    this.collapse = new Collapse(this);
    this.world.onAnomaly = (s) => {
      if (this.phase === 'world') this.audio.anomaly(s);
    };
    this.world.onReveal = () => {
      // reaching the tower: everything goes very quiet, and very clear
      this.audio.reveal();
      this.revealGlow = 1;
      this.world.anomaly = 0;
    };
    this.player.pos.set(this.room.startPos.x, 0, this.room.startPos.z);
    this.camera.position.copy(this.room.startPos);
    this.resize();
    // warm-up: compile every shader once so no hitch happens mid-experience
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.post.render(this.scene, this.camera, 0);
    hidden.forEach((o) => (o.visible = false));
    this.showWorld(false);
    this.showRoom(true);
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContext);
    if (typeof location !== 'undefined' && location.search.includes('debug')) {
      (window as unknown as { __engine: Engine }).__engine = this;
    }
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.audio.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
  // ------------------------------------------------------------------ public API (UI)
  start() {
    if (this.phase !== 'title') return;
    this.audio.init();
    this.audio.setRoom(1, 1.5);
    this.requestLock();
    this.phase = 'room';
    this.hintT = 0;
    this.say('午前 2:47。レポートは、まだ終わらない。', 4.5);
  }
  resume() {
    this.audio.init();
    this.requestLock();
  }
  setReduceFlash(on: boolean) {
    this.post.reduce = on ? 0.3 : 1;
  }
  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
  }
  // ------------------------------------------------------------------ helpers used by cinematics
  setEnv(color: THREE.Color, near: number, far: number) {
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(color);
    fog.near = near;
    fog.far = far;
    (this.scene.background as THREE.Color).copy(color);
  }
  showRoom(v: boolean) {
    this.room.group.visible = v;
    if (v) this.renderer.shadowMap.needsUpdate = true;
  }
  showWorld(v: boolean) {
    this.world.group.visible = v;
  }
  addTrauma(x: number) {
    this.trauma = Math.min(1, this.trauma + x);
  }
  say(text: string, dur = 3.5) {
    this.subtitleText = text;
    this.subtitleT = dur;
  }
  /** the room as it will be found after the fall (called mid-fall, while still far above it) */
  prepareReturnRoom() {
    this.loop++;
    this.bsod.reset();
    this.bsod.loop = this.loop;
    this.bsod.showCursor = false;
    this.bsod.setMode('after');
    this.resetRoomFx();
    this.room.setAftermath(true);
    this.room.setCeiling(false);
    this.devour.reset();
    this.clicks = 0;
    this.corruptionTarget = 0;
    this.audio.resetWhine();
    this.showRoom(true);
  }
  finishReturnRoom() {
    this.room.setCeiling(true);
    this.camera.near = 0.04;
    this.camera.far = 400;
    this.camera.updateProjectionMatrix();
    this.setEnv(BLACK, 30, 120);
    this.renderer.shadowMap.needsUpdate = true;
  }
  private resetRoomFx() {
    const fx = this.room.fx;
    fx.uSuck.value = 0;
    fx.uInfect.value = 0;
    fx.uTear.value = 0;
    fx.uMawR.value = 0;
    this.room.lampOn = 1;
    this.room.hemi.intensity = 0.55;
    this.room.setScreenLight('#9db8ff', 1);
  }
  // ------------------------------------------------------------------ input
  private requestLock() {
    if (this.fallback) return;
    this.lockReqAt = this.time;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => this.onLockError());
    } catch {
      this.onLockError();
    }
  }
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (this.locked) {
      this.everLocked = true;
      this.lockReqAt = -1;
    } else {
      this.keys.clear();
      if (this.consoleOpen && !this.collapse.active) this.closeConsole(true);
    }
  };
  private onLockError = () => {
    // pointer lock unavailable (e.g. sandboxed iframe): fall back to drag-to-look
    if (!this.everLocked) this.fallback = true;
  };
  private onBlur = () => {
    this.keys.clear();
    this.dragging = false;
  };
  private onContext = (e: Event) => e.preventDefault();
  private onMouseMove = (e: MouseEvent) => {
    if (this.locked) {
      this.mdx += e.movementX;
      this.mdy += e.movementY;
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    this.mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (this.fallback && this.dragging) {
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    }
  };
  private onMouseUp = () => {
    this.dragging = false;
  };
  private onMouseDown = (e: MouseEvent) => {
    if (this.phase === 'title') return;
    this.canvas.focus();
    if (!this.locked && !this.fallback) {
      this.requestLock();
      return;
    }
    if (this.fallback) this.dragging = true;
    if (e.button === 0) this.primaryAction();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private onKeyDown = (e: KeyboardEvent) => {
    if (this.phase === 'title') return;
    if (this.consoleOpen) {
      if (!(e.ctrlKey || e.metaKey)) e.preventDefault();
      if (!this.collapse.active) this.consoleKey(e);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyE':
      case 'Enter':
        this.primaryAction();
        break;
      case 'KeyQ':
      case 'Escape':
        this.leaveMonitor();
        break;
      case 'KeyC':
        if (this.phase === 'world') {
          e.preventDefault();
          this.openConsole();
        }
        break;
      case 'KeyR':
        if (this.phase === 'after' && this.restartT === 0) this.restartT = 0.0001;
        break;
      case 'KeyM':
        this.toggleMute();
        break;
    }
  };
  private get paused() {
    const play = this.phase === 'room' || this.phase === 'monitor' || this.phase === 'world' || this.phase === 'after';
    return play && !this.locked && !this.fallback;
  }
  private primaryAction() {
    if (this.paused) return;
    if ((this.phase === 'room' || this.phase === 'after') && this.canInteract) this.enterMonitor();
    else if (this.phase === 'monitor') this.clickScreen();
  }
  // ------------------------------------------------------------------ console
  private openConsole() {
    if (this.consoleOpen) return;
    this.consoleOpen = true;
    this.consoleInput = '';
    this.keys.clear();
    if (!this.consoleLines.length) {
      this.consoleLines = ['KERNEL DEBUG CONSOLE  v0.0.0 :(', 'HELP と入力すると一覧を表示します。'];
    }
    this.audio.consoleOpen(true);
  }
  closeConsole(silent = false) {
    if (!this.consoleOpen) return;
    this.consoleOpen = false;
    this.consoleInput = '';
    this.keys.clear();
    if (!silent) this.audio.consoleOpen(false);
  }
  private print(...lines: string[]) {
    this.consoleLines = [...this.consoleLines, ...lines].slice(-11);
  }
  private keyChar(e: KeyboardEvent): string | null {
    if (e.key.length === 1) return e.key;
    const c = e.code;
    if (c.startsWith('Key')) return c.slice(3);
    if (c.startsWith('Digit')) return c.slice(5);
    if (c === 'Space') return ' ';
    if ((c === 'Minus' || c === 'IntlRo') && e.shiftKey) return '_';
    return null;
  }
  private consoleKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape' || e.code === 'Backquote') {
      this.closeConsole();
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!this.consoleInput.trim()) this.closeConsole();
      else this.runCommand(this.consoleInput);
      this.consoleInput = '';
      return;
    }
    if (e.code === 'Backspace') {
      this.consoleInput = this.consoleInput.slice(0, -1);
      this.audio.key();
      return;
    }
    const ch = this.keyChar(e);
    if (!ch) return;
    const norm = ch.normalize('NFKC').toUpperCase();
    if (!/^[ -~]$/.test(norm) || this.consoleInput.length >= 28) return;
    this.consoleInput += norm;
    this.audio.key();
  }
  private runCommand(raw: string) {
    const cmd = raw.normalize('NFKC').trim().toUpperCase();
    this.print(`> ${cmd}`);
    if (cmd === WORLD.secret) {
      this.print('……認証しました。', '起床シーケンスを開始します。おやすみなさい、世界。');
      this.audio.accept();
      this.startCollapse();
      return;
    }
    const ok = (...lines: string[]) => {
      this.print(...lines);
      this.audio.key();
    };
    switch (cmd) {
      case 'HELP':
      case '?':
        ok(
          '  HELP     この一覧',
          '  LS       周囲を列挙',
          '  WHOAMI   あなたを照会',
          '  STATUS   世界の状態',
          '  EXIT     出口を探す',
          '  ████_██  [破損したエントリ ― 中心で読み取れ]'
        );
        return;
      case 'LS':
      case 'DIR':
        ok('MONOLITH.sys ×84   FRAGMENT.tmp ×∞   DIALOG.err ×110', 'YOU.exe（応答なし）   KERNEL.core  ← 中央');
        return;
      case 'WHOAMI':
        ok('プロセス名: YOU.exe   状態: 応答なし', '親プロセス: 不明   最終入力: 午前 2:47');
        return;
      case 'STATUS':
        ok('0% 完了。', 'ずっと、0% 完了。');
        return;
      case 'EXIT':
      case 'QUIT':
      case 'LOGOUT':
      case 'SHUTDOWN':
      case 'RESTART':
      case 'REBOOT':
        ok('出口はありません。', '起きる以外には。');
        this.world.triggerAnomaly(0.35);
        return;
      case 'SLEEP':
        ok('あなたは、すでに眠っています。');
        return;
      case 'HELLO':
      case 'HI':
      case ':)':
        ok(':(');
        return;
      case ':(':
        ok(':(   :(   :(   :(   :(   :(   :(');
        this.world.triggerAnomaly(0.6);
        return;
      case 'CLS':
      case 'CLEAR':
        this.consoleLines = [];
        return;
      case 'WAKE':
      case 'WAKEUP':
      case 'WAKE UP':
      case 'WAKE-UP':
      case 'WAKE.UP':
        this.print('構文エラー: 区切り文字が違います。', '刻まれた通りに、正確に。');
        this.audio.error();
        this.world.triggerAnomaly(0.4);
        return;
    }
    // unknown input: the world itself flinches
    const msg = UNKNOWN[Math.floor(Math.random() * UNKNOWN.length)].replace('%', cmd);
    this.print(msg);
    this.audio.error();
    this.world.triggerAnomaly(0.45 + Math.random() * 0.3);
    this.addTrauma(0.15);
  }
  // ------------------------------------------------------------------ monitor
  private enterMonitor() {
    this.prevPhase = this.phase;
    this.phase = 'monitor';
    const m = this.mon;
    m.t = 0;
    m.k = 0;
    m.leaving = false;
    m.idle = 0;
    m.hinted = false;
    m.freezeAt = -1;
    m.crashAt = 1.9;
    m.from.copy(this.camera.position);
    m.fromYaw = this.player.yaw;
    m.fromPitch = this.player.pitch;
    this.player.vel.set(0, 0, 0);
    this.bsod.showCursor = true;
    this.bsod.cursorX = 0.66;
    this.bsod.cursorY = 0.7;
    this.audio.chairCreak();
  }
  private leaveMonitor() {
    if (this.phase !== 'monitor' || this.mon.leaving) return;
    if (this.bsod.mode === 'bsod' && this.bsod.corruption > 0.3) {
      this.say('……目が、離せない。', 2.5);
      this.addTrauma(0.3);
      this.audio.glitch(0.3);
      return;
    }
    if (this.bsod.mode === 'freeze') return;
    this.mon.leaving = true;
    this.audio.chairCreak();
  }
  private clickScreen() {
    const b = this.bsod;
    if (this.mon.leaving || this.mon.k < 0.9) return;
    this.audio.mouseClick();
    const hit = b.hit();
    if (hit === 'face') {
      this.clicks++;
      this.corruptionTarget = Math.min(1, this.clicks / CLICKS);
      const c = b.corruption;
      b.rage = 1;
      this.audio.glitch(0.12 + c * 0.85);
      if (this.clicks > 2) b.dropLetters(1 + Math.floor(c * 5));
      if (this.clicks > 4) b.peel(1 + Math.floor(c * 2.6));
      this.addTrauma(0.06 + c * 0.4);
      this.mon.idle = 0;
    } else if (hit === 'again') {
      b.reset();
      b.setMode('freeze');
      this.mon.freezeAt = this.mon.t;
      this.audio.freezeStutter();
      this.clicks = 0;
      this.corruptionTarget = 0;
    }
  }
  private updateMonitor(dt: number) {
    const m = this.mon;
    const b = this.bsod;
    const room = this.room;
    m.t += dt;
    m.k = clamp(m.k + (m.leaving ? -dt / 0.8 : dt / 1.15));
    const k = easeInOut(m.k);
    const c = b.corruption;
    // on-screen cursor
    if (this.locked) {
      b.cursorX = clamp(b.cursorX + this.mdx * 0.0011, 0.01, 0.99);
      b.cursorY = clamp(b.cursorY + this.mdy * 0.0011 * 1.78, 0.01, 0.99);
    } else if (this.fallback) {
      this.ray.setFromCamera(this.mouseNdc, this.camera);
      const o = this.ray.ray.origin;
      const d = this.ray.ray.direction;
      if (d.z < -0.01) {
        const t = (room.screenCenter.z - o.z) / d.z;
        b.cursorX = clamp((o.x + d.x * t - room.screenCenter.x) / room.screenW + 0.5, 0.01, 0.99);
        b.cursorY = clamp(0.5 - (o.y + d.y * t - room.screenCenter.y) / room.screenH, 0.01, 0.99);
      }
    }
    if (b.mode === 'bsod' && c > 0.55) {
      // the pointer starts sliding toward the mouth on its own
      const g = (c - 0.55) * 0.9 * dt;
      b.cursorX = lerp(b.cursorX, b.faceX / 1024, g);
      b.cursorY = lerp(b.cursorY, b.faceY / 576, g);
    }
    const hit = b.hit();
    b.hover = hit === 'face';
    // desktop -> freeze -> blue
    if (b.mode === 'desktop' && m.t > m.crashAt && !m.leaving) {
      b.setMode('freeze');
      m.freezeAt = m.t;
      this.audio.freezeStutter();
    }
    if (b.mode === 'freeze' && m.t > m.freezeAt + 0.8) {
      b.setMode('bsod');
      this.audio.bsodCrash();
      room.setScreenLight('#2f7dff', 1.25);
      this.addTrauma(0.12);
      this.say(this.loop > 0 ? '……また、これだ。' : '……は？　嘘だろ。', 3);
      m.idle = 0;
    }
    if (b.mode === 'bsod') {
      let target = this.corruptionTarget;
      if (target > 0.6) target = Math.min(1, target + 0.0); // (kept explicit: no auto-advance below the final stage)
      b.corruption = damp(c, target, 4.5, dt);
      if (Math.abs(b.corruption - target) < 0.002) b.corruption = target;
      b.rage = Math.max(0, b.rage - dt * 2.4);
      room.fx.uInfect.value = c < 0.3 ? 0 : ((c - 0.3) / 0.7) * 1.3;
      room.fx.uSuck.value = Math.max(0, c - 0.5) * 0.25;
      room.screenGain = 1.25 + c * 1.5 + b.rage * (0.4 + c);
      this.audio.setCorruption(c);
      this.trauma = Math.max(this.trauma, b.rage * (0.05 + c * 0.55));
      m.idle += dt;
      if (!m.hinted && this.clicks === 0 && m.idle > 6) {
        m.hinted = true;
        this.say('……この顔文字、こっちを見ている気がする。', 4);
      }
      if (this.clicks > 0 && this.clicks < 4 && m.idle > 7) {
        m.idle = 0;
        this.say('……今、動いた？', 2.5);
      }
    }
    while (b.peelQueue.length) this.devour.spawnFlake(b.peelQueue.shift()!);
    this.devour.updateFlakes(dt, 0);
    // camera: lean in to the screen; the gaze drifts a little with the pointer
    const lean = b.mode === 'bsod' ? c * 0.11 : 0;
    const f = room.focusPos;
    this.camera.position.set(lerp(m.from.x, f.x, k), lerp(m.from.y, f.y, k) - Math.sin(k * Math.PI) * 0.05, lerp(m.from.z, f.z - lean, k));
    const la = lookAngles(f.x, f.y, f.z, room.screenCenter.x, room.screenCenter.y, room.screenCenter.z);
    const yawT = la.yaw - (b.cursorX - 0.5) * 0.1;
    const pitchT = la.pitch - (b.cursorY - 0.5) * 0.06;
    const breathe = Math.sin(this.time * 1.2) * 0.003;
    this.camera.rotation.set(lerp(m.fromPitch, pitchT, k) + breathe, lerpAngle(m.fromYaw, yawT, k), this.camRoll, 'YXZ');
    this.camRoll = damp(this.camRoll, fnoise(this.time * 3, 7) * c * 0.04, 6, dt);
    this.fov = damp(this.fov, lerp(72, 50 - c * 5 + b.rage * 3, k), 10, dt);
    const p = this.post.params;
    p.aberr = damp(p.aberr, 0.0015 + c * 0.006 + b.rage * (0.004 + c * 0.012), 14, dt);
    p.glitch = b.mode === 'freeze' ? 0.25 : b.rage * b.rage * (0.12 + c * 0.9);
    p.vignette = damp(p.vignette, 0.85 + c * 0.3, 6, dt);
    p.warp = damp(p.warp, Math.max(0, c - 0.55) * 0.3 + b.rage * c * 0.12, 8, dt);
    p.cx = 0.5;
    p.cy = 0.5;
    if (m.leaving && m.k <= 0) {
      this.phase = this.prevPhase;
      b.showCursor = false;
      this.hintT = 0;
      return;
    }
    if (b.mode === 'bsod' && this.corruptionTarget >= 1 && b.corruption > 0.965) this.startDevour();
  }
  private startDevour() {
    this.phase = 'devour';
    this.bsod.corruption = 1;
    this.bsod.showCursor = false;
    this.subtitleT = 0;
    this.devour.start_();
  }
  private startCollapse() {
    this.phase = 'collapse';
    this.player.vel.set(0, 0, 0);
    this.subtitleT = 0;
    this.collapse.begin();
  }
  // ------------------------------------------------------------------ free walk
  private updateWalk(dt: number, space: 'room' | 'world') {
    const p = this.player;
    const can = !this.paused && !this.consoleOpen;
    const K = this.keys;
    if (can) {
      p.yaw -= this.mdx * SENS;
      p.pitch -= this.mdy * SENS;
      p.yaw += ((K.has('ArrowLeft') ? 1 : 0) - (K.has('ArrowRight') ? 1 : 0)) * 1.9 * dt;
      p.pitch += ((K.has('ArrowUp') ? 1 : 0) - (K.has('ArrowDown') ? 1 : 0)) * 1.3 * dt;
    }
    p.pitch = clamp(p.pitch, -1.45, 1.45);
    let f = 0;
    let s = 0;
    if (can) {
      f = (K.has('KeyW') ? 1 : 0) - (K.has('KeyS') ? 1 : 0);
      s = (K.has('KeyD') ? 1 : 0) - (K.has('KeyA') ? 1 : 0);
    }
    const run = K.has('ShiftLeft') || K.has('ShiftRight');
    const walk = space === 'room' ? 1.7 : 6.5;
    const speed = space === 'room' ? (run ? 2.7 : walk) : run ? 11.5 : walk;
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    let wx = -sin * f + cos * s;
    let wz = -cos * f - sin * s;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    const accel = space === 'room' ? 11 : 7;
    p.vel.x = damp(p.vel.x, wx * speed, accel, dt);
    p.vel.z = damp(p.vel.z, wz * speed, accel, dt);
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    let eye = EYE;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    if (space === 'room') {
      this.room.collide(p.pos);
      p.pos.y = 0;
    } else {
      const before = Math.hypot(p.pos.x, p.pos.z);
      this.world.collide(p.pos);
      p.pos.y = damp(p.pos.y, groundHeight(p.pos.x, p.pos.z), 16, dt);
      eye = WORLD.eye;
      const o = this.world.group.position;
      ox = o.x;
      oy = o.y;
      oz = o.z;
      // the edge of the map pushes back
      if (before > WORLD.radius - 0.5) {
        this.edgeWarn -= dt;
        if (this.edgeWarn <= 0) {
          this.edgeWarn = 2.5;
          this.world.triggerAnomaly(0.7);
          this.say('ここから先は、まだ読み込まれていない。', 2.5);
        }
      }
    }
    const sp = Math.hypot(p.vel.x, p.vel.z);
    const stride = space === 'room' ? 0.75 : 1.25;
    const prev = Math.floor(this.stepPhase);
    this.stepPhase += (sp * dt) / stride;
    if (Math.floor(this.stepPhase) !== prev && sp > 0.5) this.audio.step(space, clamp(sp / walk, 0.5, 1.3));
    const amp = clamp(sp / walk) * (space === 'room' ? 0.02 : 0.04) * (run ? 1.3 : 1);
    const bobY = -Math.abs(Math.sin(this.stepPhase * Math.PI)) * amp * 1.6 + amp * 0.8;
    const bobX = Math.sin(this.stepPhase * Math.PI) * amp * 0.7;
    const breath = Math.sin(this.time * 1.15) * 0.004;
    this.camera.position.set(p.pos.x + cos * bobX + ox, p.pos.y + eye + bobY + breath + oy, p.pos.z - sin * bobX + oz);
    this.camRoll = damp(this.camRoll, -s * 0.012 + bobX * 0.25, 6, dt);
    this.camera.rotation.set(p.pitch + Math.sin(this.time * 0.9) * 0.002, p.yaw, this.camRoll, 'YXZ');
    this.fov = damp(this.fov, 72 + (run && sp > walk ? 4 : 0), 5, dt);
  }
  private updateRoomPhase(dt: number) {
    this.updateWalk(dt, 'room');
    const p = this.player;
    const sc = this.room.screenCenter;
    const dx = sc.x - p.pos.x;
    const dz = sc.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    const dot = dist > 0.01 ? (-Math.sin(p.yaw) * dx - Math.cos(p.yaw) * dz) / dist : 0;
    this.canInteract = dist < 2.15 && dot > 0.7 && this.restartT === 0;
  }
  private updateWorldPhase(dt: number) {
    this.updateWalk(dt, 'world');
    const u = this.world.u;
    this.setEnv(u.uFogColor.value, u.uFogNear.value, u.uFogFar.value);
  }
  // ------------------------------------------------------------------ restart
  private doReset() {
    this.world.reset();
    this.collapse.reset();
    this.devour.reset();
    this.showWorld(false);
    this.room.setAftermath(false);
    this.room.setCeiling(true);
    this.resetRoomFx();
    this.showRoom(true);
    this.bsod.reset();
    this.bsod.loop = 0;
    this.bsod.showCursor = false;
    this.bsod.setMode('desktop');
    this.loop = 0;
    this.clicks = 0;
    this.corruptionTarget = 0;
    this.consoleLines = [];
    this.closeConsole(true);
    this.player.pos.set(this.room.startPos.x, 0, this.room.startPos.z);
    this.player.vel.set(0, 0, 0);
    this.player.yaw = 0.22;
    this.player.pitch = -0.04;
    this.camRoll = 0;
    this.camera.near = 0.04;
    this.camera.far = 400;
    this.camera.updateProjectionMatrix();
    this.setEnv(BLACK, 30, 120);
    this.audio.setRoom(1, 0.8);
    this.audio.setWorld(0, 0.2);
    this.audio.setCorruption(0);
    this.audio.setWind(0, 0);
    this.audio.setRumble(0);
    this.audio.resetWhine();
    this.audio.unmuffle();
    this.phase = 'room';
    this.hintT = 0;
    this.say('午前 2:47。レポートは、まだ終わらない。', 4.5);
  }
  // ------------------------------------------------------------------ frame
  private resize = () => {
    const w = Math.max(2, this.container.clientWidth);
    const h = Math.max(2, this.container.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 1.5) * this.quality;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };
  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = clamp(raw, 0.001, 0.05);
    this.time += dt;
    const post = this.post.params;
    // dynamic resolution: stay smooth on weaker GPUs
    this.frameAvg = lerp(this.frameAvg, raw, 0.05);
    if (this.frameAvg > 1 / 40 && this.quality > 0.55 && document.visibilityState === 'visible') {
      this.slowT += dt;
      if (this.slowT > 2.5) {
        this.slowT = 0;
        this.quality = Math.max(0.55, this.quality - 0.15);
        if (this.quality < 0.75) this.post.samples = 0;
        this.resize();
      }
    } else this.slowT = Math.max(0, this.slowT - dt);
    // pointer lock silently refused -> drag fallback
    if (!this.locked && !this.everLocked && !this.fallback && this.lockReqAt >= 0 && this.time - this.lockReqAt > 1.2) {
      this.fallback = true;
    }
    const cinematic = this.phase === 'devour' || this.phase === 'collapse';
    if (!cinematic) {
      // post-processing relaxes toward the calm baseline of the current place
      const inWorld = this.phase === 'world';
      const an = inWorld ? this.world.anomaly : 0;
      this.revealGlow = Math.max(0, this.revealGlow - dt * 0.25);
      post.exposure = damp(post.exposure, inWorld ? 1.35 + this.revealGlow * 0.25 : 1.5, 3, dt);
      post.bloom = damp(post.bloom, inWorld ? 0.75 + this.revealGlow * 0.8 : 0.9, 3, dt);
      post.grain = damp(post.grain, inWorld ? 0.03 : 0.05, 3, dt);
      post.sat = damp(post.sat, 1, 2, dt);
      post.blur = damp(post.blur, 0, 4, dt);
      post.lid = damp(post.lid, 0, 4, dt);
      post.flash = damp(post.flash, 0, 4, dt);
      post.scan = damp(post.scan, inWorld ? 0.035 : 0, 2, dt);
      if (this.phase !== 'monitor') {
        post.aberr = damp(post.aberr, (inWorld ? 0.0012 : 0.0015) + an * 0.012, 8, dt);
        post.glitch = an > 0.05 ? an * 0.8 : damp(post.glitch, 0, 10, dt);
        post.vignette = damp(post.vignette, inWorld ? 0.5 : 0.85, 3, dt);
        post.warp = damp(post.warp, 0, 5, dt);
      }
      if (this.restartT === 0) post.fade = damp(post.fade, 0, this.phase === 'title' ? 1.2 : 2.5, dt);
    }
    switch (this.phase) {
      case 'title': {
        const s = this.room.startPos;
        this.camera.position.set(s.x + Math.sin(this.time * 0.21) * 0.05, s.y + Math.sin(this.time * 0.33) * 0.015, s.z);
        this.camera.rotation.set(-0.04 + Math.sin(this.time * 0.27) * 0.01, 0.22 + Math.sin(this.time * 0.17) * 0.03, 0, 'YXZ');
        break;
      }
      case 'room':
      case 'after':
        this.updateRoomPhase(dt);
        break;
      case 'monitor':
        this.updateMonitor(dt);
        break;
      case 'devour':
        if (this.devour.update(dt)) {
          this.phase = 'world';
          this.hintT = 0;
          this.consoleLines = [];
        }
        break;
      case 'world':
        this.updateWorldPhase(dt);
        break;
      case 'collapse':
        if (this.collapse.update(dt)) {
          this.phase = 'after';
          this.hintT = 0;
          this.say('……夢、か。', 4);
        }
        break;
    }
    this.mdx = 0;
    this.mdy = 0;
    // restart: fade out, rebuild the first night, fade in
    if (this.restartT > 0) {
      this.restartT += dt;
      post.fade = clamp(this.restartT / 0.7);
      if (this.restartT > 0.9) {
        this.restartT = 0;
        this.doReset();
      }
    }
    // camera shake (trauma model)
    this.trauma = Math.max(0, this.trauma - dt * 1.3);
    if (this.trauma > 0.001) {
      const sh = this.trauma * this.trauma * this.post.reduce * 0.7 + this.trauma * this.trauma * 0.3;
      const t = this.time;
      this.camera.rotation.x += fnoise(t * 31, 101) * 0.04 * sh;
      this.camera.rotation.y += fnoise(t * 29, 102) * 0.04 * sh;
      this.camera.rotation.z += fnoise(t * 27, 103) * 0.07 * sh;
      this.camera.position.x += fnoise(t * 33, 104) * 0.03 * sh;
      this.camera.position.y += fnoise(t * 35, 105) * 0.03 * sh;
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    // room
    if (this.room.group.visible) {
      const c = this.bsod.mode === 'bsod' ? this.bsod.corruption : 0;
      const ticked = this.room.update(this.time, dt, smooth(0.25, 1, c));
      this.bsod.draw(this.time);
      if (this.phase !== 'devour' && this.phase !== 'collapse') {
        const cam = this.camera.position;
        const yaw = this.camera.rotation.y;
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);
        const pan = (x: number, z: number) => {
          const dx = x - cam.x;
          const dz = z - cam.z;
          const d = Math.hypot(dx, dz) || 1;
          return { pan: clamp(((dx * rx + dz * rz) / d) * 0.85, -1, 1), near: clamp(1.4 / (0.5 + d)) };
        };
        const fan = pan(-0.95, -2.1);
        this.audio.setFan(fan.pan, 0.022 + 0.05 * fan.near * (this.bsod.mode === 'bsod' ? 0.6 : 1));
        if (ticked) {
          const ck = pan(1.62, -2.48);
          this.audio.tick(ck.pan, 0.35 + ck.near * 0.9, Math.floor(this.room.clockTime) % 2 === 0);
        }
      }
    }
    // world
    if (this.world.group.visible) {
      this.tmp.copy(this.camera.position).sub(this.world.group.position);
      this.world.update(dt, this.tmp, this.phase === 'world');
    }
    this.audio.update(dt);
    this.post.render(this.scene, this.camera, this.time);
    this.syncUI(dt);
  };
  private syncUI(dt: number) {
    this.hintT += dt;
    if (this.subtitleT > 0) this.subtitleT -= dt;
    const ph = this.phase;
    let prompt = '';
    let hint = '';
    const look = this.fallback ? 'ドラッグ / 矢印キー 視点' : 'マウス 視点';
    if (ph === 'room' || ph === 'after') {
      if (this.canInteract) prompt = '[E] PCを調べる';
      if (ph === 'after') hint = 'E  PCを調べる　　R  最初からやり直す';
      else if (this.hintT < 9) hint = `WASD 移動　　${look}`;
    } else if (ph === 'monitor' && !this.mon.leaving && this.mon.k > 0.9) {
      const hit = this.bsod.hit();
      if (hit === 'face' && this.clicks < 3) prompt = 'クリック ―― 触れる';
      else if (hit === 'again') prompt = 'クリック';
      if (this.bsod.mode !== 'freeze' && !(this.bsod.mode === 'bsod' && this.bsod.corruption > 0.3)) hint = 'Q  離れる';
    } else if (ph === 'world') {
      hint = this.consoleOpen ? 'Enter 実行　　Esc / 空Enter 閉じる' : `WASD 移動　　Shift 走る　　${look}　　C コンソール`;
    }
    const next: UIState = {
      phase: ph,
      ready: true,
      prompt,
      hint,
      subtitle: this.subtitleT > 0 ? this.subtitleText : '',
      consoleOpen: this.consoleOpen,
      consoleLines: this.consoleLines,
      consoleInput: this.consoleInput,
      consoleBusy: this.collapse.active,
      paused: this.paused && this.restartT === 0,
      cinematic: ph === 'devour' || ph === 'collapse',
      crosshair: (ph === 'room' || ph === 'after' || ph === 'world') && !this.consoleOpen,
      fallback: this.fallback,
      muted: this.audio.muted,
    };
    const cur = this.ui;
    let changed = false;
    for (const key of Object.keys(next) as (keyof UIState)[]) {
      if (cur[key] !== next[key]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      this.ui = next;
      this.onUI(next);
    }
  }
  // ------------------------------------------------------------------ test hooks (?debug)
  debugGo(target: 'bsod' | 'devour' | 'world' | 'tower' | 'collapse') {
    if (this.phase === 'title') this.start();
    if (target === 'bsod' || target === 'devour') {
      this.canInteract = true;
      if (this.phase !== 'monitor') this.enterMonitor();
      this.mon.crashAt = 0.2;
      if (target === 'devour') {
        this.mon.k = 1;
        this.bsod.setMode('bsod');
        this.room.setScreenLight('#2f7dff', 1.25);
        this.clicks = CLICKS;
        this.corruptionTarget = 1;
      }
      return;
    }
    this.showRoom(false);
    this.showWorld(true);
    this.camera.near = 0.3;
    this.camera.far = 3200;
    this.camera.updateProjectionMatrix();
    this.audio.setRoom(0);
    this.audio.setWorld(1);
    const z = target === 'world' ? WORLD.spawn.z : 21;
    this.player.pos.set(0, groundHeight(0, z), z);
    this.player.yaw = 0;
    this.player.pitch = target === 'world' ? 0.05 : 0.3;
    this.phase = 'world';
    if (target === 'collapse') this.startCollapse();
  }
  debugState() {
    return {
      phase: this.phase,
      pos: this.camera.position.toArray().map((v) => +v.toFixed(2)),
      rot: [this.camera.rotation.x, this.camera.rotation.y, this.camera.rotation.z].map((v) => +v.toFixed(2)),
      corruption: +this.bsod.corruption.toFixed(2),
      mode: this.bsod.mode,
      locked: this.locked,
      fallback: this.fallback,
      console: this.consoleOpen,
      quality: this.quality,
      fps: Math.round(1 / this.frameAvg),
      wrap: wrapAngle(this.player.yaw + TAU).toFixed(2),
    };
  }
}
