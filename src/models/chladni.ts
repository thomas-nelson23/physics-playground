import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";

/**
 * Vibration modes of a square plate, (n, m, sign), ordered roughly by pitch.
 * The plate's displacement in mode (n, m) is
 *   cos(nπx)cos(mπy) ± cos(mπx)cos(nπy)
 * which is the classic approximation Chladni figures are drawn from.
 */
const MODES: [number, number, number][] = [];
for (let n = 1; n <= 8; n++) {
  for (let m = n + 1; m <= 9; m++) {
    MODES.push([n, m, -1]);
    MODES.push([n, m, 1]);
  }
}
MODES.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));

/**
 * Chladni figures (cymatics): sand on a vibrating plate is thrown off the
 * parts that move and collects along the nodal lines that stay still. Each
 * note sets the plate ringing in a different mode, so a melody redraws the
 * pattern note by note.
 */
class ChladniSim implements SimulationModel {
  private gx = new Float32Array(0);
  private gy = new Float32Array(0);
  private view: Viewport = { width: 1, height: 1 };
  private mode = 0;
  private lastParamMode = -1;
  private shake = 0;
  private hue = 45;
  private targetHue = 45;
  private pointer: { x: number; y: number } | null = null;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const n = p.grains as number;
    this.gx = new Float32Array(n);
    this.gy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.gx[i] = Math.random();
      this.gy[i] = Math.random();
    }
    this.mode = p.mode as number;
    this.lastParamMode = this.mode;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  /** The plate: a centred square, in CSS pixels. */
  private plate(): [number, number, number] {
    const s = Math.min(this.view.width, this.view.height) * 0.9;
    return [(this.view.width - s) / 2, (this.view.height - s) / 2, s];
  }

  step(dt: number, p: ParamValues): void {
    // The slider wins whenever it moves; notes take over otherwise.
    if (p.mode !== this.lastParamMode) {
      this.mode = p.mode as number;
      this.lastParamMode = this.mode;
    }
    const [n, m, sign] = MODES[this.mode % MODES.length];
    const amp = (p.vibration as number) + this.shake;
    this.shake *= Math.exp(-dt * 4);
    // Gradient descent toward the nodal lines overshoots (and the sand
    // jitters across the line) once the per-step gain passes ~1, which
    // happens sooner on busy modes, so cap the step for this mode.
    const pull = Math.min((p.settle as number) * dt * 0.25, 0.9 / (Math.PI * (n + m)));
    const jitter = amp * dt * 0.05;
    const PI = Math.PI;
    const { gx, gy } = this;
    let px = -1, py = -1;
    if (this.pointer) {
      const [ox, oy, s] = this.plate();
      px = (this.pointer.x - ox) / s;
      py = (this.pointer.y - oy) / s;
    }
    for (let i = 0; i < gx.length; i++) {
      const X = PI * gx[i], Y = PI * gy[i];
      const cnx = Math.cos(n * X), cmx = Math.cos(m * X), cny = Math.cos(n * Y), cmy = Math.cos(m * Y);
      const a = cnx * cmy + sign * cmx * cny;
      // Slide downhill on a², i.e. toward the nodal lines...
      const dax = -n * Math.sin(n * X) * cmy - sign * m * Math.sin(m * X) * cny;
      const day = -m * cnx * Math.sin(m * Y) - sign * n * cmx * Math.sin(n * Y);
      const norm = 1 / (n + m);
      let x = gx[i] - a * dax * norm * pull;
      let y = gy[i] - a * day * norm * pull;
      // ...while the shaking plate bounces grains around where it moves most.
      const kick = Math.abs(a) * jitter;
      x += (Math.random() - 0.5) * kick;
      y += (Math.random() - 0.5) * kick;
      if (px >= 0 && (x - px) ** 2 + (y - py) ** 2 < 0.004) {
        x += (Math.random() - 0.5) * 0.04;
        y += (Math.random() - 0.5) * 0.04;
      }
      // Grains bounce off the plate's rim.
      gx[i] = x < 0 ? -x : x > 1 ? 2 - x : x;
      gy[i] = y < 0 ? -y : y > 1 ? 2 - y : y;
    }
  }

  onNote(ev: NoteEvent): void {
    if (ev.role === "tone") {
      // Higher notes ring higher (busier) modes.
      this.mode = Math.round(ev.x * Math.min(MODES.length - 1, 36));
      this.targetHue = noteHue(ev.note);
      this.shake = Math.max(this.shake, ev.velocity * 1.5);
    } else {
      this.shake = Math.max(this.shake, ev.velocity * (ev.role === "kick" ? 3 : 1.2));
    }
  }

  onPointer(input: PointerInput): void {
    this.pointer = input.pressed && input.type !== "up" ? { x: input.x, y: input.y } : null;
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    const [ox, oy, s] = this.plate();
    g.fillStyle = "#161b22";
    g.fillRect(ox, oy, s, s);
    g.strokeStyle = "#30363d";
    g.strokeRect(ox + 0.5, oy + 0.5, s - 1, s - 1);

    const dh = ((this.targetHue - this.hue + 540) % 360) - 180;
    this.hue = (this.hue + dh * 0.06 + 360) % 360;
    g.fillStyle = p.colour ? `hsl(${this.hue} 70% 72%)` : "hsl(40 45% 78%)";
    const r = p.grainSize as number;
    const { gx, gy } = this;
    for (let i = 0; i < gx.length; i++) g.fillRect(ox + gx[i] * s - r / 2, oy + gy[i] * s - r / 2, r, r);
  }

  stats(): string {
    const [n, m, sign] = MODES[this.mode % MODES.length];
    return `Mode (${n}, ${m}) ${sign > 0 ? "+" : "−"} · ${this.gx.length.toLocaleString()} grains`;
  }
}

export const chladni: ModelDefinition = {
  id: "chladni",
  name: "Chladni plate",
  category: "Sound & music",
  description: "Sand on a vibrating plate collects along the lines that stay still. Each note rings the plate in a new mode and the sand redraws the figure.",
  hint: "Play notes (sequencer or MIDI) to change the pattern, or use the Mode slider. Drag to stir the sand.",
  fixedDt: 1 / 60,
  params: [
    { kind: "number", key: "mode", label: "Mode", min: 0, max: MODES.length - 1, step: 1, default: 6, group: "Behaviour",
      description: "Which vibration pattern the plate rings in. Higher modes draw busier figures." },
    { kind: "number", key: "vibration", label: "Vibration", min: 0, max: 12, step: 0.05, default: 0.8, group: "Behaviour",
      description: "How hard the plate shakes. High values blow the sand into a churning haze." },
    { kind: "number", key: "settle", label: "Settling speed", min: 0, max: 12, step: 0.05, default: 1.2, group: "Behaviour",
      description: "How fast sand slides onto the still lines. High values snap the figure sharp." },
    { kind: "number", key: "grainSize", label: "Grain size", min: 0.5, max: 5, step: 0.1, default: 1.4, group: "Look",
      description: "How big each grain of sand is drawn. Large grains make bold, chunky lines." },
    { kind: "boolean", key: "colour", label: "Colour by note", default: true, group: "Look",
      description: "Tint the sand with the colour of the last melody note instead of plain sand." },
    { kind: "number", key: "grains", label: "Grains", min: 2000, max: 40000, step: 1000, default: 16000, resetOnChange: true, group: "Setup",
      description: "How many grains of sand are on the plate. More grains draw finer lines." },
  ],
  macros: [
    { key: "agitate", label: "Agitate", targets: [{ param: "vibration", amount: 0.75 }, { param: "settle", amount: -0.3 }, { param: "grainSize", amount: 0.2 }] },
    { key: "settle", label: "Settle", targets: [{ param: "settle", amount: 0.8 }, { param: "vibration", amount: -0.5 }] },
  ],
  modulations: [
    { source: "kick", target: "grainSize", amount: 0.45 },
    { source: "snare", target: "vibration", amount: 0.35 },
    { source: "lfoBar", target: "settle", amount: 0.3 },
    { source: "bass", target: "vibration", amount: 0.4 },
  ],
  reactions: [
    { role: "tone", text: "Rings the plate in a mode set by pitch and tints the sand the note's colour" },
    { role: "kick", text: "A hard shake that throws the sand off the lines" },
    { role: "snare", text: "A medium shake that blurs the figure" },
    { role: "hat", text: "A medium shake that blurs the figure" },
  ],
  create: () => new ChladniSim(),
};
