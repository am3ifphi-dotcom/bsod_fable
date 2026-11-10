import * as THREE from 'three';
import { mulberry } from './utils';
export const JP_FONT =
  "'Yu Gothic UI','Segoe UI','Hiragino Sans','Hiragino Kaku Gothic ProN','Meiryo','Noto Sans JP','Noto Sans CJK JP',sans-serif";
export const MONO_FONT = "'Consolas','Lucida Console','Menlo','DejaVu Sans Mono','Courier New',monospace";
export function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  return [c, g] as const;
}
function finish(c: HTMLCanvasElement, repeat = false, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
export function woodTexture() {
  const [c, g] = makeCanvas(512, 512);
  const r = mulberry(11);
  g.fillStyle = '#4b3423';
  g.fillRect(0, 0, 512, 512);
  const ph = 64;
  for (let row = 0; row < 8; row++) {
    let x = -r() * 200;
    while (x < 512) {
      const w = 180 + r() * 160;
      const l = 22 + r() * 9;
      g.fillStyle = `hsl(${24 + r() * 8},${32 + r() * 10}%,${l}%)`;
      g.fillRect(x, row * ph, w, ph);
      g.globalAlpha = 0.16;
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = r() > 0.5 ? '#1c120a' : '#8a6344';
        g.lineWidth = 0.6 + r();
        const y = row * ph + r() * ph;
        g.beginPath();
        g.moveTo(x, y);
        g.bezierCurveTo(x + w * 0.3, y + (r() - 0.5) * 6, x + w * 0.6, y + (r() - 0.5) * 6, x + w, y + (r() - 0.5) * 4);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(8,5,3,0.75)';
      g.fillRect(x + w - 1.5, row * ph, 2, ph);
      x += w;
    }
    g.fillStyle = 'rgba(8,5,3,0.8)';
    g.fillRect(0, row * ph, 512, 2);
  }
  return finish(c, true);
}
export function wallTexture() {
  const [c, g] = makeCanvas(256, 256);
  const r = mulberry(5);
  g.fillStyle = '#b3ada0';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
  }
  for (let x = 0; x < 256; x += 16) {
    g.fillStyle = 'rgba(0,0,0,0.035)';
    g.fillRect(x, 0, 1, 256);
  }
  return finish(c, true);
}
export function rugTexture() {
  const [c, g] = makeCanvas(256, 192);
  const r = mulberry(8);
  g.fillStyle = '#2a2f45';
  g.fillRect(0, 0, 256, 192);
  g.strokeStyle = '#8b7a5a';
  g.lineWidth = 4;
  g.strokeRect(12, 12, 232, 168);
  g.lineWidth = 1.5;
  g.strokeRect(22, 22, 212, 148);
  g.strokeStyle = '#59506e';
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.moveTo(40 + i * 22, 40);
    g.lineTo(52 + i * 22, 96);
    g.lineTo(40 + i * 22, 152);
    g.stroke();
  }
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.1)';
    g.fillRect(r() * 256, r() * 192, 1, 2);
  }
  return finish(c);
}
export function keyboardTexture() {
  const [c, g] = makeCanvas(512, 176);
  g.fillStyle = '#0c0c0f';
  g.fillRect(0, 0, 512, 176);
  const rows = [14, 14, 13, 12, 9];
  for (let ry = 0; ry < 5; ry++) {
    const n = rows[ry];
    const kw = (512 - 16) / n;
    for (let i = 0; i < n; i++) {
      const wide = ry === 4 && i === 4;
      g.fillStyle = '#1b1c22';
      const x = 8 + i * kw + 2;
      const y = 8 + ry * 32 + 2;
      g.fillRect(x, y, kw - 4, 28);
      g.fillStyle = wide ? 'rgba(120,150,255,0.12)' : 'rgba(150,175,255,0.42)';
      g.fillRect(x + 5, y + 6, wide ? kw - 14 : 5, 2);
    }
  }
  return finish(c);
}
export function posterTexture(kind: number) {
  const [c, g] = makeCanvas(256, 360);
  if (kind === 2) {
    g.fillStyle = '#0078d7';
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = '#fff';
    g.font = `200 150px ${JP_FONT}`;
    g.textAlign = 'center';
    g.fillText(':(', 128, 215);
    g.font = `12px ${JP_FONT}`;
    g.fillText('0% 完了', 128, 300);
    return finish(c);
  }
  const r = mulberry(40 + kind);
  if (kind === 0) {
    const gr = g.createLinearGradient(0, 0, 0, 360);
    gr.addColorStop(0, '#10122a');
    gr.addColorStop(0.6, '#4b2350');
    gr.addColorStop(1, '#d0603a');
    g.fillStyle = gr;
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = '#f3d9a4';
    g.beginPath();
    g.arc(128, 190, 54, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b0b16';
    g.beginPath();
    g.moveTo(0, 360);
    g.lineTo(0, 270);
    for (let x = 0; x <= 256; x += 16) g.lineTo(x, 250 + r() * 40);
    g.lineTo(256, 360);
    g.fill();
    g.fillStyle = '#f4efe6';
    g.font = `bold 30px ${JP_FONT}`;
    g.textAlign = 'center';
    g.fillText('夜 行', 128, 70);
    g.font = `11px ${MONO_FONT}`;
    g.fillText('YAKOU  —  LIVE TOUR', 128, 92);
  } else {
    g.fillStyle = '#e8e3d8';
    g.fillRect(0, 0, 256, 360);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = ['#d84b3e', '#20395c', '#e2a93b', '#1a1a1a'][i % 4];
      g.globalAlpha = 0.9;
      g.fillRect(20 + r() * 150, 30 + r() * 220, 30 + r() * 70, 30 + r() * 70);
    }
    g.globalAlpha = 1;
    g.fillStyle = '#1a1a1a';
    g.font = `bold 24px ${JP_FONT}`;
    g.fillText('サイレント', 22, 322);
    g.font = `10px ${MONO_FONT}`;
    g.fillText('EXHIBITION 2019', 22, 340);
  }
  return finish(c);
}
export function calendarTexture() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#efece4';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#b3382c';
  g.fillRect(0, 0, 256, 46);
  g.fillStyle = '#fff';
  g.font = `bold 26px ${JP_FONT}`;
  g.fillText('11月', 14, 33);
  g.fillStyle = '#333';
  g.font = `15px ${MONO_FONT}`;
  for (let d = 1; d <= 30; d++) {
    const col = (d + 4) % 7;
    const row = Math.floor((d + 4) / 7);
    g.fillStyle = col === 0 ? '#b3382c' : '#333';
    g.fillText(String(d), 16 + col * 33, 76 + row * 36);
    if (d === 14) {
      g.strokeStyle = '#d11';
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(26 + col * 33, 71 + row * 36, 15, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#d11';
      g.font = `bold 10px ${JP_FONT}`;
      g.fillText('〆切', 13 + col * 33, 92 + row * 36);
      g.font = `15px ${MONO_FONT}`;
    }
  }
  return finish(c);
}
export function clockTexture() {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#e9e6dd';
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a1a1a';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const big = i % 5 === 0;
    g.save();
    g.translate(128, 128);
    g.rotate(a);
    g.fillRect(-(big ? 2.5 : 1), -118, big ? 5 : 2, big ? 16 : 7);
    g.restore();
  }
  g.font = `bold 24px ${JP_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.fillText(String(i), 128 + Math.sin(a) * 88, 128 - Math.cos(a) * 88);
  }
  return finish(c);
}
export function cityTexture() {
  const [c, g] = makeCanvas(256, 256);
  const r = mulberry(77);
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#060a16');
  gr.addColorStop(0.7, '#141d38');
  gr.addColorStop(1, '#27304f');
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 16; i++) {
    const x = r() * 256;
    const w = 20 + r() * 40;
    const h = 60 + r() * 130;
    g.fillStyle = `rgb(${8 + r() * 8},${10 + r() * 8},${18 + r() * 10})`;
    g.fillRect(x, 256 - h, w, h);
    for (let k = 0; k < 14; k++) {
      if (r() > 0.45) continue;
      g.fillStyle = r() > 0.3 ? 'rgba(255,214,150,0.8)' : 'rgba(170,205,255,0.8)';
      g.fillRect(x + 3 + Math.floor(r() * (w / 6)) * 6, 256 - h + 5 + Math.floor(r() * (h / 9)) * 9, 3, 4);
    }
  }
  for (let i = 0; i < 24; i++) {
    const x = r() * 256;
    const y = 120 + r() * 136;
    const rad = 3 + r() * 8;
    const gg = g.createRadialGradient(x, y, 0, x, y, rad);
    gg.addColorStop(0, r() > 0.5 ? 'rgba(255,190,120,0.35)' : 'rgba(140,180,255,0.3)');
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gg;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return finish(c);
}
export function rainTexture() {
  const [c, g] = makeCanvas(128, 256);
  const r = mulberry(3);
  g.clearRect(0, 0, 128, 256);
  for (let i = 0; i < 46; i++) {
    const x = r() * 128;
    const y = r() * 256;
    const l = 10 + r() * 34;
    const gr = g.createLinearGradient(0, y, 0, y + l);
    gr.addColorStop(0, 'rgba(200,220,255,0)');
    gr.addColorStop(1, 'rgba(200,220,255,0.5)');
    g.fillStyle = gr;
    g.fillRect(x, y, 1.2, l);
    g.fillStyle = 'rgba(220,235,255,0.6)';
    g.fillRect(x - 0.6, y + l, 2.4, 2.4);
  }
  return finish(c, true);
}
export function noteTexture(lines: string[], bg = '#f2dc6b') {
  const [c, g] = makeCanvas(128, 128);
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(0,0,0,0.08)';
  g.fillRect(0, 0, 128, 14);
  g.fillStyle = '#2b2620';
  g.font = `bold 20px ${JP_FONT}`;
  lines.forEach((l, i) => g.fillText(l, 9, 44 + i * 28));
  return finish(c);
}
const ERROR_LINES = [
  '*** STOP: 0x0000007B (0xF78D2524, 0xC0000034, 0x00000000)',
  'CRITICAL_PROCESS_DIED',
  'IRQL_NOT_LESS_OR_EQUAL',
  'PAGE_FAULT_IN_NONPAGED_AREA',
  'A problem has been detected and you have been shut down.',
  '問題が発生したため、再起動する必要があります。',
  '0% 完了',
  'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
  'KERNEL_DATA_INPAGE_ERROR  0x0000007A',
  'UNEXPECTED_KERNEL_MODE_TRAP',
  'エラー情報を収集しています。',
  'MEMORY_MANAGEMENT  0x0000001A',
  'YOU.exe は応答していません',
  'physical memory dump ......... :(',
  '0xC000021A  0x00000000  0x00000000',
  'DRIVER_IRQL_NOT_LESS_OR_EQUAL',
  'あなたの情報を収集しています。',
  'INACCESSIBLE_BOOT_DEVICE',
  'beginning dump of physical memory',
  'NO_MORE_SYSTEM_PTES   :(   :(   :(',
];
/** white-on-black tiling error text; used as a mask in world shaders */
export function errorTextTexture() {
  const [c, g] = makeCanvas(1024, 1024);
  const r = mulberry(1234);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 1024, 1024);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  let y = 16;
  let i = 0;
  while (y < 1010) {
    const big = r() > 0.86;
    const size = big ? 46 : 19;
    const h = big ? 64 : 32;
    if (y + h > 1024) break;
    if (r() > 0.2) {
      g.font = `${big ? 300 : 400} ${size}px ${big ? JP_FONT : MONO_FONT}`;
      const line = ERROR_LINES[(i * 7 + Math.floor(r() * 5)) % ERROR_LINES.length];
      g.globalAlpha = big ? 1 : 0.65 + r() * 0.35;
      g.fillText(big ? line.slice(0, 26) : line, 18 + Math.floor(r() * 5) * 34, y + h / 2, 980);
      if (!big && r() > 0.8) g.fillRect(18, y + h / 2 - 9, 60 + r() * 300, 18);
    }
    y += h;
    i++;
  }
  g.globalAlpha = 1;
  const t = finish(c, true, false);
  t.anisotropy = 8;
  return t;
}
export function dialogTexture() {
  const [c, g] = makeCanvas(512, 320);
  g.fillStyle = '#0a63c8';
  g.fillRect(0, 0, 512, 320);
  g.fillStyle = '#eef5ff';
  g.fillRect(0, 0, 512, 46);
  g.strokeStyle = '#eef5ff';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 314);
  g.fillStyle = '#0a63c8';
  g.font = `bold 24px ${JP_FONT}`;
  g.fillText('エラー', 16, 32);
  g.font = `bold 26px ${MONO_FONT}`;
  g.fillText('×', 474, 33);
  // warning icon
  g.strokeStyle = '#eef5ff';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(84, 96);
  g.lineTo(136, 186);
  g.lineTo(32, 186);
  g.closePath();
  g.stroke();
  g.fillStyle = '#eef5ff';
  g.fillRect(80, 122, 8, 34);
  g.fillRect(80, 164, 8, 9);
  g.font = `26px ${JP_FONT}`;
  g.fillText('問題が発生しました。', 170, 126);
  g.font = `18px ${MONO_FONT}`;
  g.fillText('YOU.exe  0x0000:(', 170, 164);
  g.lineWidth = 4;
  g.strokeRect(196, 236, 120, 46);
  g.font = `bold 24px ${JP_FONT}`;
  g.fillText('OK', 238, 268);
  return finish(c);
}
export function titleBarTexture() {
  const [c, g] = makeCanvas(1024, 160);
  g.fillStyle = '#eef5ff';
  g.fillRect(0, 0, 1024, 160);
  g.fillStyle = '#0a63c8';
  g.font = `bold 84px ${JP_FONT}`;
  g.textBaseline = 'middle';
  g.fillText('応答なし', 40, 86);
  g.font = `bold 90px ${MONO_FONT}`;
  g.fillText('_ □ ×', 700, 80);
  return finish(c);
}
export function qrTexture() {
  const n = 29;
  const [c, g] = makeCanvas(n * 4, n * 4);
  const r = mulberry(99);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, n * 4, n * 4);
  g.fillStyle = '#0a4fa8';
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) if (r() > 0.5) g.fillRect(x * 4, y * 4, 4, 4);
  const finder = (fx: number, fy: number) => {
    g.fillStyle = '#fff';
    g.fillRect(fx * 4, fy * 4, 36, 36);
    g.fillStyle = '#0a4fa8';
    g.fillRect(fx * 4 + 4, fy * 4 + 4, 28, 28);
    g.fillStyle = '#fff';
    g.fillRect(fx * 4 + 8, fy * 4 + 8, 20, 20);
    g.fillStyle = '#0a4fa8';
    g.fillRect(fx * 4 + 12, fy * 4 + 12, 12, 12);
  };
  finder(0, 0);
  finder(n - 9, 0);
  finder(0, n - 9);
  const t = finish(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}