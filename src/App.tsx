import { useEffect, useRef, useState } from 'react';
import { Engine, type UIState } from './game/Engine';
const INITIAL: UIState = {
  phase: 'title',
  ready: false,
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
/** keeps the last line on screen while it fades out */
function Fading({ text, className }: { text: string; className: string }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (text) setShown(text);
  }, [text]);
  return (
    <div className={`${className} transition-opacity duration-700 ${text ? 'opacity-100' : 'opacity-0'}`} aria-live="polite">
      {shown}
    </div>
  );
}
function Key({ children }: { children: string }) {
  return (
    <span className="inline-flex min-w-[2.1em] items-center justify-center rounded border border-white/35 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/85">
      {children}
    </span>
  );
}
export default function App() {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [ui, setUi] = useState<UIState>(INITIAL);
  const [error, setError] = useState('');
  const [reduce, setReduce] = useState(false);
  // the game needs a keyboard and a mouse; say so up front on touch-only devices
  const [touchOnly] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
  useEffect(() => {
    if (!host.current) return;
    let e: Engine;
    try {
      e = new Engine(host.current, setUi, () =>
        setError('部屋のデータを読み込めませんでした。通信状況を確認して、ページを再読み込みしてください。')
      );
    } catch (err) {
      console.error(err);
      setError('WebGL を初期化できませんでした。ハードウェアアクセラレーションが有効なブラウザでお試しください。');
      return;
    }
    engine.current = e;
    return () => {
      e.dispose();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    engine.current?.setReduceFlash(reduce);
  }, [reduce]);
  const title = ui.phase === 'title';
  const m = ui.prompt.match(/^\[(.+?)\]\s*(.*)$/);
  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black text-white">
      <div ref={host} className={`absolute inset-0 ${ui.phase === 'monitor' && ui.fallback ? 'cursor-none' : ''}`} />
      {/* cinematic bars: control is taken away only while these are in */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 bg-black transition-[height] duration-1000 ease-out ${ui.cinematic ? 'h-[7vh]' : 'h-0'}`} />
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 bg-black transition-[height] duration-1000 ease-out ${ui.cinematic ? 'h-[7vh]' : 'h-0'}`} />
      {/* crosshair */}
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white transition-all duration-300 ${
          ui.crosshair && !ui.paused ? (ui.prompt ? 'h-2 w-2 opacity-90' : 'h-[3px] w-[3px] opacity-50') : 'h-0 w-0 opacity-0'
        }`}
      />
      {/* interaction prompt */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-[58%] flex justify-center transition-opacity duration-300 ${
          ui.prompt && !ui.paused ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex items-center gap-2 rounded-full bg-black/45 px-4 py-1.5 text-[13px] tracking-[0.18em] text-white/90 backdrop-blur-sm">
          {m ? (
            <>
              <Key>{m[1]}</Key>
              <span>{m[2]}</span>
            </>
          ) : (
            <span>{ui.prompt}</span>
          )}
        </div>
      </div>
      {/* inner voice */}
      <Fading
        text={ui.subtitle}
        className="subtitle pointer-events-none absolute inset-x-0 bottom-[13vh] px-6 text-center text-[clamp(15px,1.5vw,21px)] tracking-[0.22em] text-white/90"
      />
      {/* control hint */}
      <Fading
        text={title || ui.paused ? '' : ui.hint}
        className="pointer-events-none absolute bottom-[3.2vh] left-6 text-[11px] tracking-[0.2em] text-white/45"
      />
      {ui.muted && !title && (
        <div className="pointer-events-none absolute right-6 top-5 text-[11px] tracking-[0.25em] text-white/50">MUTE ― M で解除</div>
      )}
      {/* in-game console (not the browser devtools) */}
      <div
        className={`pointer-events-none absolute bottom-[7.5vh] left-6 w-[min(680px,calc(100vw-3rem))] origin-bottom transition-all duration-200 ${
          ui.consoleOpen ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
        }`}
      >
        <div className="console border border-white/50 bg-[#0063c4]/80 font-mono text-[13px] leading-[1.55] text-white shadow-[0_0_60px_rgba(0,120,215,0.45)] backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-white/40 bg-white px-3 py-1 text-[11px] font-bold tracking-[0.2em] text-[#0058b0]">
            <span>YOU.exe ― コンソール</span>
            <span>_ □ ×</span>
          </div>
          <div className="min-h-[9.5em] px-3 pb-2 pt-2">
            {ui.consoleLines.map((l, i) => (
              <div key={i} className={`whitespace-pre-wrap break-words ${l.startsWith('>') ? 'text-white' : 'text-white/80'}`}>
                {l}
              </div>
            ))}
            <div className="mt-1 flex items-center whitespace-pre">
              <span className="text-white/70">C:\YOU&gt; </span>
              <span>{ui.consoleInput}</span>
              {!ui.consoleBusy && <span className="caret ml-px inline-block h-[1.05em] w-[0.6em] bg-white" />}
            </div>
          </div>
        </div>
      </div>
      {/* pointer lock lost */}
      {ui.paused && !title && (
        <button
          type="button"
          onMouseDown={() => engine.current?.resume()}
          className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[2px]"
        >
          <span className="text-[13px] tracking-[0.5em] text-white/60">一時停止</span>
          <span className="text-lg tracking-[0.35em] text-white">クリックで再開</span>
        </button>
      )}
      {/* title */}
      <div
        className={`absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[3px] transition-opacity duration-[1400ms] ${
          title ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex max-w-[92vw] flex-col items-center text-center">
          <div className="text-[11px] tracking-[0.6em] text-white/50">A SHORT GLITCH HORROR</div>
          <div className="title-face mt-5 text-[clamp(64px,11vw,150px)] font-extralight leading-none text-white">:(</div>
          <h1 className="mt-3 text-[clamp(26px,3.6vw,46px)] font-light tracking-[0.35em] text-white">0% 完了</h1>
          <p className="mt-5 text-[13px] leading-7 tracking-[0.2em] text-white/60">
            午前2時47分。締め切り前夜の自室で、
            <br className="sm:hidden" />
            PCが青く止まる。
          </p>
          {error ? (
            <p className="mt-10 max-w-md text-sm leading-7 text-red-300">{error}</p>
          ) : (
            <button
              type="button"
              disabled={!ui.ready}
              onClick={() => engine.current?.start()}
              className="group mt-10 cursor-pointer border border-white/60 px-10 py-3 text-[14px] tracking-[0.5em] text-white transition-colors duration-300 hover:bg-white hover:text-black disabled:opacity-40"
            >
              {ui.ready ? 'クリックして開始' : '読み込み中…'}
            </button>
          )}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-[11px] tracking-[0.2em] text-white/55">
            <span className="flex items-center gap-2">
              <Key>W</Key>
              <Key>A</Key>
              <Key>S</Key>
              <Key>D</Key> 移動
            </span>
            <span className="flex items-center gap-2">
              <Key>マウス</Key> 視点
            </span>
            <span className="flex items-center gap-2">
              <Key>E</Key> 調べる
            </span>
            <span className="flex items-center gap-2">
              <Key>M</Key> ミュート
            </span>
          </div>
          {touchOnly && (
            <p className="mt-6 border border-white/25 px-4 py-2 text-[11px] leading-6 tracking-[0.18em] text-white/70">
              この作品はキーボードとマウスで操作します。
              <br />
              PCのブラウザでお試しください。
            </p>
          )}
          <div className="mt-7 text-[11px] leading-6 tracking-[0.18em] text-white/40">
            ヘッドホン推奨　・　約5分
            <br />※ 激しい点滅・画面の揺れ・大きな音を含みます
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] tracking-[0.18em] text-white/55 hover:text-white/80">
            <input type="checkbox" checked={reduce} onChange={(e) => setReduce(e.target.checked)} className="h-3.5 w-3.5 accent-[#0078d7]" />
            点滅と揺れを弱める
          </label>
        </div>
      </div>
    </div>
  );
}
