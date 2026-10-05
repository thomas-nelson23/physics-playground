import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";

const POINTS = 96;

interface HarpString {
  y: Float32Array;
  prev: Float32Array;
  next: Float32Array;
  /** Courant number squared: higher strings carry waves faster, so vibrate faster. */
  c2: number;
  hue: number;
  glow: number;
}

/**
 * A harp of vibrating strings, each solving the 1D wave equation with fixed
 * ends. Notes pluck the string matching their pitch, and you can strum
 * across them with the mouse. Plucks travel as kinks that bounce between
 * the ends, settling into the string's standing-wave modes.
 */
class HarpSim implements SimulationModel {
  private strings: HarpString[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private last: { x: number; y: number } | null = null;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const n = p.strings as number;
    this.strings = Array.from({ length: n }, (_, i) => ({
      y: new Float32Array(POINTS),
      prev: new Float32Array(POINTS),
      next: new Float32Array(POINTS),
      c2: 0.12 + 0.8 * (n === 1 ? 0.5 : i / (n - 1)),
      hue: 200 + (i / Math.max(1, n - 1)) * 140,
      glow: 0,
    }));
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  /** Where string i sits: its x and its top and bottom ends. Bass strings are long and on the left. */
  private geometry(i: number): [number, number, number] {
    const { width: w, height: h } = this.view;
    const n = this.strings.length;
    const f = n === 1 ? 0.5 : i / (n - 1);
    const x = w * (0.12 + f * 0.76);
    const len = h * (0.85 - f * 0.45);
    const top = h * 0.07 + (h * 0.85 - len) * 0.5;
    return [x, top, top + len];
  }

  private pluck(i: number, at: number, amount: number, hue?: number): void {
    const s = this.strings[i];
    if (!s) return;
    const k = Math.max(1, Math.min(POINTS - 2, Math.round(at * (POINTS - 1))));
    // A triangular pull, the shape of a plucked string just before release.
    for (let j = 1; j < POINTS - 1; j++) {
      const v = j <= k ? j / k : (POINTS - 1 - j) / (POINTS - 1 - k);
      // Clamp so repeated plucks on an undamped string can't grow without bound.
      s.y[j] = Math.max(-250, Math.min(250, s.y[j] + v * amount));
      s.prev[j] = Math.max(-250, Math.min(250, s.prev[j] + v * amount));
    }
    s.glow = Math.min(1, s.glow + Math.abs(amount) / 30);
    if (hue !== undefined) s.hue = hue;
  }

  step(_dt: number, p: ParamValues): void {
    // Each sub-step moves waves at most one grid point (c2 <= 0.98 keeps the
    // explicit scheme inside its CFL limit), so the wave speed slider adds
    // sub-steps rather than raising c2. Damping is per frame, so it means
    // the same whatever the sub-step count.
    const subs = Math.max(1, Math.round(p.speed as number));
    const damp = Math.exp(-(p.damping as number) * 0.004 / subs);
    const tension = p.tension as number;
    for (const s of this.strings) {
      const c2 = Math.min(0.98, s.c2 * tension);
      for (let sub = 0; sub < subs; sub++) {
        const { y, prev, next } = s;
        for (let j = 1; j < POINTS - 1; j++) {
          next[j] = (2 * y[j] - prev[j] + c2 * (y[j - 1] - 2 * y[j] + y[j + 1])) * damp;
        }
        s.prev = y;
        s.y = next;
        s.next = prev;
      }
      s.glow *= 0.97;
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const n = this.strings.length;
    if (n === 0) return;
    const pull = (p.pluck as number) * ev.velocity;
    if (ev.role === "tone") {
      const i = Math.round(ev.x * (n - 1));
      this.pluck(i, 0.3, pull * (i % 2 ? 1 : -1), noteHue(ev.note));
    } else if (ev.role === "kick") {
      // The soundboard thumps: every string jumps a little.
      for (let i = 0; i < n; i++) this.pluck(i, 0.5, pull * 0.25);
    } else if (ev.role === "snare") {
      const i = (Math.random() * n) | 0;
      this.pluck(i, 0.15, pull * 0.5);
    }
  }

  onPointer(input: PointerInput, p: ParamValues): void {
    // Strum: pluck any string the pointer crosses while pressed.
    if (input.type === "down") this.last = { x: input.x, y: input.y };
    else if (input.type === "move" && this.last && input.pressed) {
      for (let i = 0; i < this.strings.length; i++) {
        const [x, top, bottom] = this.geometry(i);
        if ((this.last.x - x) * (input.x - x) > 0 || input.y < top || input.y > bottom) continue;
        const dir = Math.sign(input.x - this.last.x);
        this.pluck(i, (input.y - top) / (bottom - top), dir * (p.pluck as number) * 0.7);
      }
      this.last = { x: input.x, y: input.y };
    } else if (input.type === "up") this.last = null;
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    const thick = p.thickness as number;
    const { width: w, height: h } = this.view;
    // Frame of the harp.
    g.strokeStyle = "#30363d";
    g.lineWidth = 6;
    g.beginPath();
    const [x0, t0, b0] = this.geometry(0);
    const [x1, t1, b1] = this.geometry(Math.max(0, this.strings.length - 1));
    g.moveTo(x0 - 14, b0 + 6);
    g.lineTo(x1 + 14, b1 + 6);
    g.moveTo(x0 - 14, t0 - 6);
    g.quadraticCurveTo(w * 0.5, h * 0.02, x1 + 14, t1 - 6);
    g.stroke();

    for (let i = 0; i < this.strings.length; i++) {
      const s = this.strings[i];
      const [x, top, bottom] = this.geometry(i);
      const seg = (bottom - top) / (POINTS - 1);
      if (s.glow > 0.02) {
        g.lineWidth = 4 * thick;
        g.strokeStyle = `hsla(${s.hue} 90% 60% / ${s.glow * 0.25})`;
        this.trace(g, s, x, top, seg);
      }
      g.lineWidth = thick * (1 + s.glow * 0.7);
      g.strokeStyle = `hsl(${s.hue} ${50 + s.glow * 40}% ${55 + s.glow * 25}%)`;
      this.trace(g, s, x, top, seg);
      g.fillStyle = "#8b949e";
      g.fillRect(x - 2, top - 2, 4, 4);
      g.fillRect(x - 2, bottom - 2, 4, 4);
    }
    g.lineWidth = 1;
  }

  private trace(g: CanvasRenderingContext2D, s: HarpString, x: number, top: number, seg: number): void {
    g.beginPath();
    for (let j = 0; j < POINTS; j++) {
      const px = x + s.y[j], py = top + j * seg;
      if (j === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }

  stats(): string {
    return `${this.strings.length} strings`;
  }
}

export const harp: ModelDefinition = {
  id: "harp",
  name: "String harp",
  category: "Sound & music",
  description: "Strings obeying the wave equation. Notes pluck the string for their pitch, and the pluck bounces between the ends and rings out as standing waves.",
  hint: "Drag across the strings to strum them. The sequencer's eight melody rows map to the eight strings.",
  fixedDt: 1 / 60,
  params: [
    { kind: "number", key: "pluck", label: "Pluck strength", min: 2, max: 150, step: 1, default: 30, group: "Behaviour",
      description: "How far a note or strum pulls the string. High values whip strings across each other." },
    { kind: "number", key: "tension", label: "Tension", min: 0.05, max: 1.4, step: 0.01, default: 0.7, group: "Behaviour",
      description: "How tight the strings are. Slack strings wobble slowly; tight ones shiver fast." },
    { kind: "number", key: "damping", label: "Damping", min: 0, max: 40, step: 0.1, default: 1.5, group: "Behaviour",
      description: "How quickly a plucked string stops ringing. Zero rings forever." },
    { kind: "number", key: "speed", label: "Wave speed", min: 1, max: 16, step: 1, default: 4, group: "Simulation",
      description: "How fast kinks race up and down the strings." },
    { kind: "number", key: "thickness", label: "String thickness", min: 0.5, max: 8, step: 0.1, default: 1.5, group: "Look",
      description: "How thick the strings and their glow are drawn." },
    { kind: "number", key: "strings", label: "Strings", min: 1, max: 24, step: 1, default: 8, resetOnChange: true, group: "Setup",
      description: "How many strings the harp has. Melody notes spread across them by pitch." },
  ],
  macros: [
    { key: "ring", label: "Ring out", targets: [{ param: "damping", amount: -0.5 }, { param: "pluck", amount: 0.2 }] },
    { key: "slack", label: "Slack", targets: [{ param: "tension", amount: -0.7 }, { param: "thickness", amount: 0.2 }] },
    { key: "frenzy", label: "Frenzy", targets: [{ param: "speed", amount: 0.7 }, { param: "pluck", amount: 0.45 }] },
  ],
  modulations: [
    { source: "kick", target: "thickness", amount: 0.4 },
    { source: "snare", target: "tension", amount: -0.3 },
    { source: "lfoBar", target: "speed", amount: 0.3 },
    { source: "level", target: "pluck", amount: 0.35 },
    { source: "pitchbend", target: "tension", amount: 0.3 },
  ],
  reactions: [
    { role: "tone", text: "Plucks the string matching the note's pitch and colours it" },
    { role: "kick", text: "Thumps the soundboard so every string jumps" },
    { role: "snare", text: "Plucks a random string near its top end" },
  ],
  create: () => new HarpSim(),
};
