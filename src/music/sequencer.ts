import type { NoteEvent, NoteRole } from "../models/types";
import type { AudioEngine } from "./audio";

/** Sixteenth notes per bar. */
export const STEPS = 16;
export const DRUMS: { role: NoteRole; label: string; note: number }[] = [
  { role: "hat", label: "Hat", note: 42 },
  { role: "snare", label: "Snare", note: 38 },
  { role: "kick", label: "Kick", note: 36 },
];

export const SCALES: Record<string, { label: string; steps: number[] }> = {
  minorPent: { label: "Minor pentatonic", steps: [0, 3, 5, 7, 10] },
  majorPent: { label: "Major pentatonic", steps: [0, 2, 4, 7, 9] },
  major: { label: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: "Natural minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  whole: { label: "Whole tone", steps: [0, 2, 4, 6, 8, 10] },
};

export const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * How likely each sixteenth is to get a hit, per drum (ordered like DRUMS).
 * 1 = always there, 0 = never. Density bends these curves: low density keeps
 * only the strongest steps, high density fills in the weak ones.
 */
export const STYLES: Record<string, { label: string; drums: number[][] }> = {
  broken: {
    label: "Broken beat",
    drums: [
      [0.95, 0.25, 0.7, 0.3, 0.95, 0.25, 0.7, 0.35, 0.95, 0.25, 0.7, 0.3, 0.95, 0.25, 0.7, 0.45],
      [0, 0, 0, 0.08, 1, 0, 0.05, 0.2, 0, 0.1, 0, 0.15, 1, 0.08, 0.12, 0.3],
      [1, 0, 0.15, 0.05, 0.3, 0, 0.2, 0.1, 0.75, 0.05, 0.4, 0.1, 0.2, 0.05, 0.25, 0.15],
    ],
  },
  four: {
    label: "Four on the floor",
    drums: [
      [0.2, 0.3, 0.95, 0.3, 0.2, 0.3, 0.95, 0.35, 0.2, 0.3, 0.95, 0.3, 0.2, 0.3, 0.95, 0.4],
      [0, 0, 0, 0.03, 1, 0, 0, 0.1, 0, 0, 0, 0.08, 1, 0.03, 0.1, 0.2],
      [1, 0, 0, 0.05, 1, 0, 0, 0.1, 1, 0, 0.05, 0.05, 1, 0, 0.1, 0.15],
    ],
  },
  half: {
    label: "Half-time",
    drums: [
      [0.9, 0.4, 0.6, 0.4, 0.9, 0.4, 0.6, 0.45, 0.9, 0.4, 0.6, 0.4, 0.9, 0.4, 0.6, 0.5],
      [0, 0, 0, 0, 0, 0, 0, 0.1, 1, 0, 0, 0.1, 0, 0.15, 0, 0.2],
      [1, 0, 0.1, 0, 0.1, 0, 0.3, 0.1, 0.2, 0, 0.5, 0.1, 0.1, 0, 0.2, 0.1],
    ],
  },
  ambient: {
    label: "Ambient",
    drums: [
      [0.5, 0, 0.2, 0, 0.4, 0, 0.2, 0.05, 0.5, 0, 0.2, 0, 0.4, 0, 0.2, 0.1],
      [0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0.05, 0.6, 0, 0, 0.05],
      [0.9, 0, 0, 0, 0, 0, 0.1, 0, 0.4, 0, 0.05, 0, 0, 0, 0.1, 0],
    ],
  },
};

/** Metric weight of each sixteenth for melody notes: downbeats first, then off-beats. */
const MELODY_WEIGHT = [1, 0.15, 0.45, 0.2, 0.8, 0.15, 0.5, 0.25, 0.9, 0.15, 0.45, 0.2, 0.75, 0.2, 0.55, 0.3];
/** Extra snare and hat weight in the last beat of a fill bar. */
const FILL_WEIGHT = [0.55, 0.7, 0.8, 0.95];

export interface SequencerState {
  tempo: number;
  swing: number;
  scale: string;
  root: number;
  sound: boolean;
  style: string;
  /** 0..1: how many of the possible drum hits play. */
  drumDensity: number;
  /** 0..1: how many of the possible melody notes play. */
  melodyDensity: number;
  /** 0..1: how fast the pattern evolves from bar to bar, and how often it fills. */
  variation: number;
  /** Melody span in scale degrees. */
  range: number;
  /** Freeze the current pattern instead of letting it evolve. */
  hold: boolean;
  seed: number;
}

export function defaultState(): SequencerState {
  return {
    tempo: 112, swing: 0, scale: "minorPent", root: 0, sound: true,
    style: "broken", drumDensity: 0.5, melodyDensity: 0.45, variation: 0.35, range: 8, hold: false,
    seed: 1,
  };
}

/** Keep only fields that match the current state's types (older saves had a step grid). */
export function sanitizeState(saved: unknown): SequencerState {
  const s = defaultState();
  if (!saved || typeof saved !== "object") return s;
  const rec = s as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    if (k in rec && typeof v === typeof rec[k]) rec[k] = v;
  }
  if (!(s.style in STYLES)) s.style = "broken";
  if (!(s.scale in SCALES)) s.scale = "minorPent";
  return s;
}

/** Small seeded PRNG so "New idea" is a seed and a pattern can be recreated. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Chance that a step with weight `w` plays at `density`. 0.5 plays each step
 * with its own weight; lower values thin out to the strongest steps and higher
 * values fill in the gaps. Because each step compares against a fixed random
 * gate, raising the density only ever adds notes to what's already playing.
 */
export function chance(w: number, density: number): number {
  if (density <= 0 || w <= 0) return 0;
  return Math.pow(w, Math.pow(2, (0.5 - density) * 6));
}

/** One bar as the generator would play it right now, for the pattern view. */
export interface BarView {
  drums: { on: boolean; velocity: number }[][];
  /** Melody degree per step, or null for a rest. */
  melody: (number | null)[];
  fill: boolean;
}

/**
 * A generative sequencer. Instead of a grid of switched-on steps it keeps a
 * random "gate" per step and a wandering melody line, and plays every step
 * whose gate is under the chance its style and density give it. Each bar it
 * re-rolls a share of the gates and nudges a few melody notes (Variation), and
 * now and then plays a fill.
 *
 * Scheduling uses the usual Web Audio lookahead pattern: a timer schedules
 * sounds a little ahead on the audio clock, and the matching visual events
 * are queued so the animation loop can hand them to the model when they
 * become audible.
 */
export class Sequencer {
  state: SequencerState;
  playing = false;
  /** Step currently sounding, for the playhead. -1 when stopped. */
  current = -1;
  /** Bumped whenever the pattern changes, so views know to redraw. */
  version = 0;
  private rng: () => number;
  private drumGate: number[][] = [];
  private melodyGate: number[] = [];
  private degree: number[] = [];
  private bar = 0;
  private fillBar = false;
  private fillRequested = false;
  private nextStep = 0;
  private nextTime = 0;
  private startTime = 0;
  private timer: number | undefined;
  private queue: { time: number; step: number; events: NoteEvent[] }[] = [];

  constructor(private audio: AudioEngine, state?: SequencerState) {
    this.state = state ?? defaultState();
    this.rng = mulberry32(this.state.seed);
    this.generate();
  }

  get stepLength(): number {
    return 60 / this.state.tempo / 4;
  }

  /** Start over from a fresh seed. */
  newIdea(): void {
    this.state.seed = Math.floor(Math.random() * 2 ** 31);
    this.rng = mulberry32(this.state.seed);
    this.generate();
  }

  /** Play a fill at the end of the current bar. */
  fill(): void {
    // Too late in this bar for a fill to be heard: play it at the end of the next one.
    if (this.playing && this.nextStep > 0 && this.nextStep <= 12) this.fillBar = true;
    else this.fillRequested = true;
    this.version++;
  }

  get fillPending(): boolean {
    return this.fillRequested || this.fillBar;
  }

  private generate(): void {
    const r = this.rng;
    this.drumGate = DRUMS.map(() => Array.from({ length: STEPS }, r));
    this.melodyGate = Array.from({ length: STEPS }, r);
    // A melody that wanders by small steps and leans on the root on strong beats.
    const half = Math.floor(this.state.range / 2);
    let pos = 0;
    this.degree = [];
    for (let i = 0; i < STEPS; i++) {
      if (MELODY_WEIGHT[i] >= 0.75 && r() < 0.5) pos = this.chordTone(pos);
      else pos += [-2, -1, -1, 0, 1, 1, 2][Math.floor(r() * 7)];
      pos = Math.max(-half, Math.min(half, pos));
      this.degree.push(pos);
    }
    this.version++;
  }

  /** The nearest root or fifth to a degree. */
  private chordTone(d: number): number {
    const len = this.scaleSteps().length;
    const fifth = this.scaleSteps().findIndex((s) => s === 7);
    const tones: number[] = [];
    for (let o = -3; o <= 3; o++) {
      tones.push(o * len);
      if (fifth > 0) tones.push(o * len + fifth);
    }
    return tones.reduce((best, t) => (Math.abs(t - d) < Math.abs(best - d) ? t : best), 0);
  }

  /** Each bar, re-roll some gates and nudge some notes. */
  private evolve(): void {
    this.bar++;
    this.fillBar = this.fillRequested;
    this.fillRequested = false;
    const v = this.state.variation;
    if (!this.fillBar && v > 0.15 && this.bar % 4 === 3 && this.rng() < v) this.fillBar = true;
    if (this.state.hold || v <= 0) {
      this.version++;
      return;
    }
    const r = this.rng;
    const half = Math.floor(this.state.range / 2);
    for (const gates of this.drumGate) {
      for (let i = 0; i < STEPS; i++) if (r() < v * 0.2) gates[i] = r();
    }
    for (let i = 0; i < STEPS; i++) {
      if (r() < v * 0.25) this.melodyGate[i] = r();
      if (r() < v * 0.2) this.degree[i] = Math.max(-half, Math.min(half, this.degree[i] + (r() < 0.5 ? -1 : 1) * (r() < 0.3 ? 2 : 1)));
    }
    this.version++;
  }

  private scaleSteps(): number[] {
    return SCALES[this.state.scale]?.steps ?? SCALES.minorPent.steps;
  }

  /** MIDI note for a melody degree; degree 0 is the root near middle C. */
  degreeNote(d: number): number {
    const steps = this.scaleSteps();
    const octave = Math.floor(d / steps.length);
    const idx = d - octave * steps.length;
    const root = this.state.root > 6 ? this.state.root - 12 : this.state.root;
    return 60 + root + octave * 12 + steps[idx];
  }

  /** Degree clamped to the current range (the range slider can shrink below a stored note). */
  private clampDegree(d: number): number {
    const half = Math.floor(this.state.range / 2);
    return Math.max(-half, Math.min(half, d));
  }

  private drumHit(i: number, step: number, fill: boolean): { on: boolean; velocity: number } {
    const style = STYLES[this.state.style] ?? STYLES.broken;
    let w = style.drums[i][step];
    let density = this.state.drumDensity;
    if (fill && step >= 12 && DRUMS[i].role !== "kick") {
      w = Math.max(w, FILL_WEIGHT[step - 12]);
      density = Math.max(density, 0.6);
    }
    const p = chance(w, density);
    const on = this.drumGate[i][step] < p;
    const velocity = Math.min(1, 0.4 + 0.55 * w + (fill && step >= 12 ? (step - 12) * 0.05 : 0));
    return { on, velocity };
  }

  private melodyOn(step: number, fill: boolean): boolean {
    const density = fill && step >= 12 ? Math.min(1, this.state.melodyDensity + 0.2) : this.state.melodyDensity;
    return this.melodyGate[step] < chance(MELODY_WEIGHT[step], density);
  }

  /** The bar that's playing (or would play next), for drawing. */
  view(): BarView {
    const fill = this.fillBar;
    return {
      drums: DRUMS.map((_, i) => Array.from({ length: STEPS }, (_, s) => this.drumHit(i, s, fill))),
      melody: Array.from({ length: STEPS }, (_, s) => (this.melodyOn(s, fill) ? this.clampDegree(this.degree[s]) : null)),
      fill,
    };
  }

  start(): void {
    if (this.playing) return;
    const ctx = this.audio.ensure();
    this.playing = true;
    this.nextStep = 0;
    this.bar = 0;
    this.nextTime = ctx.currentTime + 0.06;
    this.startTime = this.nextTime;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    this.playing = false;
    this.current = -1;
    this.queue = [];
    window.clearInterval(this.timer);
  }

  /** Musical time in quarter notes, for tempo-synced LFOs. */
  beats(nowSeconds: number): number {
    if (this.playing && this.audio.ctx) return ((this.audio.ctx.currentTime - this.startTime) * this.state.tempo) / 60;
    return (nowSeconds * this.state.tempo) / 60;
  }

  private schedule(): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.playing) return;
    while (this.nextTime < ctx.currentTime + 0.12) {
      const step = this.nextStep;
      if (step === 0 && this.nextTime > this.startTime) this.evolve();
      // Swing delays every second sixteenth.
      const t = this.nextTime + (step % 2 === 1 ? this.state.swing * this.stepLength * 0.5 : 0);
      const events: NoteEvent[] = [];
      DRUMS.forEach((d, i) => {
        const hit = this.drumHit(i, step, this.fillBar);
        if (!hit.on) return;
        events.push({ note: d.note, velocity: hit.velocity, role: d.role, x: 0.5, source: "sequencer" });
        if (this.state.sound) this.audio.hit(d.role, d.note, hit.velocity, t);
      });
      if (this.melodyOn(step, this.fillBar)) {
        const half = Math.max(1, Math.floor(this.state.range / 2));
        const deg = this.clampDegree(this.degree[step]);
        const note = this.degreeNote(deg);
        const velocity = 0.55 + 0.4 * MELODY_WEIGHT[step];
        // Hold the note until the next one (up to a beat) so sparse melodies sing.
        let gap = 1;
        while (gap < 4 && step + gap < STEPS && !this.melodyOn(step + gap, this.fillBar)) gap++;
        events.push({ note, velocity, role: "tone", x: (deg + half) / (2 * half), source: "sequencer" });
        if (this.state.sound) this.audio.hit("tone", note, velocity, t, this.stepLength * gap * 0.95);
      }
      this.queue.push({ time: t, step, events });
      this.nextTime += this.stepLength;
      this.nextStep = (step + 1) % STEPS;
    }
  }

  /** Events that are audible by now. Call once per animation frame. */
  drain(): NoteEvent[] {
    const ctx = this.audio.ctx;
    if (!ctx || this.queue.length === 0) return [];
    const out: NoteEvent[] = [];
    while (this.queue.length && this.queue[0].time <= ctx.currentTime) {
      const q = this.queue.shift()!;
      this.current = q.step;
      out.push(...q.events);
    }
    return out;
  }
}
