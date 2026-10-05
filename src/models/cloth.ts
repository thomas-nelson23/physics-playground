import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";

const BUCKETS = 6;

/**
 * A cloth of point masses joined by distance constraints, integrated with
 * Verlet and relaxed by repeated constraint projection (position-based
 * dynamics). Over-stretched links snap, so the cloth can be torn.
 */
class ClothSim implements SimulationModel {
  private n = 0;
  private x = new Float64Array(0);
  private y = new Float64Array(0);
  private px = new Float64Array(0);
  private py = new Float64Array(0);
  private pinned = new Uint8Array(0);
  private ca = new Int32Array(0);
  private cb = new Int32Array(0);
  private rest = 0;
  private alive = new Uint8Array(0);
  private view: Viewport = { width: 1, height: 1 };
  private grab: number | null = null;
  private cutter: { x: number; y: number } | null = null;
  private pointer = { x: 0, y: 0 };
  private time = 0;
  private torn = 0;
  private gustSide = 1;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const cols = p.resolution as number;
    const clothW = view.width * 0.62;
    const spacing = clothW / (cols - 1);
    const rows = Math.max(4, Math.floor((view.height * 0.6) / spacing));
    const left = (view.width - clothW) / 2, top = view.height * 0.08;
    this.n = cols * rows;
    this.x = new Float64Array(this.n);
    this.y = new Float64Array(this.n);
    this.pinned = new Uint8Array(this.n);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        this.x[k] = left + i * spacing;
        this.y[k] = top + j * spacing;
        if (j === 0) {
          const pins = p.pins;
          if (pins === "edge") this.pinned[k] = 1;
          else if (pins === "corners") this.pinned[k] = i === 0 || i === cols - 1 ? 1 : 0;
          else if (pins === "curtain") this.pinned[k] = i % 6 === 0 || i === cols - 1 ? 1 : 0;
        }
      }
    }
    this.px = this.x.slice();
    this.py = this.y.slice();
    const a: number[] = [], b: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i < cols - 1) { a.push(k); b.push(k + 1); }
        if (j < rows - 1) { a.push(k); b.push(k + cols); }
      }
    }
    this.ca = Int32Array.from(a);
    this.cb = Int32Array.from(b);
    this.alive = new Uint8Array(a.length).fill(1);
    this.rest = spacing;
    this.torn = 0;
    this.time = 0;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  step(dt: number, p: ParamValues): void {
    const { x, y, px, py, pinned, n } = this;
    this.time += dt;
    const gravity = p.gravity as number;
    const wind = (p.wind as number) * (0.6 + 0.4 * Math.sin(this.time * 1.3) + 0.2 * Math.sin(this.time * 3.7));
    const damp = 0.995;
    const dt2 = dt * dt;
    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue;
      // Wind gusts vary down the cloth so it ripples instead of swinging rigidly.
      const gust = wind * (0.7 + 0.3 * Math.sin(y[k] * 0.02 + this.time * 2));
      const vx = (x[k] - px[k]) * damp, vy = (y[k] - py[k]) * damp;
      px[k] = x[k];
      py[k] = y[k];
      x[k] += vx + gust * dt2;
      y[k] += vy + gravity * dt2;
    }

    const iters = p.stiffness as number;
    const tear = p.tearable ? (p.tearLimit as number) * this.rest : Infinity;
    const { ca, cb, alive, rest } = this;
    const { width: w, height: h } = this.view;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < ca.length; c++) {
        if (!alive[c]) continue;
        const a = ca[c], b = cb[c];
        const dx = x[b] - x[a], dy = y[b] - y[a];
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        if (d > tear) { alive[c] = 0; this.torn++; continue; }
        const diff = (d - rest) / d;
        const wa = pinned[a] ? 0 : 1, wb = pinned[b] ? 0 : 1;
        const sum = wa + wb;
        if (sum === 0) continue;
        const ox = dx * diff / sum, oy = dy * diff / sum;
        x[a] += ox * wa; y[a] += oy * wa;
        x[b] -= ox * wb; y[b] -= oy * wb;
      }
      if (this.grab !== null) {
        x[this.grab] = this.pointer.x;
        y[this.grab] = this.pointer.y;
      }
    }

    for (let k = 0; k < n; k++) {
      if (x[k] < 0) x[k] = 0; else if (x[k] > w) x[k] = w;
      if (y[k] > h) { y[k] = h; px[k] = x[k] - (x[k] - px[k]) * 0.5; }
    }

    if (this.cutter) this.cut(this.cutter.x, this.cutter.y, 14);
  }

  /** Give every free point a velocity kick (Verlet velocity is x - px). */
  private impulse(fx: (x: number, y: number) => [number, number]): void {
    for (let k = 0; k < this.n; k++) {
      if (this.pinned[k]) continue;
      const [dx, dy] = fx(this.x[k], this.y[k]);
      this.px[k] -= dx;
      this.py[k] -= dy;
    }
  }

  onNote(ev: NoteEvent): void {
    const { width: w, height: h } = this.view;
    if (ev.role === "kick") {
      // A gust that alternates direction on each kick.
      this.gustSide = -this.gustSide;
      const s = 9 * ev.velocity * this.gustSide;
      this.impulse((_x, y) => [s * (0.6 + 0.4 * Math.sin(y * 0.03)), -2 * ev.velocity]);
    } else if (ev.role === "snare") {
      this.impulse(() => [(Math.random() - 0.5) * 4 * ev.velocity, (Math.random() - 0.5) * 4 * ev.velocity]);
    } else if (ev.role === "tone") {
      // Notes pluck the cloth where they land: low notes left, high notes right.
      const cx = w * (0.2 + ev.x * 0.6), cy = h * 0.4, r = 70;
      this.impulse((x, y) => {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        const f = Math.exp(-d2 / (r * r)) * 10 * ev.velocity;
        return [0, -f];
      });
    }
  }

  private cut(cx: number, cy: number, r: number): void {
    const { x, y, ca, cb, alive } = this;
    for (let c = 0; c < ca.length; c++) {
      if (!alive[c]) continue;
      const mx = (x[ca[c]] + x[cb[c]]) / 2, my = (y[ca[c]] + y[cb[c]]) / 2;
      if ((mx - cx) ** 2 + (my - cy) ** 2 < r * r) { alive[c] = 0; this.torn++; }
    }
  }

  onPointer(input: PointerInput): void {
    this.pointer.x = input.x;
    this.pointer.y = input.y;
    const cutting = input.button === 2 || input.shift;
    if (input.type === "down") {
      if (cutting) {
        this.cutter = { x: input.x, y: input.y };
      } else {
        let best = -1, bestD = 40 * 40;
        for (let k = 0; k < this.n; k++) {
          const d = (this.x[k] - input.x) ** 2 + (this.y[k] - input.y) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
        this.grab = best >= 0 ? best : null;
      }
    } else if (input.type === "move") {
      if (this.cutter) { this.cutter.x = input.x; this.cutter.y = input.y; }
    } else {
      this.grab = null;
      this.cutter = null;
    }
  }

  render(g: CanvasRenderingContext2D): void {
    const { x, y, ca, cb, alive, rest } = this;
    // Colour each link by how stretched it is: blue when relaxed, red near tearing.
    const paths = Array.from({ length: BUCKETS }, () => new Path2D());
    for (let c = 0; c < ca.length; c++) {
      if (!alive[c]) continue;
      const a = ca[c], b = cb[c];
      const strain = Math.hypot(x[b] - x[a], y[b] - y[a]) / rest - 1;
      const bucket = Math.max(0, Math.min(BUCKETS - 1, Math.floor(strain * 12 * BUCKETS / 4)));
      paths[bucket].moveTo(x[a], y[a]);
      paths[bucket].lineTo(x[b], y[b]);
    }
    g.lineWidth = 1.2;
    for (let i = 0; i < BUCKETS; i++) {
      const t = i / (BUCKETS - 1);
      g.strokeStyle = `hsl(${205 - t * 205} ${70 + t * 20}% ${62 - t * 8}%)`;
      g.stroke(paths[i]);
    }
    g.lineWidth = 1;
    g.fillStyle = "#fff";
    for (let k = 0; k < this.n; k++) if (this.pinned[k]) g.fillRect(x[k] - 2, y[k] - 2, 4, 4);
    if (this.cutter) {
      g.beginPath();
      g.arc(this.cutter.x, this.cutter.y, 14, 0, Math.PI * 2);
      g.strokeStyle = "rgba(255,120,120,0.7)";
      g.stroke();
    }
  }

  stats(): string {
    return `${this.n} points · ${this.torn} links torn`;
  }
}

export const cloth: ModelDefinition = {
  id: "cloth",
  name: "Cloth",
  category: "Mechanics",
  description: "A sheet of fabric simulated with Verlet integration and distance constraints. Links glow red as they stretch and snap past the tear limit.",
  hint: "Drag to grab and pull the cloth. Right-drag or Shift-drag to slice it. Kicks blow gusts; notes pluck the cloth left to right by pitch.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "pins", label: "Hang from", default: "curtain", resetOnChange: true,
      options: [
        { value: "edge", label: "Whole top edge" },
        { value: "curtain", label: "Curtain rings" },
        { value: "corners", label: "Two corners" },
      ],
    },
    { kind: "number", key: "resolution", label: "Resolution", min: 10, max: 90, step: 1, default: 50, resetOnChange: true },
    { kind: "number", key: "gravity", label: "Gravity", min: 0, max: 2000, step: 10, default: 800 },
    { kind: "number", key: "wind", label: "Wind", min: -1500, max: 1500, step: 10, default: 80 },
    { kind: "number", key: "stiffness", label: "Stiffness (iterations)", min: 1, max: 30, step: 1, default: 8 },
    { kind: "number", key: "tearLimit", label: "Tear limit (x rest length)", min: 1.5, max: 8, step: 0.1, default: 3.5 },
    { kind: "boolean", key: "tearable", label: "Tearable", default: true },
  ],
  macros: [
    { key: "storm", label: "Storm", targets: [{ param: "wind", amount: 0.35 }] },
    { key: "float", label: "Weightless", targets: [{ param: "gravity", amount: -0.35 }] },
  ],
  modulations: [{ source: "lfoBar", target: "wind", amount: 0.08 }],
  create: () => new ClothSim(),
};
