import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, rgb } from "./lib/raster";

interface Charge {
  x: number;
  y: number;
  q: number;
  /** 0..1 glow after a note fires this charge. */
  flash?: number;
}

interface Probe {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

const SOFT = 120; // softening length^2 keeps forces finite near a charge
const CHARGE_R = 13;
const POT_CELL = 6;

/**
 * Electrostatics: fixed point charges set up a Coulomb field, and a swarm
 * of small positive probe particles is pushed along it from + to -.
 * Optional overlays show the electric potential and traced field lines.
 */
class ChargesSim implements SimulationModel {
  private charges: Charge[] = [];
  private probes: Probe[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private dragging: Charge | null = null;
  private potential: Raster | null = null;
  private lines: Float32Array[] = [];
  private dirty = true;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const { width: w, height: h } = view;
    const cx = w / 2, cy = h / 2, s = Math.min(w, h) * 0.18;
    switch (p.layout) {
      case "dipole":
        this.charges = [{ x: cx - s, y: cy, q: 1 }, { x: cx + s, y: cy, q: -1 }];
        break;
      case "quadrupole":
        this.charges = [
          { x: cx - s, y: cy - s, q: 1 }, { x: cx + s, y: cy - s, q: -1 },
          { x: cx - s, y: cy + s, q: -1 }, { x: cx + s, y: cy + s, q: 1 },
        ];
        break;
      case "capacitor":
        this.charges = [];
        for (let i = -4; i <= 4; i++) {
          this.charges.push({ x: cx - s, y: cy + i * s * 0.3, q: 0.5 }, { x: cx + s, y: cy + i * s * 0.3, q: -0.5 });
        }
        break;
      case "random":
        this.charges = Array.from({ length: 6 }, (_, i) => ({
          x: w * (0.15 + Math.random() * 0.7),
          y: h * (0.15 + Math.random() * 0.7),
          q: i % 2 === 0 ? 1 : -1,
        }));
        break;
      default:
        this.charges = [];
    }
    this.probes = Array.from({ length: p.probes as number }, () => this.spawn({ x: 0, y: 0, vx: 0, vy: 0, age: 0 }, true));
    this.dirty = true;
  }

  resize(view: Viewport): void {
    this.view = view;
    this.dirty = true;
  }

  /** Respawn a probe on a ring around a random positive charge (or anywhere). */
  private spawn(pr: Probe, anywhere = false): Probe {
    const pos = this.charges.filter((c) => c.q > 0);
    if (pos.length === 0 || anywhere) {
      pr.x = Math.random() * this.view.width;
      pr.y = Math.random() * this.view.height;
    } else {
      const c = pos[(Math.random() * pos.length) | 0];
      const a = Math.random() * Math.PI * 2;
      pr.x = c.x + Math.cos(a) * (CHARGE_R + 2);
      pr.y = c.y + Math.sin(a) * (CHARGE_R + 2);
    }
    pr.vx = 0;
    pr.vy = 0;
    pr.age = Math.random() * 2;
    return pr;
  }

  private field(x: number, y: number): [number, number] {
    let ex = 0, ey = 0;
    for (const c of this.charges) {
      const dx = x - c.x, dy = y - c.y;
      const d2 = dx * dx + dy * dy + SOFT;
      const inv = c.q / (d2 * Math.sqrt(d2));
      ex += dx * inv;
      ey += dy * inv;
    }
    return [ex, ey];
  }

  step(dt: number, p: ParamValues): void {
    const k = (p.strength as number) * 2e6;
    const drag = 1 - Math.min(1, (p.drag as number) * dt);
    const maxV = 700;
    const { width: w, height: h } = this.view;
    for (const pr of this.probes) {
      const [ex, ey] = this.field(pr.x, pr.y);
      pr.vx = (pr.vx + ex * k * dt) * drag;
      pr.vy = (pr.vy + ey * k * dt) * drag;
      const v = Math.hypot(pr.vx, pr.vy);
      if (v > maxV) { pr.vx *= maxV / v; pr.vy *= maxV / v; }
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.age += dt;
      let absorbed = false;
      for (const c of this.charges) {
        if (c.q < 0 && (pr.x - c.x) ** 2 + (pr.y - c.y) ** 2 < CHARGE_R * CHARGE_R) { absorbed = true; break; }
      }
      if (absorbed || pr.x < -50 || pr.y < -50 || pr.x > w + 50 || pr.y > h + 50 || pr.age > 12) this.spawn(pr);
    }
  }

  onPointer(input: PointerInput): void {
    const hit = this.charges.find((c) => Math.hypot(c.x - input.x, c.y - input.y) < CHARGE_R + 4);
    const secondary = input.button === 2 || input.shift;
    if (input.type === "down") {
      if (hit && secondary) {
        this.charges.splice(this.charges.indexOf(hit), 1);
      } else if (hit) {
        this.dragging = hit;
      } else {
        const c = { x: input.x, y: input.y, q: secondary ? -1 : 1 };
        this.charges.push(c);
        this.dragging = c;
      }
      this.dirty = true;
    } else if (input.type === "move" && this.dragging) {
      this.dragging.x = input.x;
      this.dragging.y = input.y;
      this.dirty = true;
    } else if (input.type === "up") {
      this.dragging = null;
    }
  }

  onNote(ev: NoteEvent): void {
    const { width: w, height: h } = this.view;
    if (ev.role === "kick") {
      // Kicks blow every probe outward from the middle.
      for (const pr of this.probes) {
        const dx = pr.x - w / 2, dy = pr.y - h / 2;
        const d = Math.hypot(dx, dy) + 1;
        pr.vx += (dx / d) * 380 * ev.velocity;
        pr.vy += (dy / d) * 380 * ev.velocity;
      }
      return;
    }
    if (this.charges.length === 0 || this.probes.length === 0) return;
    // Notes fire the charge nearest their pitch position (left to right),
    // spraying a ring of probes out of it.
    const sorted = [...this.charges].sort((a, b) => a.x - b.x);
    const c = sorted[Math.min(sorted.length - 1, Math.floor(ev.x * sorted.length))];
    c.flash = ev.velocity;
    const n = ev.role === "hat" ? 12 : 40;
    for (let i = 0; i < n; i++) {
      const pr = this.probes[(Math.random() * this.probes.length) | 0];
      const a = (i / n) * Math.PI * 2;
      pr.x = c.x + Math.cos(a) * (CHARGE_R + 3);
      pr.y = c.y + Math.sin(a) * (CHARGE_R + 3);
      pr.vx = Math.cos(a) * 500 * ev.velocity;
      pr.vy = Math.sin(a) * 500 * ev.velocity;
      pr.age = 0;
    }
  }

  private rebuild(): void {
    const { width: w, height: h } = this.view;
    const cols = Math.ceil(w / POT_CELL), rows = Math.ceil(h / POT_CELL);
    if (!this.potential || this.potential.width !== cols || this.potential.height !== rows) {
      this.potential = new Raster(cols, rows);
    }
    const px = this.potential.pixels;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * POT_CELL, y = (j + 0.5) * POT_CELL;
        let v = 0;
        for (const c of this.charges) v += c.q / Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2 + SOFT);
        const t = Math.tanh(v * 25);
        const base = 13, a = Math.abs(t);
        px[j * cols + i] = t > 0
          ? rgb(base + 150 * a, base + 30 * a, base + 40 * a)
          : rgb(base + 20 * a, base + 70 * a, base + 170 * a);
      }
    }

    // Field lines: start evenly around each positive charge and follow E.
    this.lines = [];
    const perCharge = 16;
    for (const c of this.charges) {
      if (c.q <= 0) continue;
      const n = Math.round(perCharge * c.q);
      for (let s = 0; s < n; s++) {
        const a = (s / n) * Math.PI * 2;
        let x = c.x + Math.cos(a) * CHARGE_R, y = c.y + Math.sin(a) * CHARGE_R;
        const pts: number[] = [x, y];
        for (let it = 0; it < 700; it++) {
          const [ex, ey] = this.field(x, y);
          const m = Math.hypot(ex, ey);
          if (m === 0) break;
          x += (ex / m) * 4;
          y += (ey / m) * 4;
          pts.push(x, y);
          if (x < -200 || y < -200 || x > w + 200 || y > h + 200) break;
          if (this.charges.some((o) => o.q < 0 && (o.x - x) ** 2 + (o.y - y) ** 2 < CHARGE_R * CHARGE_R)) break;
        }
        this.lines.push(new Float32Array(pts));
      }
    }
    this.dirty = false;
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    if (this.dirty) this.rebuild();
    if (p.showPotential && this.potential) {
      this.potential.draw(g, this.potential.width * POT_CELL, this.potential.height * POT_CELL, true);
    }
    if (p.showLines) {
      g.strokeStyle = "rgba(255,255,255,0.22)";
      g.lineWidth = 1;
      g.beginPath();
      for (const l of this.lines) {
        g.moveTo(l[0], l[1]);
        for (let i = 2; i < l.length; i += 2) g.lineTo(l[i], l[i + 1]);
      }
      g.stroke();
    }

    g.lineWidth = 1.5;
    g.lineCap = "round";
    g.strokeStyle = "hsl(50 100% 70%)";
    g.beginPath();
    for (const pr of this.probes) {
      g.moveTo(pr.x, pr.y);
      // The tiny offset keeps a resting probe visible as a round dot.
      g.lineTo(pr.x - pr.vx * 0.03, pr.y - pr.vy * 0.03 + 0.01);
    }
    g.stroke();
    g.lineWidth = 1;
    g.lineCap = "butt";

    for (const c of this.charges) {
      if (c.flash && c.flash > 0.02) {
        g.beginPath();
        g.arc(c.x, c.y, CHARGE_R + 4 + (1 - c.flash) * 30, 0, Math.PI * 2);
        g.strokeStyle = `rgba(255,240,180,${c.flash})`;
        g.lineWidth = 2;
        g.stroke();
        g.lineWidth = 1;
        c.flash *= 0.9;
      }
      g.beginPath();
      g.arc(c.x, c.y, CHARGE_R, 0, Math.PI * 2);
      g.fillStyle = c.q > 0 ? "hsl(0 75% 55%)" : "hsl(215 80% 55%)";
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.stroke();
      g.fillStyle = "#fff";
      g.fillRect(c.x - 6, c.y - 1.5, 12, 3);
      if (c.q > 0) g.fillRect(c.x - 1.5, c.y - 6, 3, 12);
    }
  }

  stats(): string {
    const pos = this.charges.filter((c) => c.q > 0).length;
    return `${pos} positive · ${this.charges.length - pos} negative`;
  }
}

export const charges: ModelDefinition = {
  id: "charges",
  name: "Electric field",
  category: "Particle physics",
  description: "Point charges create a Coulomb field. Positive probe particles stream from + to - along the field lines.",
  hint: "Click to place a + charge, right-click or Shift-click for a - charge. Drag charges to move them; right-click one to delete it. Notes make a charge spray probes, picked left to right by pitch.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "layout", label: "Layout", default: "dipole", resetOnChange: true,
      options: [
        { value: "dipole", label: "Dipole" },
        { value: "quadrupole", label: "Quadrupole" },
        { value: "capacitor", label: "Parallel plates" },
        { value: "random", label: "Random" },
        { value: "empty", label: "Empty" },
      ],
    },
    { kind: "number", key: "probes", label: "Probe particles", min: 0, max: 3000, step: 50, default: 1200, resetOnChange: true },
    { kind: "number", key: "strength", label: "Field strength", min: 0.1, max: 5, step: 0.1, default: 1.5 },
    { kind: "number", key: "drag", label: "Drag", min: 0, max: 10, step: 0.1, default: 2 },
    { kind: "boolean", key: "showPotential", label: "Show potential", default: true },
    { kind: "boolean", key: "showLines", label: "Show field lines", default: true },
  ],
  macros: [
    { key: "surge", label: "Surge", targets: [{ param: "strength", amount: 0.5 }, { param: "drag", amount: -0.15 }] },
    { key: "syrup", label: "Syrup", targets: [{ param: "drag", amount: 0.6 }] },
  ],
  modulations: [{ source: "kick", target: "strength", amount: 0.2 }],
  create: () => new ChargesSim(),
};
