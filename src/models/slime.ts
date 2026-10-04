import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, palette } from "./lib/raster";

const PALETTES: Record<string, Uint32Array> = {
  gold: palette([[0, 13, 17, 23], [0.2, 60, 40, 10], [0.55, 230, 170, 40], [1, 255, 250, 210]]),
  neon: palette([[0, 13, 17, 23], [0.25, 40, 20, 90], [0.6, 200, 60, 220], [1, 220, 255, 255]]),
  moss: palette([[0, 13, 17, 23], [0.3, 20, 70, 50], [0.65, 90, 210, 130], [1, 230, 255, 220]]),
};

/**
 * Physarum (slime mould) transport networks. Thousands of agents each sniff
 * a pheromone trail with three forward sensors, turn toward the strongest,
 * step forward and deposit more trail. The trail diffuses and decays, and
 * out of that feedback loop grow branching vein networks.
 */
class SlimeSim implements SimulationModel {
  private w = 0;
  private h = 0;
  private cell = 2;
  private ax = new Float32Array(0);
  private ay = new Float32Array(0);
  private ah = new Float32Array(0);
  private trail = new Float32Array(0);
  private tmp = new Float32Array(0);
  private raster: Raster | null = null;
  private brush: { x: number; y: number; erase: boolean } | null = null;

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.w = Math.max(8, Math.ceil(view.width / this.cell));
    this.h = Math.max(8, Math.ceil(view.height / this.cell));
    this.trail = new Float32Array(this.w * this.h);
    this.tmp = new Float32Array(this.w * this.h);
    this.raster = new Raster(this.w, this.h);
    const n = p.agents as number;
    this.ax = new Float32Array(n);
    this.ay = new Float32Array(n);
    this.ah = new Float32Array(n);
    const cx = this.w / 2, cy = this.h / 2, R = Math.min(this.w, this.h) * 0.35;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      if (p.spawn === "ring") {
        // On a circle, facing inward: they collapse into a web.
        const r = R * Math.sqrt(Math.random());
        this.ax[i] = cx + Math.cos(a) * r;
        this.ay[i] = cy + Math.sin(a) * r;
        this.ah[i] = a + Math.PI;
      } else if (p.spawn === "center") {
        const r = Math.random() * 4;
        this.ax[i] = cx + Math.cos(a) * r;
        this.ay[i] = cy + Math.sin(a) * r;
        this.ah[i] = a;
      } else {
        this.ax[i] = Math.random() * this.w;
        this.ay[i] = Math.random() * this.h;
        this.ah[i] = a;
      }
    }
  }

  private sense(x: number, y: number, heading: number, dist: number): number {
    const { w, h } = this;
    let sx = Math.floor(x + Math.cos(heading) * dist), sy = Math.floor(y + Math.sin(heading) * dist);
    sx = ((sx % w) + w) % w;
    sy = ((sy % h) + h) % h;
    return this.trail[sy * w + sx];
  }

  step(dt: number, p: ParamValues): void {
    const { w, h, ax, ay, ah, trail } = this;
    const sa = ((p.sensorAngle as number) * Math.PI) / 180;
    const sd = (p.sensorDistance as number) / this.cell;
    const turn = ((p.turnSpeed as number) * Math.PI) / 180;
    const speed = ((p.speed as number) / this.cell) * dt;
    const deposit = 3 * dt * 60;

    if (this.brush) {
      // Food attracts the mould; the eraser clears trail so the network must regrow.
      const cx = this.brush.x / this.cell, cy = this.brush.y / this.cell, r = 20 / this.cell + 3;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          trail[y * w + x] = this.brush.erase ? 0 : 60;
        }
      }
    }

    for (let i = 0; i < ax.length; i++) {
      const x = ax[i], y = ay[i], hd = ah[i];
      const f = this.sense(x, y, hd, sd);
      const l = this.sense(x, y, hd - sa, sd);
      const r = this.sense(x, y, hd + sa, sd);
      let nh = hd;
      if (f > l && f > r) {
        // Keep going straight.
      } else if (f < l && f < r) {
        nh += (Math.random() < 0.5 ? -1 : 1) * turn;
      } else if (l > r) {
        nh -= turn;
      } else if (r > l) {
        nh += turn;
      }
      nh += (Math.random() - 0.5) * 0.1;
      let nx = x + Math.cos(nh) * speed, ny = y + Math.sin(nh) * speed;
      if (nx < 0) nx += w; else if (nx >= w) nx -= w;
      if (ny < 0) ny += h; else if (ny >= h) ny -= h;
      ax[i] = nx;
      ay[i] = ny;
      ah[i] = nh;
      const k = (ny | 0) * w + (nx | 0);
      trail[k] = Math.min(100, trail[k] + deposit);
    }

    // Diffuse with a 3x3 box blur, then decay.
    const decay = 1 - (p.decay as number) * dt;
    const t = this.tmp;
    for (let y = 0; y < h; y++) {
      const up = ((y - 1 + h) % h) * w, mid = y * w, down = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) {
        const l = x === 0 ? w - 1 : x - 1, r = x === w - 1 ? 0 : x + 1;
        const sum = trail[up + l] + trail[up + x] + trail[up + r]
          + trail[mid + l] + trail[mid + x] + trail[mid + r]
          + trail[down + l] + trail[down + x] + trail[down + r];
        t[mid + x] = (trail[mid + x] * 0.5 + (sum / 9) * 0.5) * decay;
      }
    }
    this.tmp = trail;
    this.trail = t;
  }

  onPointer(input: PointerInput): void {
    this.brush = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, erase: input.button === 2 || input.shift }
      : null;
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    if (!this.raster) return;
    const lut = PALETTES[p.palette as string] ?? PALETTES.gold;
    const px = this.raster.pixels, trail = this.trail;
    for (let i = 0; i < px.length; i++) {
      const v = 1 - Math.exp(-trail[i] * 0.03);
      px[i] = lut[(v * 255) | 0];
    }
    this.raster.draw(g, this.w * this.cell, this.h * this.cell, true);
  }

  stats(): string {
    return `${this.ax.length.toLocaleString()} agents`;
  }
}

export const slime: ModelDefinition = {
  id: "slime",
  name: "Slime mould",
  category: "Algorithmic",
  description: "Physarum agents follow and lay pheromone trails, self-organising into glowing transport networks.",
  hint: "Drag to drop food the mould will grow toward. Right-drag or Shift-drag to wipe its trails.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "spawn", label: "Start", default: "ring", resetOnChange: true,
      options: [
        { value: "ring", label: "Disc, facing inward" },
        { value: "center", label: "Single point" },
        { value: "random", label: "Scattered" },
      ],
    },
    {
      kind: "choice", key: "palette", label: "Colours", default: "gold",
      options: [
        { value: "gold", label: "Gold" },
        { value: "neon", label: "Neon" },
        { value: "moss", label: "Moss" },
      ],
    },
    { kind: "number", key: "agents", label: "Agents", min: 1000, max: 80000, step: 1000, default: 30000, resetOnChange: true },
    { kind: "number", key: "sensorAngle", label: "Sensor angle (°)", min: 5, max: 90, step: 1, default: 30 },
    { kind: "number", key: "sensorDistance", label: "Sensor distance", min: 2, max: 60, step: 1, default: 18 },
    { kind: "number", key: "turnSpeed", label: "Turn angle (°)", min: 5, max: 90, step: 1, default: 25 },
    { kind: "number", key: "speed", label: "Speed", min: 10, max: 200, step: 5, default: 70 },
    { kind: "number", key: "decay", label: "Trail decay", min: 0.1, max: 6, step: 0.1, default: 1.5 },
    { kind: "number", key: "cellSize", label: "Cell size", min: 1, max: 6, step: 1, default: 2, resetOnChange: true },
  ],
  create: () => new SlimeSim(),
};
