import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";

/** Just-intonation frequency ratios for each interval in semitones. */
const JUST: [number, number][] = [
  [1, 1], [16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [9, 5], [15, 8],
];
const INTERVAL_NAMES = ["Unison", "Minor 2nd", "Major 2nd", "Minor 3rd", "Major 3rd", "Fourth", "Tritone", "Fifth", "Minor 6th", "Major 6th", "Minor 7th", "Major 7th"];

const TRAIL = 10000;

/**
 * A harmonograph: two damped pendulums swing a pen in x and y while a third
 * rotates the paper slightly. When their frequencies form a simple ratio the
 * pen draws a stable Lissajous figure; that ratio is a musical interval, so
 * each pair of notes draws its own shape.
 */
class HarmonographSim implements SimulationModel {
  private view: Viewport = { width: 1, height: 1 };
  private amp = 1;
  private ampTarget = 1;
  private glide = 1.5;
  private px = 0;
  private py = 0;
  private rot = 0;
  private ratio: [number, number] = [3, 2];
  private interval = 7;
  private lastNote = -1;
  private hue = 200;
  private pts = new Float32Array(TRAIL * 2);
  private hues = new Float32Array(TRAIL);
  private head = 0;
  private count = 0;
  private lastParamInterval: unknown = null;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.amp = this.ampTarget = 1;
    this.px = this.py = this.rot = 0;
    this.count = 0;
    this.setInterval(Number(p.interval));
    this.lastParamInterval = p.interval;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private setInterval(semis: number): void {
    this.interval = ((semis % 12) + 12) % 12;
    this.ratio = JUST[this.interval];
  }

  step(dt: number, p: ParamValues): void {
    if (p.interval !== this.lastParamInterval) {
      this.lastParamInterval = p.interval;
      this.setInterval(Number(p.interval));
    }
    const speed = p.speed as number;
    const detune = p.detune as number;
    const decay = p.decay as number;
    const size = Math.min(this.view.width, this.view.height) * 0.42;
    const cx = this.view.width / 2, cy = this.view.height / 2;
    const [a, b] = this.ratio;
    const base = 1.2 * speed;
    // Several pen samples per step keep fast curves smooth.
    const sub = 6;
    const h = dt / sub;
    for (let k = 0; k < sub; k++) {
      // Glide the ratio and swing toward their targets so a new note morphs
      // the figure instead of making the pen jump.
      this.glide += (a / b - this.glide) * Math.min(1, h * 6);
      this.amp += (this.ampTarget - this.amp) * Math.min(1, h * 10);
      this.ampTarget *= Math.exp(-decay * h);
      // Integrating phase (rather than using f·t) keeps the pen continuous when f changes.
      this.px += base * this.glide * h * Math.PI * 2;
      this.py += base * (1 + detune) * h * Math.PI * 2;
      this.rot += (p.spin as number) * speed * h * Math.PI * 2;
      const x0 = Math.sin(this.px) * this.amp;
      const y0 = Math.sin(this.py) * this.amp;
      // The rotary pendulum turns the paper slowly, so the figure precesses.
      const c = Math.cos(this.rot), sn = Math.sin(this.rot);
      this.pts[this.head * 2] = cx + (x0 * c - y0 * sn) * size;
      this.pts[this.head * 2 + 1] = cy + (x0 * sn + y0 * c) * size;
      this.hues[this.head] = this.hue;
      this.head = (this.head + 1) % TRAIL;
      this.count = Math.min(this.count + 1, TRAIL);
    }
  }

  onNote(ev: NoteEvent): void {
    if (ev.role === "tone") {
      // The figure takes the interval between this note and the one before it.
      if (this.lastNote >= 0) this.setInterval(ev.note - this.lastNote);
      this.lastNote = ev.note;
      this.hue = noteHue(ev.note);
      this.ampTarget = Math.max(this.ampTarget, 0.4 + ev.velocity * 0.6);
    } else if (ev.role === "kick") {
      // A kick pushes the pendulums back up to full swing.
      this.ampTarget = Math.max(this.ampTarget, 0.6 + ev.velocity * 0.4);
    }
  }

  onPointer(input: PointerInput): void {
    // Click to push the pendulums back to full swing, with a new phase offset.
    if (input.type === "down") {
      this.ampTarget = 1;
      this.px += (input.x / this.view.width) * Math.PI;
      this.count = 0;
    }
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    const n = Math.min(this.count, p.trail as number);
    if (n < 2) return;
    // Draw in chunks, oldest faintest, each chunk in the colour it was drawn in.
    const chunk = 100;
    g.lineWidth = p.lineWidth as number;
    g.lineJoin = "round";
    for (let start = 0; start < n - 1; start += chunk) {
      const end = Math.min(n - 1, start + chunk);
      const idx = (i: number) => (this.head - n + i + TRAIL) % TRAIL;
      g.beginPath();
      for (let i = start; i <= end; i++) {
        const j = idx(i);
        if (i === start) g.moveTo(this.pts[j * 2], this.pts[j * 2 + 1]);
        else g.lineTo(this.pts[j * 2], this.pts[j * 2 + 1]);
      }
      const age = end / n;
      g.strokeStyle = `hsla(${this.hues[idx(start)]} 80% 65% / ${0.08 + age * 0.75})`;
      g.stroke();
    }
    g.lineWidth = 1;
  }

  stats(): string {
    const [a, b] = this.ratio;
    return `${INTERVAL_NAMES[this.interval]} (${a}:${b})`;
  }
}

export const harmonograph: ModelDefinition = {
  id: "harmonograph",
  name: "Harmonograph",
  category: "Sound & music",
  description: "Damped pendulums steer a pen. Their frequency ratio is a musical interval, so consonant intervals draw clean, closed figures and dissonant ones draw dense knots.",
  hint: "Play notes: the figure morphs to the interval between each note and the one before. Kicks push the pendulums back to full swing. Click to start a fresh figure.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "interval", label: "Interval", default: "7", group: "Motion",
      description: "The ratio between the two pendulums. Simple ratios draw clean loops.",
      options: INTERVAL_NAMES.map((name, i) => ({ value: String(i), label: `${name} (${JUST[i][0]}:${JUST[i][1]})` })),
    },
    { kind: "number", key: "speed", label: "Swing speed", min: 0.05, max: 4, step: 0.05, default: 0.35, group: "Motion",
      description: "How fast the pendulums swing. High values scribble the figure in a blur." },
    { kind: "number", key: "detune", label: "Detune", min: 0, max: 0.15, step: 0.001, default: 0.004, group: "Motion",
      description: "Pulls the ratio slightly off. The figure slowly twists; high values weave dense knots." },
    { kind: "number", key: "spin", label: "Paper spin", min: 0, max: 0.4, step: 0.005, default: 0.03, group: "Motion",
      description: "How fast the paper turns under the pen, spinning the figure into a rosette." },
    { kind: "number", key: "decay", label: "Damping", min: 0, max: 3, step: 0.01, default: 0.08, group: "Motion",
      description: "How quickly the swing dies away. High values shrink the figure to a dot between notes." },
    { kind: "number", key: "trail", label: "Line length", min: 200, max: TRAIL, step: 100, default: 3500, group: "Look",
      description: "How much of the pen's path stays on screen." },
    { kind: "number", key: "lineWidth", label: "Line width", min: 0.5, max: 8, step: 0.1, default: 1.2, group: "Look",
      description: "How thick the pen line is drawn." },
  ],
  macros: [
    { key: "drift", label: "Drift", targets: [{ param: "detune", amount: 0.7 }] },
    { key: "tempo", label: "Faster", targets: [{ param: "speed", amount: 0.55 }, { param: "trail", amount: 0.3 }] },
    { key: "whirl", label: "Whirl", targets: [{ param: "spin", amount: 0.8 }, { param: "lineWidth", amount: 0.15 }] },
  ],
  modulations: [
    { source: "kick", target: "lineWidth", amount: 0.4 },
    { source: "snare", target: "speed", amount: 0.25 },
    { source: "pitch", target: "detune", amount: 0.3 },
    { source: "lfoBar", target: "spin", amount: 0.35 },
    { source: "bass", target: "lineWidth", amount: 0.3 },
  ],
  reactions: [
    { role: "tone", text: "Morphs the figure to the interval from the previous note and recolours the pen" },
    { role: "kick", text: "Pushes the pendulums back up to full swing" },
  ],
  create: () => new HarmonographSim(),
};
