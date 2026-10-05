import type { NoteEvent, NoteRole } from "../models/types";
import type { AudioEngine } from "./audio";

export const STEPS = 16;
export const TONE_ROWS = 8;
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

export interface SequencerState {
  tempo: number;
  swing: number;
  scale: string;
  root: number;
  /** tones[row][step], row 0 = lowest pitch */
  tones: boolean[][];
  /** drums[i][step], indexed like DRUMS */
  drums: boolean[][];
  sound: boolean;
}

function grid(rows: number): boolean[][] {
  return Array.from({ length: rows }, () => new Array<boolean>(STEPS).fill(false));
}

export function defaultPattern(): SequencerState {
  const s: SequencerState = {
    tempo: 112, swing: 0, scale: "minorPent", root: 0,
    tones: grid(TONE_ROWS), drums: grid(DRUMS.length), sound: true,
  };
  for (let i = 0; i < STEPS; i++) {
    if (i % 4 === 0) s.drums[2][i] = true;
    if (i % 8 === 4) s.drums[1][i] = true;
    if (i % 2 === 0) s.drums[0][i] = true;
  }
  s.drums[2][10] = true;
  // A rising-and-falling arpeggio.
  [0, 2, 4, 2, 5, 4, 7, 4, 0, 3, 5, 3, 6, 5, 7, 6].forEach((row, i) => {
    if (i % 2 === 0 || i > 11) s.tones[row][i] = true;
  });
  return s;
}

/**
 * A 16-step sequencer: three drum rows and eight scale-locked tone rows.
 * Uses the usual Web Audio lookahead pattern: a timer schedules sounds a
 * little ahead on the audio clock, and the matching visual events are queued
 * so the animation loop can hand them to the model when they become audible.
 */
export class Sequencer {
  state: SequencerState;
  playing = false;
  /** Step currently sounding, for the playhead. -1 when stopped. */
  current = -1;
  private nextStep = 0;
  private nextTime = 0;
  private startTime = 0;
  private timer: number | undefined;
  private queue: { time: number; step: number; events: NoteEvent[] }[] = [];

  constructor(private audio: AudioEngine, state?: SequencerState) {
    this.state = state ?? defaultPattern();
  }

  get stepLength(): number {
    return 60 / this.state.tempo / 4;
  }

  /** MIDI note for a tone row, two octaves up from the root at C3. */
  rowNote(row: number): number {
    const steps = SCALES[this.state.scale]?.steps ?? SCALES.minorPent.steps;
    const octave = Math.floor(row / steps.length);
    return 48 + this.state.root + octave * 12 + steps[row % steps.length];
  }

  start(): void {
    if (this.playing) return;
    const ctx = this.audio.ensure();
    this.playing = true;
    this.nextStep = 0;
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
      // Swing delays every second sixteenth.
      const t = this.nextTime + (step % 2 === 1 ? this.state.swing * this.stepLength * 0.5 : 0);
      const events: NoteEvent[] = [];
      DRUMS.forEach((d, i) => {
        if (!this.state.drums[i][step]) return;
        const velocity = d.role === "hat" && step % 4 !== 0 ? 0.6 : 0.95;
        events.push({ note: d.note, velocity, role: d.role, x: 0.5, source: "sequencer" });
        if (this.state.sound) this.audio.hit(d.role, d.note, velocity, t);
      });
      for (let row = 0; row < TONE_ROWS; row++) {
        if (!this.state.tones[row][step]) continue;
        const note = this.rowNote(row);
        const velocity = step % 4 === 0 ? 0.9 : 0.7;
        events.push({ note, velocity, role: "tone", x: row / (TONE_ROWS - 1), source: "sequencer" });
        if (this.state.sound) this.audio.hit("tone", note, velocity, t, this.stepLength * 1.6);
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

  clear(): void {
    this.state.tones = grid(TONE_ROWS);
    this.state.drums = grid(DRUMS.length);
  }

  randomize(): void {
    this.clear();
    for (let i = 0; i < STEPS; i++) {
      if (i % 4 === 0 || Math.random() < 0.12) this.state.drums[2][i] = true;
      if (i % 8 === 4 || (i % 2 === 1 && Math.random() < 0.08)) this.state.drums[1][i] = true;
      if (Math.random() < 0.6) this.state.drums[0][i] = true;
      if (Math.random() < 0.45) this.state.tones[Math.floor(Math.random() * TONE_ROWS)][i] = true;
    }
  }
}
