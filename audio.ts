import { clamp } from './utils';
/**
 * Fully procedural audio (no samples). Everything is synthesised with WebAudio
 * so the whole piece stays tiny and starts instantly.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private pre!: GainNode;
  private muffle!: BiquadFilterNode;
  private master!: GainNode;
  private revSend!: GainNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private crushed: AudioBuffer[] = [];
  private roomBus!: GainNode;
  private fanGain!: GainNode;
  private fanPan!: StereoPannerNode;
  private whineGain!: GainNode;
  private growlGain!: GainNode;
  private growlFilter!: BiquadFilterNode;
  private worldBus!: GainNode;
  private padOscs: OscillatorNode[] = [];
  private padGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private corruption = 0;
  private worldLevel = 0;
  private beatTimer = 0;
  private sparkTimer = 4;
  private roomEventTimer = 14;
  private roomLevel = 0;
  muted = false;
  init() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    void ctx.resume();
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 19000;
    this.pre = ctx.createGain();
    this.pre.connect(this.muffle).connect(comp).connect(this.master).connect(ctx.destination);
    // buffers
    const sr = ctx.sampleRate;
    this.white = ctx.createBuffer(1, sr * 2, sr);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, sr * 3, sr);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < b.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }
    for (let k = 0; k < 3; k++) {
      const buf = ctx.createBuffer(1, Math.floor(sr * 0.3), sr);
      const d = buf.getChannelData(0);
      let v = 0;
      let hold = 0;
      for (let i = 0; i < d.length; i++) {
        if (hold-- <= 0) {
          v = Math.random() * 2 - 1;
          hold = 2 + Math.floor(Math.random() * (10 + k * 40));
        }
        d[i] = v;
      }
      this.crushed.push(buf);
    }
    // reverb
    const ir = ctx.createBuffer(2, Math.floor(sr * 3.2), sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const t = i / d.length;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 400 ? i / 400 : 1);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 1;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.55;
    this.revSend.connect(conv).connect(revOut).connect(this.pre);
    this.buildRoom(ctx);
    this.buildGrowl(ctx);
    this.buildWorld(ctx);
    this.buildWind(ctx);
  }
  private loop(buf: AudioBuffer, rate = 1) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, Math.random() * buf.duration);
    return s;
  }
  private filter(type: BiquadFilterType, freq: number, q = 0.7) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }
  private gain(v: number) {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    return g;
  }
  private buildRoom(ctx: AudioContext) {
    this.roomBus = this.gain(0);
    this.roomBus.connect(this.pre);
    // room tone
    this.loop(this.brown).connect(this.filter('lowpass', 170)).connect(this.gain(0.42)).connect(this.roomBus);
    // PC fan
    this.fanGain = this.gain(0.05);
    this.fanPan = ctx.createStereoPanner();
    this.fanGain.connect(this.fanPan).connect(this.roomBus);
    this.loop(this.white, 0.8).connect(this.filter('bandpass', 640, 0.8)).connect(this.fanGain);
    for (const [f, g] of [
      [118, 0.16],
      [236, 0.05],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(this.gain(g)).connect(this.fanGain);
      o.start();
    }
    // rain against the window
    const rain = this.gain(0.03);
    this.loop(this.white, 1.1).connect(this.filter('highpass', 2200)).connect(this.filter('lowpass', 7500)).connect(rain);
    rain.connect(this.roomBus);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    lfo.connect(this.gain(0.012)).connect(rain.gain);
    lfo.start();
    // coil whine (only after the crash)
    this.whineGain = this.gain(0);
    const wh = ctx.createOscillator();
    wh.frequency.value = 9100;
    wh.connect(this.whineGain).connect(this.roomBus);
    wh.start();
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 50;
    hum.connect(this.filter('lowpass', 160)).connect(this.gain(4)).connect(this.whineGain);
    hum.start();
  }
  private buildGrowl(ctx: AudioContext) {
    this.growlGain = this.gain(0);
    this.growlFilter = this.filter('lowpass', 90, 4);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) curve[i] = Math.tanh(((i / 511) * 2 - 1) * 3.2);
    shaper.curve = curve;
    this.growlFilter.connect(shaper).connect(this.growlGain);
    this.growlGain.connect(this.pre);
    this.growlGain.connect(this.revSend);
    for (const [f, type] of [
      [41, 'sawtooth'],
      [41.9, 'sawtooth'],
      [82.6, 'square'],
      [123.1, 'sawtooth'],
    ] as [number, OscillatorType][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(this.gain(0.3)).connect(this.growlFilter);
      o.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.3;
    lfo.connect(this.gain(40)).connect(this.growlFilter.frequency);
    lfo.start();
  }
  private buildWorld(ctx: AudioContext) {
    this.worldBus = this.gain(0);
    this.worldBus.connect(this.pre);
    const send = this.gain(0.8);
    this.worldBus.connect(send).connect(this.revSend);
    this.padGain = this.gain(1);
    const lp = this.filter('lowpass', 950, 0.5);
    lp.connect(this.padGain).connect(this.worldBus);
    const notes = [73.42, 110, 174.61, 261.63, 329.63, 440];
    notes.forEach((f, i) => {
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.type = k === 0 ? 'sine' : 'triangle';
        o.frequency.value = f * (k === 0 ? 1 : 1.004);
        const g = this.gain(0.035 / (1 + i * 0.25));
        const l = ctx.createOscillator();
        l.frequency.value = 0.05 + i * 0.021 + k * 0.013;
        l.connect(this.gain(0.02 / (1 + i * 0.25))).connect(g.gain);
        l.start();
        o.connect(g).connect(lp);
        o.start();
        this.padOscs.push(o);
      }
    });
    this.loop(this.brown, 0.7).connect(this.filter('bandpass', 380, 0.6)).connect(this.gain(0.07)).connect(this.worldBus);
  }
  private buildWind(ctx: AudioContext) {
    this.windGain = this.gain(0);
    this.windFilter = this.filter('bandpass', 500, 0.9);
    this.loop(this.white).connect(this.windFilter).connect(this.windGain).connect(this.pre);
    const l = ctx.createOscillator();
    l.frequency.value = 0.9;
    l.connect(this.gain(120)).connect(this.windFilter.frequency);
    l.start();
    this.rumbleGain = this.gain(0);
    this.loop(this.brown, 0.5).connect(this.filter('lowpass', 95)).connect(this.rumbleGain).connect(this.pre);
  }
  // ---------- generic one-shots ----------
  private tone(
    freq: number,
    dur: number,
    vol: number,
    opts: { type?: OscillatorType; to?: number; attack?: number; pan?: number; rev?: number; when?: number } = {}
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (opts.when ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t + dur);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
    let out: AudioNode = g;
    if (opts.pan !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(opts.pan, -1, 1);
      g.connect(p);
      out = p;
    }
    o.connect(g);
    out.connect(this.pre);
    if (opts.rev) {
      const s = ctx.createGain();
      s.gain.value = opts.rev;
      out.connect(s).connect(this.revSend);
    }
    o.start(t);
    o.stop(t + a + dur + 0.05);
  }
  private burst(
    dur: number,
    vol: number,
    opts: {
      type?: BiquadFilterType;
      freq?: number;
      to?: number;
      q?: number;
      attack?: number;
      pan?: number;
      rev?: number;
      when?: number;
      buf?: AudioBuffer;
      rate?: number;
    } = {}
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (opts.when ?? 0);
    const s = ctx.createBufferSource();
    s.buffer = opts.buf ?? this.white;
    s.loop = true;
    s.playbackRate.value = opts.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'lowpass';
    f.frequency.setValueAtTime(opts.freq ?? 1000, t);
    if (opts.to) f.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + dur);
    f.Q.value = opts.q ?? 0.7;
    const g = ctx.createGain();
    const a = opts.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
    let out: AudioNode = g;
    s.connect(f).connect(g);
    if (opts.pan !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(opts.pan, -1, 1);
      g.connect(p);
      out = p;
    }
    out.connect(this.pre);
    if (opts.rev) {
      const sg = ctx.createGain();
      sg.gain.value = opts.rev;
      out.connect(sg).connect(this.revSend);
    }
    s.start(t, Math.random() * 1.5);
    s.stop(t + a + dur + 0.05);
  }
  private ramp(p: AudioParam, v: number, tc = 0.1) {
    if (!this.ctx) return;
    p.setTargetAtTime(v, this.ctx.currentTime, tc);
  }
  // ---------- per-frame ----------
  update(dt: number) {
    if (!this.ctx) return;
    if (this.corruption > 0.12) {
      this.beatTimer -= dt;
      if (this.beatTimer <= 0) {
        const c = this.corruption;
        this.beatTimer = 1.15 - c * 0.8;
        this.tone(62, 0.16, 0.35 + c * 0.4, { to: 34 });
        this.tone(56, 0.14, 0.25 + c * 0.3, { to: 30, when: 0.14 - c * 0.04 });
      }
    }
    if (this.worldLevel > 0.5) {
      this.sparkTimer -= dt;
      if (this.sparkTimer <= 0) {
        this.sparkTimer = 2.5 + Math.random() * 6;
        const notes = [587.3, 659.3, 880, 987.8, 1174.7, 1318.5];
        const f = notes[Math.floor(Math.random() * notes.length)];
        this.tone(f, 2.2, 0.018, { rev: 1.2, pan: Math.random() * 1.6 - 0.8, attack: 0.02 });
        if (Math.random() > 0.6) this.tone(f * 1.5, 1.6, 0.01, { rev: 1.2, when: 0.25, pan: Math.random() * 1.6 - 0.8 });
      }
    }
    if (this.roomLevel > 0.5 && this.corruption < 0.05) {
      this.roomEventTimer -= dt;
      if (this.roomEventTimer <= 0) {
        this.roomEventTimer = 16 + Math.random() * 22;
        if (Math.random() > 0.5) {
          // distant car on wet asphalt
          this.burst(3.2, 0.035, { type: 'bandpass', freq: 300, to: 900, q: 0.6, attack: 1.4, pan: -0.7 });
        } else {
          // the house settling
          this.tone(190, 0.18, 0.02, { type: 'triangle', to: 150, pan: 0.5, rev: 0.4 });
          this.burst(0.06, 0.03, { type: 'bandpass', freq: 900, q: 6, pan: 0.5, when: 0.05 });
        }
      }
    }
  }
  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.ramp(this.master.gain, m ? 0 : 0.9, 0.05);
  }
  // ---------- room ----------
  setRoom(level: number, tc = 0.4) {
    this.roomLevel = level;
    if (this.ctx) this.ramp(this.roomBus.gain, level, tc);
  }
  setFan(pan: number, level: number) {
    if (!this.ctx) return;
    this.ramp(this.fanPan.pan, clamp(pan, -1, 1), 0.08);
    this.ramp(this.fanGain.gain, level, 0.1);
  }
  tick(pan: number, level: number, alt: boolean) {
    this.burst(0.018, 0.09 * level, { type: 'bandpass', freq: alt ? 2100 : 2700, q: 5, pan });
  }
  step(kind: 'room' | 'world', level = 1) {
    if (kind === 'room') {
      this.burst(0.07, 0.3 * level, { type: 'lowpass', freq: 200 + Math.random() * 60, buf: this.brown, rate: 1.5 });
      this.burst(0.012, 0.012 * level, { type: 'highpass', freq: 3000 });
    } else {
      const f = 1300 + Math.random() * 700;
      this.tone(f, 0.09, 0.02 * level, { rev: 0.9, type: 'triangle' });
      this.burst(0.025, 0.035 * level, { type: 'highpass', freq: 4000, rev: 0.5 });
      this.burst(0.06, 0.12 * level, { type: 'lowpass', freq: 160, buf: this.brown, rate: 1.4 });
    }
  }
  mouseClick() {
    this.burst(0.007, 0.07, { type: 'highpass', freq: 2600 });
    this.burst(0.006, 0.05, { type: 'highpass', freq: 3200, when: 0.07 });
    this.tone(180, 0.02, 0.03);
  }
  chairCreak() {
    this.tone(240, 0.22, 0.018, { type: 'sawtooth', to: 170 });
    this.burst(0.2, 0.05, { type: 'lowpass', freq: 300, buf: this.brown, rate: 2 });
  }
  freezeStutter() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 233;
    const g = ctx.createGain();
    g.gain.value = 0;
    for (let i = 0; i < 16; i++) {
      g.gain.setValueAtTime(i % 2 === 0 ? 0.07 : 0.0, t + i * 0.033);
    }
    g.gain.setValueAtTime(0, t + 0.55);
    o.connect(this.filter('lowpass', 1800)).connect(g).connect(this.pre);
    o.start(t);
    o.stop(t + 0.6);
  }
  bsodCrash() {
    if (!this.ctx) return;
    this.burst(0.03, 0.2, { type: 'highpass', freq: 1500 });
    this.tone(70, 0.5, 0.4, { to: 38 });
    this.ramp(this.whineGain.gain, 0.0022, 0.3);
  }
  resetWhine() {
    if (this.ctx) this.ramp(this.whineGain.gain, 0, 0.2);
  }
  pop() {
    this.burst(0.012, 0.35, { type: 'highpass', freq: 1800, rev: 0.4 });
    this.tone(1900, 0.2, 0.05, { to: 300, rev: 0.5 });
  }
  // ---------- corruption ----------
  glitch(intensity: number) {
    if (!this.ctx) return;
    const k = clamp(intensity);
    const buf = this.crushed[Math.floor(Math.random() * this.crushed.length)];
    this.burst(0.05 + k * 0.22, 0.07 + k * 0.2, {
      type: 'bandpass',
      freq: 400 + Math.random() * 2600,
      q: 1.2,
      buf,
      rate: 0.5 + Math.random() * 1.6,
      pan: Math.random() * 1.2 - 0.6,
      rev: k * 0.5,
    });
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.03 + k * 0.04, t);
    const n = 3 + Math.floor(k * 8);
    for (let i = 0; i < n; i++) o.frequency.setValueAtTime(120 + Math.random() * 2800 * (0.4 + k), t + i * 0.022);
    g.gain.setValueAtTime(0, t + n * 0.022);
    o.connect(g).connect(this.pre);
    o.start(t);
    o.stop(t + n * 0.022 + 0.02);
    if (k > 0.35) this.tone(95, 0.35, 0.4 * k, { to: 32 });
  }
  setCorruption(c: number) {
    this.corruption = c;
    if (!this.ctx) return;
    this.ramp(this.growlGain.gain, c * c * 0.3, 0.15);
    this.ramp(this.growlFilter.frequency, 80 + c * 620, 0.15);
  }
  // ---------- devour ----------
  devourRoar() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 2.75;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.34, t + 0.12);
    out.gain.linearRampToValueAtTime(0.22, t + 0.9);
    out.gain.linearRampToValueAtTime(0.5, t + dur - 0.1);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    out.connect(this.pre);
    out.connect(this.revSend);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = Math.tanh(((i / 255) * 2 - 1) * 5);
    shaper.curve = curve;
    shaper.connect(out);
    const f1 = this.filter('bandpass', 620, 4);
    const f2 = this.filter('bandpass', 1150, 5);
    f1.frequency.exponentialRampToValueAtTime(980, t + dur);
    f2.frequency.exponentialRampToValueAtTime(2600, t + dur);
    f1.connect(shaper);
    f2.connect(shaper);
    for (const f of [98, 147.5, 207.6, 311.9, 52]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.7, t + dur);
      const vib = ctx.createOscillator();
      vib.frequency.value = 9 + Math.random() * 6;
      vib.connect(this.gain(f * 0.05)).connect(o.frequency);
      vib.start(t);
      vib.stop(t + dur + 0.4);
      o.connect(f1);
      o.connect(f2);
      o.start(t);
      o.stop(t + dur + 0.4);
    }
    // riser + sub
    this.burst(dur, 0.3, { type: 'bandpass', freq: 240, to: 5200, q: 2.2, attack: dur * 0.9, rev: 0.3 });
    this.tone(64, dur, 0.55, { to: 27, attack: 0.3 });
  }
  bite() {
    for (let i = 0; i < 6; i++) {
      this.burst(0.04, 0.6, { type: 'lowpass', freq: 1400 - i * 150, when: i * 0.024, buf: this.crushed[0], rate: 0.6 });
    }
    this.burst(0.02, 0.5, { type: 'highpass', freq: 3000 });
    this.tone(74, 1.1, 1.0, { to: 22 });
    this.burst(0.7, 0.5, { type: 'lowpass', freq: 240, buf: this.brown, rate: 1.2, rev: 0.6 });
  }
  setWind(level: number, pitch: number) {
    if (!this.ctx) return;
    this.ramp(this.windGain.gain, level * 0.55, 0.08);
    this.ramp(this.windFilter.frequency, 280 + pitch * 2300, 0.1);
  }
  emerge() {
    this.burst(1.1, 0.22, { type: 'lowpass', freq: 7000, to: 180, rev: 1 });
    this.tone(146.8, 5, 0.06, { attack: 0.8, rev: 1 });
    this.tone(220, 5, 0.045, { attack: 1.2, rev: 1 });
    this.tone(659.3, 4, 0.02, { attack: 1.6, rev: 1.2 });
  }
  // ---------- world ----------
  setWorld(level: number, tc = 1.2) {
    this.worldLevel = level;
    if (this.ctx) this.ramp(this.worldBus.gain, level, tc);
  }
  anomaly(strength = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.glitch(0.45 * strength);
    for (const o of this.padOscs) {
      o.detune.cancelScheduledValues(t);
      o.detune.setValueAtTime(0, t);
      o.detune.linearRampToValueAtTime(-320 * strength, t + 0.25);
      o.detune.setTargetAtTime(0, t + 0.6 + strength * 0.5, 0.5);
    }
    const g = this.padGain.gain;
    g.cancelScheduledValues(t);
    for (let i = 0; i < 12; i++) g.setValueAtTime(i % 2 === 0 ? 1 : 0.1, t + i * 0.035);
    g.setValueAtTime(0.25, t + 0.42);
    g.linearRampToValueAtTime(1, t + 2.6);
  }
  reveal() {
    const chord = [146.83, 220, 293.66, 369.99, 440, 587.33, 880];
    chord.forEach((f, i) => this.tone(f, 7, 0.045 / (1 + i * 0.2), { attack: 1.4 + i * 0.15, rev: 1.3 }));
    this.tone(73.42, 6, 0.28, { attack: 0.02, rev: 0.8 });
    this.tone(1174.7, 3, 0.02, { when: 1.4, rev: 1.5 });
  }
  // ---------- console ----------
  key() {
    this.tone(900 + Math.random() * 500, 0.012, 0.02, { type: 'square' });
  }
  consoleOpen(open: boolean) {
    this.tone(open ? 660 : 990, 0.05, 0.03, { type: 'square' });
    this.tone(open ? 990 : 660, 0.07, 0.03, { type: 'square', when: 0.06 });
  }
  error() {
    this.tone(138, 0.28, 0.08, { type: 'square' });
    this.tone(131, 0.28, 0.06, { type: 'square' });
    this.glitch(0.25);
  }
  accept() {
    [440, 554.4, 659.3, 880, 1318.5].forEach((f, i) =>
      this.tone(f, 0.5, 0.04, { type: 'triangle', when: i * 0.07, rev: 0.8 })
    );
  }
  // ---------- collapse / fall ----------
  boom(vol: number) {
    this.tone(58, 1.8, vol, { to: 21 });
    this.burst(1.2, vol * 0.8, { type: 'lowpass', freq: 130, buf: this.brown, rate: 0.8, rev: 0.7 });
  }
  crack(pan: number, vol: number) {
    this.burst(0.03, vol, { type: 'highpass', freq: 1700, pan, rev: 0.9 });
    this.burst(0.14, vol * 0.8, { type: 'bandpass', freq: 520, q: 2.5, pan, rev: 0.9, buf: this.crushed[1], rate: 0.7 });
    this.tone(210, 0.3, vol * 0.5, { to: 48, pan });
  }
  setRumble(level: number) {
    if (this.ctx) this.ramp(this.rumbleGain.gain, level * 1.1, 0.25);
  }
  shatter() {
    for (let i = 0; i < 26; i++) {
      this.tone(1500 + Math.random() * 5200, 0.08 + Math.random() * 0.3, 0.05, {
        when: Math.random() * 0.6,
        pan: Math.random() * 2 - 1,
        rev: 0.9,
        type: 'triangle',
      });
    }
    this.burst(0.55, 0.35, { type: 'highpass', freq: 2400, rev: 0.6 });
    this.boom(0.9);
  }
  fallTone(dur: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.07, t + 1.2);
    out.gain.setValueAtTime(0.07, t + dur - 0.6);
    out.gain.linearRampToValueAtTime(0.0001, t + dur);
    const lp = this.filter('lowpass', 1500);
    lp.connect(out);
    out.connect(this.pre);
    out.connect(this.revSend);
    for (const f of [220, 277.2, 329.6, 466.2, 110]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.22, t + dur);
      o.connect(this.gain(0.4)).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }
  impact() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(84, 0.55, 1.2, { to: 26 });
    this.burst(0.28, 0.9, { type: 'lowpass', freq: 320, buf: this.brown, rate: 1.6 });
    this.burst(0.03, 0.4, { type: 'highpass', freq: 1200 });
    // tinnitus
    this.tone(6100, 5.5, 0.016, { attack: 0.15 });
    this.tone(6170, 4.5, 0.008, { attack: 0.3 });
    // muffled hearing that slowly opens up
    const f = this.muffle.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(19000, t);
    f.setValueAtTime(260, t + 0.08);
    f.exponentialRampToValueAtTime(900, t + 3);
    f.exponentialRampToValueAtTime(19000, t + 6.5);
  }
  unmuffle() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.muffle.frequency.cancelScheduledValues(ctx.currentTime);
    this.muffle.frequency.setValueAtTime(19000, ctx.currentTime);
  }
  dispose() {
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
  }
}