import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";

const TRAIL_MAX = 400;
const SUBSTEPS = 4;

/**
 * A fan of double pendulums released from almost the same angle. They move
 * together at first, then sensitive dependence on initial conditions (chaos)
 * pulls them apart. Integrated with RK4.
 */
class PendulumSim implements SimulationModel {
  private count = 0;
  /** Per pendulum: theta1, omega1, theta2, omega2. */
  private s = new Float64Array(0);
  private trail = new Float32Array(0);
  private head = 0;
  private filled = 0;
  private view: Viewport = { width: 1, height: 1 };
  private aim: { x: number; y: number } | null = null;
  private start = { a1: 2.2, a2: 2.4 };
  private time = 0;
  private flash = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.count = p.count as number;
    this.s = new Float64Array(this.count * 4);
    const spread = 10 ** (p.spread as number);
    for (let i = 0; i < this.count; i++) {
      const off = (i - (this.count - 1) / 2) * spread;
      this.s[i * 4] = this.start.a1 + off;
      this.s[i * 4 + 2] = this.start.a2 + off;
    }
    this.trail = new Float32Array(this.count * TRAIL_MAX * 2);
    this.head = 0;
    this.filled = 0;
    this.time = 0;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private pivot(): [number, number, number] {
    const L = Math.min(this.view.width, this.view.height) * 0.22;
    return [this.view.width / 2, this.view.height * 0.42, L];
  }

  step(dt: number, p: ParamValues): void {
    const g = p.gravity as number;
    const m2 = p.massRatio as number;
    const damp = p.damping as number;
    const [, , L] = this.pivot();
    const h = dt / SUBSTEPS;
    const s = this.s;
    const deriv = (t1: number, w1: number, t2: number, w2: number, out: number[]) => {
      const m1 = 1;
      const d = t1 - t2;
      const den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
      const a1 = (-g * (2 * m1 + m2) * Math.sin(t1) - m2 * g * Math.sin(t1 - 2 * t2)
        - 2 * Math.sin(d) * m2 * (w2 * w2 * L + w1 * w1 * L * Math.cos(d))) / (L * den);
      const a2 = (2 * Math.sin(d) * (w1 * w1 * L * (m1 + m2) + g * (m1 + m2) * Math.cos(t1)
        + w2 * w2 * L * m2 * Math.cos(d))) / (L * den);
      out[0] = w1; out[1] = a1 - damp * w1; out[2] = w2; out[3] = a2 - damp * w2;
    };
    const k1 = [0, 0, 0, 0], k2 = [0, 0, 0, 0], k3 = [0, 0, 0, 0], k4 = [0, 0, 0, 0];
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (let i = 0; i < this.count; i++) {
        const o = i * 4;
        const t1 = s[o], w1 = s[o + 1], t2 = s[o + 2], w2 = s[o + 3];
        deriv(t1, w1, t2, w2, k1);
        deriv(t1 + k1[0] * h / 2, w1 + k1[1] * h / 2, t2 + k1[2] * h / 2, w2 + k1[3] * h / 2, k2);
        deriv(t1 + k2[0] * h / 2, w1 + k2[1] * h / 2, t2 + k2[2] * h / 2, w2 + k2[3] * h / 2, k3);
        deriv(t1 + k3[0] * h, w1 + k3[1] * h, t2 + k3[2] * h, w2 + k3[3] * h, k4);
        for (let j = 0; j < 4; j++) s[o + j] += (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
      }
    }
    this.time += dt;

    const [cx, cy] = this.pivot();
    for (let i = 0; i < this.count; i++) {
      const [, , x2, y2] = this.joints(i, cx, cy, L);
      const idx = (i * TRAIL_MAX + this.head) * 2;
      this.trail[idx] = x2;
      this.trail[idx + 1] = y2;
    }
    this.head = (this.head + 1) % TRAIL_MAX;
    this.filled = Math.min(this.filled + 1, TRAIL_MAX);
  }

  private joints(i: number, cx: number, cy: number, L: number): [number, number, number, number] {
    const t1 = this.s[i * 4], t2 = this.s[i * 4 + 2];
    const x1 = cx + L * Math.sin(t1), y1 = cy + L * Math.cos(t1);
    return [x1, y1, x1 + L * Math.sin(t2), y1 + L * Math.cos(t2)];
  }

  onPointer(input: PointerInput, p: ParamValues): void {
    // Drag to aim: both arms point at the cursor. Release to drop them all.
    if (input.type === "down" || (input.type === "move" && this.aim)) {
      this.aim = { x: input.x, y: input.y };
    } else if (input.type === "up" && this.aim) {
      const [cx, cy] = this.pivot();
      const a = Math.atan2(this.aim.x - cx, this.aim.y - cy);
      this.start = { a1: a, a2: a + 0.0001 };
      this.aim = null;
      this.reset(this.view, p);
    }
  }

  onNote(ev: NoteEvent): void {
    // Kicks swing the upper arms, notes flick the lower arms (left or right by pitch).
    const s = this.s;
    for (let i = 0; i < this.count; i++) {
      if (ev.role === "kick") s[i * 4 + 1] += 2.2 * ev.velocity * Math.sign(s[i * 4 + 1] || 1);
      else if (ev.role === "tone") s[i * 4 + 3] += (ev.x - 0.5) * 7 * ev.velocity;
      else if (ev.role === "snare") s[i * 4 + 3] *= -1;
    }
    this.flash = Math.max(this.flash, ev.velocity);
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    const [cx, cy, L] = this.pivot();
    const glow = this.flash;
    this.flash *= 0.88;
    const trailLen = Math.min(this.filled, p.trail as number);
    const hue = (i: number) => (this.count === 1 ? 190 : 200 + (i / (this.count - 1)) * 160);

    if (trailLen > 1) {
      g.lineWidth = 1;
      for (let i = 0; i < this.count; i++) {
        g.beginPath();
        for (let k = 0; k < trailLen; k++) {
          const t = (this.head - trailLen + k + TRAIL_MAX) % TRAIL_MAX;
          const idx = (i * TRAIL_MAX + t) * 2;
          if (k === 0) g.moveTo(this.trail[idx], this.trail[idx + 1]);
          else g.lineTo(this.trail[idx], this.trail[idx + 1]);
        }
        g.strokeStyle = `hsla(${hue(i)} 85% 62% / 0.35)`;
        g.stroke();
      }
    }

    g.lineWidth = 2;
    for (let i = 0; i < this.count; i++) {
      const [x1, y1, x2, y2] = this.joints(i, cx, cy, L);
      g.strokeStyle = `hsla(${hue(i)} 85% 65% / 0.75)`;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.fillStyle = `hsl(${hue(i)} 90% ${70 + glow * 20}%)`;
      g.beginPath();
      g.arc(x2, y2, 4 + glow * 4, 0, Math.PI * 2);
      g.fill();
    }
    g.lineWidth = 1;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(cx, cy, 4, 0, Math.PI * 2);
    g.fill();

    if (this.aim) {
      g.beginPath();
      g.moveTo(cx, cy);
      const a = Math.atan2(this.aim.x - cx, this.aim.y - cy);
      g.lineTo(cx + Math.sin(a) * L * 2, cy + Math.cos(a) * L * 2);
      g.setLineDash([4, 4]);
      g.strokeStyle = "rgba(255,255,255,0.6)";
      g.stroke();
      g.setLineDash([]);
    }
  }

  stats(): string {
    // How far the fan has spread: the range of lower-arm angles, in degrees.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const t = this.s[i * 4 + 2];
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const spread = this.count > 1 ? Math.min(360, ((hi - lo) * 180) / Math.PI) : 0;
    return `t = ${this.time.toFixed(1)}s · spread ${spread < 1 ? spread.toFixed(3) : spread.toFixed(0)}°`;
  }
}

export const pendulum: ModelDefinition = {
  id: "pendulum",
  name: "Chaotic pendulums",
  category: "Mechanics",
  description: "A fan of double pendulums released a hair's breadth apart. They swing as one, then chaos tears them into a rainbow.",
  hint: "Drag to aim the arms, release to drop every pendulum from that angle. Kicks swing the arms; notes flick them left or right by pitch.",
  fixedDt: 1 / 120,
  params: [
    { kind: "number", key: "count", label: "Pendulums", min: 1, max: 200, step: 1, default: 60, resetOnChange: true },
    { kind: "number", key: "spread", label: "Initial difference (10^x rad)", min: -9, max: -1, step: 0.5, default: -4, resetOnChange: true },
    { kind: "number", key: "gravity", label: "Gravity", min: 100, max: 4000, step: 50, default: 1500 },
    { kind: "number", key: "massRatio", label: "Lower / upper mass", min: 0.1, max: 4, step: 0.05, default: 1 },
    { kind: "number", key: "damping", label: "Friction", min: 0, max: 1, step: 0.01, default: 0 },
    { kind: "number", key: "trail", label: "Trail length", min: 0, max: TRAIL_MAX, step: 10, default: 60 },
  ],
  macros: [
    { key: "heavy", label: "Heavy", targets: [{ param: "gravity", amount: 0.4 }, { param: "massRatio", amount: 0.3 }] },
    { key: "settle", label: "Settle", targets: [{ param: "damping", amount: 0.6 }] },
  ],
  modulations: [{ source: "lfoBar", target: "massRatio", amount: 0.15 }],
  create: () => new PendulumSim(),
};
