import * as THREE from 'three';
import { TAU, clamp, fnoise, hash1, lerp, smooth, stepNoise } from './utils';
import { JP_FONT, MONO_FONT, makeCanvas } from './textures';
export type ScreenMode = 'desktop' | 'freeze' | 'bsod' | 'after';
const W = 1024;
const H = 576;
const BLUE = '#0078d7';
const GLITCH_CHARS = '█▓▒░#?:(%&0x';
const AGAIN = { x: 437, y: 318, w: 150, h: 38 };
const COLS = 12;
const ROWS = 7;
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
  eye: boolean;
}
interface Letter {
  ch: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  vr: number;
  size: number;
}
interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  weight: number;
}
/**
 * The monitor. Renders the desktop, the BSOD and the face that the ":("
 * turns into, on a 2D canvas that is used as the screen texture.
 */
export class BsodScreen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mode: ScreenMode = 'desktop';
  corruption = 0;
  rage = 0;
  scream = 0;
  hover = false;
  loop = 0;
  cursorX = 0.62;
  cursorY = 0.66;
  showCursor = false;
  faceX = 172;
  faceY = 150;
  faceR = 110;
  /** tiles that just peeled off (the engine turns them into 3D flakes) */
  peelQueue: Tile[] = [];
  private desktop: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  private holes: Tile[] = [];
  private holeSet = new Set<number>();
  private removed = new Map<number, Set<number>>();
  private letters: Letter[] = [];
  private widths = new Map<string, number>();
  private lastDraw = -10;
  private lastT = 0;
  constructor() {
    const [c, g] = makeCanvas(W, H);
    this.canvas = c;
    this.ctx = g;
    const [d, dg] = makeCanvas(W, H);
    this.desktop = d;
    this.dctx = dg;
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.renderDesktop(false);
    this.draw(0, true);
  }
  reset() {
    this.corruption = 0;
    this.rage = 0;
    this.scream = 0;
    this.hover = false;
    this.holes = [];
    this.holeSet.clear();
    this.removed.clear();
    this.letters = [];
    this.peelQueue = [];
  }
  setMode(mode: ScreenMode) {
    this.mode = mode;
    if (mode === 'desktop') this.renderDesktop(false);
    if (mode === 'after') this.renderDesktop(true);
    this.lastDraw = -10;
  }
  /** what is under the on-screen cursor */
  hit(): 'face' | 'again' | null {
    const x = this.cursorX * W;
    const y = this.cursorY * H;
    if (this.mode === 'bsod') return Math.hypot(x - this.faceX, y - this.faceY) < this.faceR ? 'face' : null;
    if (this.mode === 'after')
      return x > AGAIN.x && x < AGAIN.x + AGAIN.w && y > AGAIN.y && y < AGAIN.y + AGAIN.h ? 'again' : null;
    return null;
  }
  /** a tile of the picture peels away */
  peel(n: number) {
    for (let k = 0; k < n; k++) {
      if (this.holeSet.size >= COLS * ROWS - 6) return;
      let idx = 0;
      for (let tries = 0; tries < 12; tries++) {
        idx = Math.floor(Math.random() * COLS * ROWS);
        if (!this.holeSet.has(idx)) break;
      }
      if (this.holeSet.has(idx)) continue;
      this.holeSet.add(idx);
      const tw = W / COLS;
      const th = H / ROWS;
      const tile: Tile = {
        x: (idx % COLS) * tw,
        y: Math.floor(idx / COLS) * th,
        w: tw,
        h: th,
        eye: this.holes.length % 4 === 2,
      };
      this.holes.push(tile);
      this.peelQueue.push(tile);
    }
  }
  /** characters come loose and fall off the screen */
  dropLetters(n: number) {
    const lines = this.lines();
    const g = this.ctx;
    for (let k = 0; k < n; k++) {
      const li = Math.floor(Math.random() * lines.length);
      const line = lines[li];
      const ci = Math.floor(Math.random() * line.text.length);
      const ch = line.text[ci];
      if (!ch || ch === ' ') continue;
      let set = this.removed.get(li);
      if (!set) this.removed.set(li, (set = new Set()));
      if (set.has(ci)) continue;
      set.add(ci);
      g.font = `${line.weight} ${line.size}px ${JP_FONT}`;
      let x = line.x;
      for (let i = 0; i < ci; i++) x += this.cw(line.text[i], line.size, line.weight);
      this.letters.push({
        ch,
        x,
        y: line.y,
        vx: (Math.random() - 0.5) * 60,
        vy: -40 - Math.random() * 60,
        r: 0,
        vr: (Math.random() - 0.5) * 9,
        size: line.size,
      });
    }
  }
  private cw(ch: string, size: number, weight: number) {
    const key = `${size}|${weight}|${ch}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      w = this.ctx.measureText(ch).width;
      this.widths.set(key, w);
    }
    return w;
  }
  private lines(): Line[] {
    const c = this.corruption;
    const again = this.loop > 0;
    let l0 = again
      ? 'また問題が発生したため、PC を再起動する必要があります。'
      : '問題が発生したため、PC を再起動する必要があります。';
    let l1 = 'エラー情報を収集しています。自動的に再起動します。';
    if (c > 0.86) l0 = '開けて開けて開けて開けて開けて開けて開けて開けて開けて';
    else if (c > 0.6) l0 = '問題はあなたです。あなたを再起動する必要があります。';
    else if (c > 0.3) l0 = '問題が発生したため、あなた を再起動する必要があります。';
    if (c > 0.8) l1 = '見ている見ている見ている見ている見ている見ている';
    else if (c > 0.5) l1 = 'あなたの情報を収集しています。自動的に、あなたを。';
    let pct = '0% 完了';
    if (c > 0.9) pct = '████% 完了';
    else if (c > 0.12) pct = `-${Math.round(c * 130)}% 完了`;
    let code = again ? 'YOU_CAME_BACK' : 'CRITICAL_PROCESS_DIED';
    if (c > 0.75) code = 'OPEN_WIDE';
    else if (c > 0.5) code = 'YOU_ARE_THE_PROCESS';
    else if (c > 0.25) code = 'CRITICAL_PROCESS_NOT_DEAD';
    return [
      { text: l0, x: 96, y: 318, size: 27, weight: 300 },
      { text: l1, x: 96, y: 356, size: 27, weight: 300 },
      { text: pct, x: 96, y: 412, size: 27, weight: 300 },
      {
        text: 'この問題と可能な解決方法の詳細については、https://stopcode.example/ を参照してください。',
        x: 196,
        y: 466,
        size: 13,
        weight: 400,
      },
      { text: 'サポート担当者に連絡する場合は、この情報を伝えてください:', x: 196, y: 500, size: 12, weight: 400 },
      { text: `停止コード: ${code}`, x: 196, y: 520, size: 12, weight: 400 },
    ];
  }
  // ------------------------------------------------------------------
  private renderDesktop(after: boolean) {
    const g = this.dctx;
    const gr = g.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, '#0b1826');
    gr.addColorStop(1, '#1f4254');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(120,190,210,0.07)';
    g.beginPath();
    g.arc(760, 520, 380, 0, TAU);
    g.fill();
    g.beginPath();
    g.arc(820, 560, 260, 0, TAU);
    g.fill();
    // icons
    const icons = ['ごみ箱', 'レポート', '講義資料', 'ゲーム', '新しいフォルダー (3)'];
    const cols = ['#9aa7b5', '#3e7bd6', '#d8a23a', '#7d54c9', '#d8b65a'];
    g.textAlign = 'center';
    icons.forEach((name, i) => {
      g.fillStyle = cols[i];
      g.fillRect(40, 22 + i * 82, 38, 38);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(40, 22 + i * 82, 38, 9);
      g.fillStyle = '#e9eef2';
      g.font = `11px ${JP_FONT}`;
      g.fillText(name, 59, 76 + i * 82, 96);
    });
    g.textAlign = 'left';
    // document window
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(176, 40, 568, 446);
    g.fillStyle = '#2a2d33';
    g.fillRect(170, 32, 568, 30);
    g.fillStyle = '#d7dbe0';
    g.font = `13px ${JP_FONT}`;
    g.fillText('レポート_最終_v7_本当に最終.docx', 182, 52);
    g.font = `13px ${MONO_FONT}`;
    g.fillText('—  □  ×', 664, 52);
    g.fillStyle = '#f3f1ea';
    g.fillRect(170, 62, 568, 418);
    g.fillStyle = '#23262b';
    g.font = `bold 21px ${JP_FONT}`;
    g.fillText('第3章　考察', 204, 104);
    g.fillStyle = '#a5a8ad';
    const widths = [490, 500, 470, 505, 320, 0, 495, 480, 500, 440, 498, 210, 0, 500, 486];
    widths.forEach((w, i) => {
      if (w) g.fillRect(204, 126 + i * 20, w, 8);
    });
    g.fillStyle = '#23262b';
    g.font = `15px ${JP_FONT}`;
    g.fillText(after ? '以上のことから、WAKE_UP' : '以上のことから、', 204, 446);
    // chat window
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(772, 250, 236, 236);
    g.fillStyle = '#1b2230';
    g.fillRect(766, 242, 236, 236);
    g.fillStyle = '#2b3650';
    g.fillRect(766, 242, 236, 28);
    g.fillStyle = '#dfe6f2';
    g.font = `12px ${JP_FONT}`;
    g.fillText('ユウタ', 778, 261);
    const bubbles: [string, boolean][] = [
      ['まだ起きてる？', false],
      ['〆切、朝9時', true],
      ['ｗｗｗ 寝ろ', false],
      ['寝たら終わる', true],
    ];
    bubbles.forEach(([text, me], i) => {
      g.font = `13px ${JP_FONT}`;
      const tw = g.measureText(text).width + 18;
      const x = me ? 992 - tw : 776;
      g.fillStyle = me ? '#3566c9' : '#333d52';
      g.fillRect(x, 282 + i * 36, tw, 26);
      g.fillStyle = '#eef2f8';
      g.fillText(text, x + 9, 300 + i * 36);
    });
    if (after) {
      g.fillStyle = '#333d52';
      g.fillRect(776, 426, 86, 26);
      g.fillStyle = '#eef2f8';
      g.fillText('起きた？', 785, 444);
    }
    // taskbar
    g.fillStyle = '#0d1014';
    g.fillRect(0, H - 36, W, 36);
    g.fillStyle = '#3e8be0';
    g.fillRect(12, H - 27, 18, 18);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = ['#d8a23a', '#3e7bd6', '#4fae6a', '#c9544f', '#9aa7b5'][i];
      g.fillRect(52 + i * 34, H - 26, 16, 16);
    }
    g.fillStyle = '#3e7bd6';
    g.fillRect(84, H - 4, 20, 2);
    g.fillStyle = '#dfe6f2';
    g.font = `12px ${JP_FONT}`;
    g.textAlign = 'right';
    g.fillText('2:47', W - 16, H - 20);
    g.fillText('11/14', W - 16, H - 6);
    g.textAlign = 'left';
  }
  // ------------------------------------------------------------------
  draw(time: number, force = false) {
    const quiet = this.mode === 'desktop' || this.mode === 'after';
    const interval = quiet ? (this.showCursor ? 1 / 30 : 0.5) : this.mode === 'freeze' ? 1 / 12 : 1 / 50;
    if (!force && time - this.lastDraw < interval) return;
    const dt = clamp(time - this.lastT, 0, 0.1);
    this.lastT = time;
    this.lastDraw = time;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    if (this.mode === 'desktop') {
      g.drawImage(this.desktop, 0, 0);
      if (Math.floor(time * 1.8) % 2 === 0) {
        g.fillStyle = '#23262b';
        g.fillRect(326, 432, 1.5, 17);
      }
      if (this.showCursor) this.drawCursor();
    } else if (this.mode === 'freeze') {
      g.drawImage(this.desktop, 0, 0);
      const seed = Math.floor(time * 12);
      for (let i = 0; i < 9; i++) {
        const y = hash1(i * 3.3 + seed * 0.37) * H;
        const h = 6 + hash1(i * 9.1) * 50;
        const dx = (hash1(i * 5.7 + seed) - 0.5) * 220;
        g.drawImage(this.canvas, 0, y, W, h, dx, y, W, h);
      }
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(170, 32, 568, 448);
      g.fillStyle = '#2a2d33';
      g.font = `13px ${JP_FONT}`;
      g.fillText('レポート_最終_v7_本当に最終.docx（応答なし）', 182, 52);
      this.drawCursor();
    } else if (this.mode === 'after') {
      g.drawImage(this.desktop, 0, 0);
      this.drawAfterDialog(time);
      if (this.showCursor) this.drawCursor();
    } else {
      this.drawBsod(time, dt);
    }
    this.texture.needsUpdate = true;
  }
  private drawAfterDialog(t: number) {
    const g = this.ctx;
    const x = 352;
    const y = 176;
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x + 6, y + 8, 320, 200);
    g.fillStyle = BLUE;
    g.fillRect(x, y, 320, 200);
    g.fillStyle = '#eef5ff';
    g.fillRect(x, y, 320, 28);
    g.fillStyle = '#0a5cc0';
    g.font = `bold 13px ${JP_FONT}`;
    g.fillText('YOU.exe', x + 10, y + 19);
    g.fillStyle = '#fff';
    const sad = stepNoise(t, 9, 77) > 0.975;
    g.font = `200 64px ${JP_FONT}`;
    g.fillText(sad ? ':(' : ':)', x + 26, y + 100);
    g.font = `17px ${JP_FONT}`;
    g.fillText('おかえりなさい。', x + 112, y + 74);
    g.font = `12px ${JP_FONT}`;
    g.fillText(`起床回数: ${this.loop}`, x + 112, y + 100);
    const hot = this.hit() === 'again';
    g.fillStyle = hot ? '#fff' : 'rgba(255,255,255,0.12)';
    g.fillRect(AGAIN.x, AGAIN.y, AGAIN.w, AGAIN.h);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.strokeRect(AGAIN.x, AGAIN.y, AGAIN.w, AGAIN.h);
    g.fillStyle = hot ? '#0a5cc0' : '#fff';
    g.font = `bold 15px ${JP_FONT}`;
    g.textAlign = 'center';
    g.fillText('もう一度 眠る', AGAIN.x + AGAIN.w / 2, AGAIN.y + 25);
    g.textAlign = 'left';
  }
  private drawCursor() {
    const g = this.ctx;
    g.save();
    g.translate(this.cursorX * W, this.cursorY * H);
    g.scale(1.6, 1.6);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, 16);
    g.lineTo(4, 12.5);
    g.lineTo(6.8, 18.6);
    g.lineTo(9, 17.6);
    g.lineTo(6.3, 11.6);
    g.lineTo(11.5, 11.6);
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }
  private drawBsod(t: number, dt: number) {
    const g = this.ctx;
    const c = this.corruption;
    const rage = this.rage;
    const scr = this.scream;
    // background — at high corruption it is not fully cleared, so everything smears
    g.globalAlpha = 1 - clamp(c - 0.45) * 0.8;
    g.fillStyle = BLUE;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    if (c > 0.55 && stepNoise(t, 15, 3) > 1.22 - c * 0.5) {
      g.fillStyle = 'rgba(0,6,50,0.55)';
      g.fillRect(0, 0, W, H);
    }
    // peeled tiles: the picture is a skin, and there is something under it
    for (const h of this.holes) {
      g.fillStyle = '#00040d';
      g.fillRect(h.x, h.y, h.w, h.h);
      g.fillStyle = 'rgba(255,255,255,0.28)';
      g.fillRect(h.x, h.y, h.w, 1.5);
      g.fillRect(h.x, h.y, 1.5, h.h);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(h.x + h.w, h.y + 3, 3, h.h);
      if (h.eye && c > 0.4) {
        const ex = h.x + h.w / 2;
        const ey = h.y + h.h / 2;
        const dx = this.cursorX * W - ex;
        const dy = this.cursorY * H - ey;
        const d = Math.hypot(dx, dy) || 1;
        g.fillStyle = '#fff';
        g.beginPath();
        g.ellipse(ex, ey, 24, stepNoise(t, 4, h.x) > 0.9 ? 2 : 13, 0, 0, TAU);
        g.fill();
        g.fillStyle = '#00123a';
        g.beginPath();
        g.arc(ex + (dx / d) * 12, ey + (dy / d) * 5, 5.5, 0, TAU);
        g.fill();
      }
    }
    const fade = 1 - smooth(0, 0.5, scr);
    if (fade > 0.01) {
      g.globalAlpha = fade;
      g.fillStyle = '#fff';
      const lines = this.lines();
      lines.forEach((l, i) => this.drawLine(i, l, t));
      // QR code
      const qx = 96 + (c > 0.3 ? fnoise(t * 20, 8) * c * 10 : 0);
      g.fillStyle = '#fff';
      g.fillRect(qx, 448, 84, 84);
      g.fillStyle = BLUE;
      const qs = Math.floor(t * (c > 0.2 ? 6 * c : 0));
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 12; x++) {
          const finder = (x < 4 && y < 4) || (x > 7 && y < 4) || (x < 4 && y > 7);
          const on = finder
            ? (x % 4 === 1 || x % 4 === 2) && (y % 4 === 1 || y % 4 === 2)
            : hash1(x * 7.1 + y * 13.3 + qs * 3.7) > 0.5;
          if (on) g.fillRect(qx + x * 7, 448 + y * 7, 7, 7);
        }
      g.globalAlpha = 1;
    }
    // falling letters
    g.fillStyle = '#fff';
    for (const l of this.letters) {
      l.vy += 1100 * dt;
      l.x += l.vx * dt;
      l.y += l.vy * dt;
      l.r += l.vr * dt;
      g.save();
      g.translate(l.x, l.y);
      g.rotate(l.r);
      g.font = `300 ${l.size}px ${JP_FONT}`;
      g.fillText(l.ch, 0, 0);
      g.restore();
    }
    if (this.letters.length) this.letters = this.letters.filter((l) => l.y < H + 60);
    this.drawFace(t);
    if (scr < 0.2) this.drawCursor();
    // horizontal tearing
    const n = Math.floor(rage * 5 + c * 3 * hash1(Math.floor(t * 20)) + scr * 7);
    for (let i = 0; i < n; i++) {
      const y = Math.random() * H;
      const h = 3 + Math.random() * (20 + c * 50);
      const dx = (Math.random() - 0.5) * (24 + c * 240);
      g.drawImage(this.canvas, 0, y, W, h, dx, y, W, h);
    }
    if (c > 0.3 && Math.random() < c * 0.5) {
      g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.75)' : 'rgba(0,4,30,0.8)';
      g.fillRect(Math.random() * W, Math.random() * H, 30 + Math.random() * 300, 2 + Math.random() * 10);
    }
  }
  private drawLine(idx: number, line: Line, t: number) {
    const g = this.ctx;
    const c = this.corruption;
    g.font = `${line.weight} ${line.size}px ${JP_FONT}`;
    const rem = this.removed.get(idx);
    if (!rem && c < 0.04 && this.rage < 0.03) {
      g.fillText(line.text, line.x, line.y);
      return;
    }
    const frame = Math.floor(t * 16);
    const shift =
      c > 0.1 && hash1(idx * 5.3 + frame * 1.7) > 1 - c * 0.3 ? (hash1(idx * 3.1 + frame) - 0.5) * 140 * c : 0;
    let px = line.x + shift;
    for (let i = 0; i < line.text.length; i++) {
      let ch = line.text[i];
      const w = this.cw(ch, line.size, line.weight);
      if (!(rem && rem.has(i))) {
        const rnd = hash1(i * 13.7 + idx * 91.3 + frame * 7.1);
        let oy = 0;
        if (rnd < c * 0.1 + this.rage * 0.06) ch = GLITCH_CHARS[Math.floor(rnd * 9973) % GLITCH_CHARS.length];
        if (rnd > 1 - c * 0.22) oy = (hash1(rnd * 77.7) - 0.5) * 16 * c;
        g.fillText(ch, px, line.y + oy);
      }
      px += w;
    }
  }
  private drawFace(t: number) {
    const c = this.corruption;
    const rage = this.rage;
    const scr = this.scream;
    const up = smooth(0.3, 0.6, c);
    const move = smooth(0.3, 0.72, c);
    const mad = smooth(0.45, 1, c);
    let theta = (-Math.PI / 2) * (1 - up);
    // early on it only twitches: the head lifts for a frame or two, then drops back
    if (c > 0.05 && c < 0.62) {
      const tw = stepNoise(t, 7, 5);
      if (tw > 1 - (0.08 + c * 0.5)) theta += (0.2 + hash1(Math.floor(t * 7)) * 0.9) * (0.3 + c);
    }
    if (this.hover && c < 0.3) theta += Math.sin(t * 33) * 0.012 + 0.035;
    // later: a head that cannot hold still
    theta +=
      Math.sin(t * 2.7) * 0.2 * mad +
      (stepNoise(t, 13, 9) - 0.5) * 0.75 * mad * mad +
      fnoise(t * 23, 4) * rage * (0.1 + 0.3 * c);
    const base = lerp(1, 2.25, smooth(0.32, 1, c));
    const sc = base * (1 + rage * 0.07 + Math.sin(t * 37) * 0.025 * mad) * (1 + scr * scr * 6);
    const shake = c * c * 22 + rage * (4 + 34 * c) + scr * 26;
    const bx = lerp(172, 512, move);
    const by = lerp(150, 258, move);
    let cx = bx + fnoise(t * 29, 1) * shake;
    let cy = by + fnoise(t * 31, 2) * shake;
    if (mad > 0.2 && stepNoise(t, 17, 21) > 1 - mad * 0.22) {
      cx += (hash1(Math.floor(t * 17) * 9.1) - 0.5) * 260 * mad;
      cy += (hash1(Math.floor(t * 17) * 5.7) - 0.5) * 130 * mad;
    }
    // while screaming, the open mouth swallows the whole picture
    const k = smooth(0, 0.7, scr);
    cx = lerp(cx, W / 2 + fnoise(t * 29, 1) * 8, k);
    cy = lerp(cy, H / 2 - 150 * sc, k);
    this.faceX = bx;
    this.faceY = by + (c > 0.4 ? 24 : 0);
    this.faceR = Math.min(300, 112 * base);
    if (mad > 0.25 && scr < 0.3) {
      const o = shake * 1.6 + 8;
      this.faceShape(t, cx + o, cy - o * 0.4, theta + 0.1 * mad, sc * 1.04, 0.22 * mad);
      this.faceShape(t, cx - o, cy + o * 0.5, theta - 0.14 * mad, sc * 0.97, 0.22 * mad);
    }
    this.faceShape(t, cx, cy, theta, sc, 1);
  }
  private faceShape(t: number, cx: number, cy: number, theta: number, sc: number, alpha: number) {
    const g = this.ctx;
    const c = this.corruption;
    const rage = this.rage;
    const scr = this.scream;
    const mad = smooth(0.45, 1, c);
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx, cy);
    g.rotate(theta);
    g.scale(sc, sc);
    // cursor in face-local space (the pupils follow it)
    const dx = this.cursorX * W - cx;
    const dy = this.cursorY * H - cy;
    const cs = Math.cos(-theta);
    const sn = Math.sin(-theta);
    const lx = (dx * cs - dy * sn) / sc;
    const ly = (dx * sn + dy * cs) / sc;
    const eyeR = lerp(9.5, 31, smooth(0.34, 0.92, c));
    const spread = 42 * (1 + smooth(0.3, 0.7, c) * 0.38);
    const blinkAll = c > 0.08 && c < 0.8 && stepNoise(t, 5, 40) > 0.94;
    for (let s = -1; s <= 1; s += 2) {
      const bulge =
        1 +
        (s < 0 ? 1 : -0.55) * smooth(0.5, 1, c) * (0.22 + 0.22 * Math.sin(t * 9.1)) +
        (stepNoise(t, 9, 30 + s) > 0.9 ? 0.5 * mad : 0);
      const r = eyeR * bulge;
      let ex = s * spread;
      let ey = -55;
      if (c < 0.3 && this.hover) {
        // even the dots lean toward the pointer
        const d = Math.hypot(lx - ex, ly - ey) || 1;
        ex += ((lx - ex) / d) * 1.6;
        ey += ((ly - ey) / d) * 1.6;
      }
      g.fillStyle = '#fff';
      g.beginPath();
      g.ellipse(ex, ey, r, blinkAll ? r * 0.14 : r, 0, 0, TAU);
      g.fill();
      if (c > 0.36 && !blinkAll) {
        const pr = r * lerp(0.58, 0.22, smooth(0.4, 1, c)) * (1 + rage * 0.35);
        const d = Math.hypot(lx - ex, ly - ey) || 1;
        const kk = Math.min(1, d / 120) * (r - pr) * 0.85;
        const px = ex + ((lx - ex) / d) * kk + fnoise(t * 40, 50 + s) * mad * r * 0.3;
        const py = ey + ((ly - ey) / d) * kk + fnoise(t * 43, 60 + s) * mad * r * 0.3;
        g.fillStyle = '#00123a';
        g.beginPath();
        g.arc(px, py, pr, 0, TAU);
        g.fill();
        if (c > 0.64) {
          g.strokeStyle = 'rgba(255,255,255,0.9)';
          g.lineWidth = 1.3;
          for (let v = 0; v < 7; v++) {
            const a = hash1(v * 3.7 + s * 11) * TAU;
            const len = r * (0.5 + hash1(v * 9.3 + s) * 1.3) * smooth(0.64, 1, c);
            g.beginPath();
            let vx = ex + Math.cos(a) * r * 1.02;
            let vy = ey + Math.sin(a) * r * 1.02;
            g.moveTo(vx, vy);
            for (let j = 1; j <= 3; j++) {
              const aa = a + (hash1(v * 5.1 + j * 2.3 + Math.floor(t * 12)) - 0.5) * 0.9;
              vx += (Math.cos(aa) * len) / 3;
              vy += (Math.sin(aa) * len) / 3;
              g.lineTo(vx, vy);
            }
            g.stroke();
          }
        }
      }
    }
    // mouth: the "(" becomes a frown, the frown opens
    const open = smooth(0.42, 1, c) * 0.85 + scr * 2.1 + rage * 0.12 * c;
    const R = 133;
    const phi = 0.7435;
    if (open < 0.03) {
      g.strokeStyle = '#fff';
      g.lineWidth = 11 + c * 5;
      g.beginPath();
      g.arc(0, 20 + R, R, -Math.PI / 2 - phi, -Math.PI / 2 + phi);
      g.stroke();
    } else {
      const wd = 90 * (1 + open * 0.28);
      const cyc = 55;
      const bottom = cyc + open * 230 * (1 + Math.sin(t * 41) * 0.05 * mad);
      const path = () => {
        g.beginPath();
        g.moveTo(-wd, cyc);
        g.quadraticCurveTo(0, -15, wd, cyc);
        g.quadraticCurveTo(0, bottom, -wd, cyc);
        g.closePath();
      };
      path();
      g.fillStyle = '#00030c';
      g.fill();
      g.save();
      g.clip();
      const my = (20 + (cyc + bottom) / 2) / 2 + 14;
      for (let i = 0; i < 4; i++) {
        const ph = (t * 1.4 + i / 4) % 1;
        g.strokeStyle = `rgba(60,150,255,${0.55 * ph})`;
        g.lineWidth = 2.5;
        g.beginPath();
        g.ellipse(0, my, wd * (1 - ph * 0.85), (bottom - 20) * 0.5 * (1 - ph * 0.85), 0, 0, TAU);
        g.stroke();
      }
      g.restore();
      // teeth
      g.fillStyle = '#fff';
      const N = 9;
      const q = (u: number, cyy: number) => {
        const a = 1 - u;
        return [a * a * -wd + u * u * wd, a * a * cyc + 2 * a * u * cyy + u * u * cyc];
      };
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N;
        const hw = (wd / N) * 0.78;
        const jit = 1 + fnoise(t * 30, i) * 0.2 * mad;
        const len = (12 + open * 44) * (0.55 + hash1(i * 7.3) * 0.8) * jit * Math.sin(u * Math.PI);
        const [ux, uy] = q(u, -15);
        g.beginPath();
        g.moveTo(ux - hw, uy - 2);
        g.lineTo(ux + hw, uy - 2);
        g.lineTo(ux + (hash1(i * 3.1) - 0.5) * hw, uy + len);
        g.fill();
        const [bx2, by2] = q(u, bottom);
        const len2 = len * 0.8;
        g.beginPath();
        g.moveTo(bx2 - hw, by2 + 2);
        g.lineTo(bx2 + hw, by2 + 2);
        g.lineTo(bx2 + (hash1(i * 4.9) - 0.5) * hw, by2 - len2);
        g.fill();
      }
      path();
      g.strokeStyle = '#fff';
      g.lineWidth = 8;
      g.lineJoin = 'round';
      g.stroke();
    }
    g.restore();
  }
}
