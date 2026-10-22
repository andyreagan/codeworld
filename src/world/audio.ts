import * as THREE from "three";

/**
 * Sound, all synthesized (no audio files): a factory hum that swells with
 * the number of things on the belts, and a sound per event, panned and
 * attenuated by where it happens relative to the camera.
 *
 *   item leaves on a belt     conveyor clack: a filtered tick and a low thump
 *   drone flight (no belt)    propeller buzz
 *   machine starts            mechanical chug, lower for bigger tiers
 *   machine finishes          a bell, pitched up the pentatonic scale by call depth
 *   machine throws            buzzer and crackle
 *   store gauge moves         liquid bloop, up when it fills
 *   request at a station      two-tone chime
 *   file into a hopper        grinding crunch
 *   timer fires               tick-tock
 *   run done                  rising arpeggio, or a falling minor second if it failed
 *
 * Browsers only start audio after a user gesture, so the context is made on
 * the first click or key. Busy runs are thinned: each sound has a minimum
 * gap, and there's a cap on voices at once.
 */

export type Where = THREE.Vector3 | null;

const PENTA = [0, 2, 4, 7, 9];
const MAX_VOICES = 28;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private hum: { gain: GainNode } | null = null;
  private voices = 0;
  private last = new Map<string, number>();
  private vol = 0.7;
  private muted = false;
  /** Pan (-1..1) and level (0..1) for a point in the world; set by the host from the camera. */
  locate: (p: THREE.Vector3) => { pan: number; level: number } = () => ({ pan: 0, level: 1 });

  constructor() {
    try {
      this.muted = localStorage.getItem("codeworld.muted") === "1";
      const v = localStorage.getItem("codeworld.volume");
      if (v !== null) this.vol = Number(v);
    } catch {
      // storage blocked: defaults
    }
    const start = () => this.start();
    addEventListener("pointerdown", start, { once: true });
    addEventListener("keydown", start, { once: true });
  }

  /** "off" until the first gesture, then the AudioContext's state, and how many sounds have played. */
  get state(): string {
    return this.ctx ? `${this.ctx.state}, ${this.played} sounds` : "off";
  }

  private played = 0;

  get volume(): number {
    return this.vol;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setVolume(v: number): void {
    this.vol = v;
    this.applyLevel();
    this.save();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyLevel();
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem("codeworld.muted", this.muted ? "1" : "0");
      localStorage.setItem("codeworld.volume", String(this.vol));
    } catch {
      // not remembered, that's all
    }
  }

  private applyLevel(): void {
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol * 0.6, this.ctx.currentTime, 0.05);
  }

  private start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    this.applyLevel();
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.startHum();
  }

  /** The factory floor: brown-ish noise and two detuned low saws, under a lowpass. Silent until things move. */
  private startHum(): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const ng = ctx.createGain();
    ng.gain.value = 0.5;
    n.connect(ng).connect(lp);
    for (const f of [55, 55.7]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.12;
      o.connect(og).connect(lp);
      o.start();
    }
    // a slow throb, like machinery in step
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 2.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    n.start();
    lp.connect(gain).connect(this.master);
    this.hum = { gain };
  }

  /** How busy the floor is (items moving): the hum follows it. */
  setActivity(moving: number): void {
    if (!this.ctx || !this.hum) return;
    const target = moving === 0 ? 0 : Math.min(0.32, 0.08 + 0.03 * Math.sqrt(moving));
    this.hum.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  /**
   * A voice: `build` wires sources into the given input node and returns
   * when it ends (seconds from now). Skipped if this sound played under
   * `gap` seconds ago, too many voices are going, or it's inaudible.
   */
  private voice(name: string, gap: number, at: Where, gain: number, build: (out: AudioNode, t: number) => number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== "running" || this.voices >= MAX_VOICES) return;
    const t = ctx.currentTime;
    if (t - (this.last.get(name) ?? -1) < gap) return;
    const { pan, level } = at ? this.locate(at) : { pan: 0, level: 1 };
    if (level * gain < 0.01) return;
    this.last.set(name, t);
    const g = ctx.createGain();
    g.gain.value = level * gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.master);
    const end = build(g, t);
    this.voices++;
    this.played++;
    setTimeout(() => {
      this.voices--;
      g.disconnect();
      p.disconnect();
    }, (end + 0.1) * 1000);
  }

  private osc(out: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, attack = 0.005): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(peak, t + attack);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(e).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private hiss(out: AudioNode, type: BiquadFilterType, f0: number, f1: number, q: number, t: number, dur: number, peak: number): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(e).connect(out);
    n.start(t, Math.random());
    n.stop(t + dur + 0.02);
  }

  depart(at: Where): void {
    this.voice("depart", 0.05, at, 0.5, (out, t) => {
      this.hiss(out, "bandpass", 2200, 1600, 5, t, 0.035, 0.9);
      this.osc(out, "sine", 110, 55, t, 0.08, 0.7);
      return 0.1;
    });
  }

  drone(at: Where): void {
    this.voice("drone", 0.25, at, 0.35, (out, t) => {
      const ctx = this.ctx!;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(170, t);
      o.frequency.linearRampToValueAtTime(210, t + 0.35);
      o.frequency.linearRampToValueAtTime(160, t + 0.7);
      const trem = ctx.createGain();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 34;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(trem.gain);
      const lp = ctx.createBiquadFilter();
      lp.frequency.value = 900;
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(0.4, t + 0.08);
      e.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(trem).connect(lp).connect(e).connect(out);
      o.start(t);
      lfo.start(t);
      o.stop(t + 0.72);
      lfo.stop(t + 0.72);
      return 0.75;
    });
  }

  machineStart(tier: 1 | 2 | 3, at: Where): void {
    const f = [0, 98, 82, 65][tier]!;
    this.voice(`start${tier}`, 0.06, at, 0.55, (out, t) => {
      for (let i = 0; i < 3; i++) {
        this.hiss(out, "bandpass", 650 - i * 80, 420, 3, t + i * 0.055, 0.05, 0.6);
        this.osc(out, "square", f, f * 0.94, t + i * 0.055, 0.06, 0.18);
      }
      return 0.25;
    });
  }

  machineDone(depth: number, at: Where): void {
    const d = Math.min(depth, 9);
    const f = 523.25 * 2 ** ((PENTA[d % 5]! + 12 * Math.floor(d / 5)) / 12);
    this.voice(`done${d}`, 0.04, at, 0.22, (out, t) => {
      this.osc(out, "sine", f, f, t, 0.35, 0.6, 0.003);
      this.osc(out, "sine", f * 2.76, f * 2.76, t, 0.12, 0.12, 0.002); // the bell's clang
      return 0.4;
    });
  }

  error(at: Where): void {
    this.voice("error", 0.15, at, 0.55, (out, t) => {
      this.osc(out, "sawtooth", 110, 98, t, 0.4, 0.5, 0.01);
      this.osc(out, "square", 116, 104, t, 0.4, 0.25, 0.01);
      for (let i = 0; i < 6; i++) this.hiss(out, "highpass", 3000, 3000, 0.7, t + Math.random() * 0.3, 0.02, 0.5);
      return 0.45;
    });
  }

  gauge(up: boolean, at: Where): void {
    this.voice("gauge", 0.08, at, 0.35, (out, t) => {
      this.osc(out, "sine", up ? 280 : 620, up ? 620 : 280, t, 0.14, 0.6, 0.01);
      return 0.16;
    });
  }

  dock(kind: "route" | "inbox" | "cron", at: Where): void {
    this.voice(`dock-${kind}`, 0.2, at, 0.5, (out, t) => {
      if (kind === "route") {
        this.osc(out, "triangle", 659.25, 659.25, t, 0.25, 0.5);
        this.osc(out, "triangle", 830.6, 830.6, t + 0.12, 0.35, 0.5);
        return 0.5;
      }
      if (kind === "inbox") {
        this.hiss(out, "lowpass", 3500, 250, 1.5, t, 0.45, 0.9);
        for (let i = 0; i < 8; i++) this.osc(out, "square", 60 + Math.random() * 40, 50, t + i * 0.05, 0.03, 0.15);
        return 0.5;
      }
      this.hiss(out, "bandpass", 3200, 3200, 8, t, 0.03, 1);
      this.hiss(out, "bandpass", 2100, 2100, 8, t + 0.28, 0.03, 1);
      return 0.35;
    });
  }

  runDone(ok: boolean, at: Where): void {
    this.voice("run", 0.1, at, 0.4, (out, t) => {
      const notes = ok ? [523.25, 659.25, 783.99, 1046.5] : [392, 370];
      notes.forEach((f, i) => this.osc(out, ok ? "triangle" : "sawtooth", f, f, t + i * 0.07, ok ? 0.3 : 0.35, ok ? 0.4 : 0.25));
      return notes.length * 0.07 + 0.35;
    });
  }

  click(): void {
    this.voice("click", 0.03, null, 0.3, (out, t) => {
      this.hiss(out, "bandpass", 4000, 4000, 4, t, 0.015, 0.8);
      return 0.03;
    });
  }
}
