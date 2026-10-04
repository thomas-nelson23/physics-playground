import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, hsl, rgb } from "./lib/raster";

/**
 * Jos Stam's "stable fluids": an incompressible velocity field advected
 * semi-Lagrangian style and made divergence-free by a pressure projection,
 * carrying three channels of coloured dye. Vorticity confinement puts back
 * the small swirls that the coarse grid smooths away.
 */
class FluidSim implements SimulationModel {
  private w = 0;
  private h = 0;
  private cell = 8;
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private tmpX = new Float32Array(0);
  private tmpY = new Float32Array(0);
  private dye: Float32Array<ArrayBuffer>[] = [];
  private tmpDye = new Float32Array(0);
  private pressure = new Float32Array(0);
  private div = new Float32Array(0);
  private curl = new Float32Array(0);
  private raster: Raster | null = null;
  private pointer: { x: number; y: number; dx: number; dy: number; dye: boolean } | null = null;
  private time = 0;
  private hue = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.w = Math.max(8, Math.ceil(view.width / this.cell));
    this.h = Math.max(8, Math.ceil(view.height / this.cell));
    const n = this.w * this.h;
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.tmpX = new Float32Array(n);
    this.tmpY = new Float32Array(n);
    this.dye = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.tmpDye = new Float32Array(n);
    this.pressure = new Float32Array(n);
    this.div = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.raster = new Raster(this.w, this.h);
    this.time = 0;
  }

  /**
   * Push velocity and dye into a Gaussian blob. `blend` steers the velocity
   * toward (fx, fy) instead of adding to it, so a jet that fires every step
   * settles at a steady speed rather than accelerating forever.
   */
  private splat(cx: number, cy: number, fx: number, fy: number, color: [number, number, number] | null, radius: number, blend = false): void {
    const { w, h } = this;
    const r2 = radius * radius;
    const x0 = Math.max(1, Math.floor(cx - radius * 2)), x1 = Math.min(w - 2, Math.ceil(cx + radius * 2));
    const y0 = Math.max(1, Math.floor(cy - radius * 2)), y1 = Math.min(h - 2, Math.ceil(cy + radius * 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        const f = Math.exp(-d2 / r2);
        if (f < 0.01) continue;
        const i = y * w + x;
        if (blend) {
          this.vx[i] += (fx - this.vx[i]) * f * 0.5;
          this.vy[i] += (fy - this.vy[i]) * f * 0.5;
        } else {
          this.vx[i] += fx * f;
          this.vy[i] += fy * f;
        }
        if (color) for (let c = 0; c < 3; c++) this.dye[c][i] = Math.min(3, this.dye[c][i] + color[c] * f);
      }
    }
  }

  private colour(scheme: string): [number, number, number] {
    this.hue = (this.hue + 0.5) % 360;
    if (scheme === "ink") return [0.15, 0.55, 1.1];
    if (scheme === "fire") {
      const t = Math.random();
      return [1.4, 0.45 + t * 0.35, 0.08];
    }
    const [r, g, b] = hsl(this.hue, 0.9, 0.55);
    return [r / 255, g / 255, b / 255];
  }

  step(dt: number, p: ParamValues): void {
    const { w, h } = this;
    this.time += dt;
    const scheme = p.colors as string;
    const radius = (p.brush as number) / this.cell;

    if (this.pointer) {
      const { x, y, dx, dy, dye } = this.pointer;
      const s = 1 / this.cell / dt;
      this.splat(x / this.cell, y / this.cell, dx * s * 0.6, dy * s * 0.6, dye ? this.colour(scheme) : null, radius);
      this.pointer.dx = 0;
      this.pointer.dy = 0;
    }
    if (p.jets) {
      // Two slowly rotating jets keep the tank alive when nobody is stirring.
      const t = this.time;
      for (const side of [-1, 1]) {
        const a = t * 0.5 * side + (side > 0 ? Math.PI : 0);
        const cx = w / 2 + side * w * 0.25, cy = h / 2 + Math.sin(t * 0.7) * h * 0.15;
        const [r, g, b] = this.colour(scheme);
        this.splat(cx, cy, Math.cos(a) * 40, Math.sin(a) * 40, [r * 0.15, g * 0.15, b * 0.15], Math.max(1.5, radius * 0.6), true);
      }
    }

    if (p.vorticity) this.confine(dt, p.vorticity as number);
    this.project();
    this.advect(this.vx, this.tmpX, dt);
    this.advect(this.vy, this.tmpY, dt);
    [this.vx, this.tmpX] = [this.tmpX, this.vx];
    [this.vy, this.tmpY] = [this.tmpY, this.vy];
    this.project();

    const fade = 1 - (p.fade as number) * dt;
    const visc = 1 - (p.viscosity as number) * dt;
    for (let i = 0; i < w * h; i++) { this.vx[i] *= visc; this.vy[i] *= visc; }
    for (let c = 0; c < 3; c++) {
      this.advect(this.dye[c], this.tmpDye, dt);
      const d = this.tmpDye;
      for (let i = 0; i < d.length; i++) d[i] *= fade;
      [this.dye[c], this.tmpDye] = [this.tmpDye, this.dye[c]];
    }
  }

  /** Semi-Lagrangian advection: trace each cell back along the velocity. */
  private advect(src: Float32Array, dst: Float32Array, dt: number): void {
    const { w, h, vx, vy } = this;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let sx = x - vx[i] * dt, sy = y - vy[i] * dt;
        sx = Math.max(0.5, Math.min(w - 1.5, sx));
        sy = Math.max(0.5, Math.min(h - 1.5, sy));
        const x0 = sx | 0, y0 = sy | 0;
        const fx = sx - x0, fy = sy - y0;
        const j = y0 * w + x0;
        dst[i] = (src[j] * (1 - fx) + src[j + 1] * fx) * (1 - fy) + (src[j + w] * (1 - fx) + src[j + w + 1] * fx) * fy;
      }
    }
    this.edges(dst, 0);
  }

  /** Zero the normal velocity at the walls (mode 1 = x, 2 = y, 0 = copy). */
  private edges(f: Float32Array, mode: 0 | 1 | 2): void {
    const { w, h } = this;
    for (let x = 0; x < w; x++) {
      f[x] = mode === 2 ? -f[w + x] : f[w + x];
      f[(h - 1) * w + x] = mode === 2 ? -f[(h - 2) * w + x] : f[(h - 2) * w + x];
    }
    for (let y = 0; y < h; y++) {
      f[y * w] = mode === 1 ? -f[y * w + 1] : f[y * w + 1];
      f[y * w + w - 1] = mode === 1 ? -f[y * w + w - 2] : f[y * w + w - 2];
    }
  }

  /** Make the velocity field divergence-free (Gauss–Seidel pressure solve). */
  private project(): void {
    const { w, h, vx, vy, div, pressure } = this;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        div[i] = -0.5 * (vx[i + 1] - vx[i - 1] + vy[i + w] - vy[i - w]);
        pressure[i] = 0;
      }
    }
    this.edges(div, 0);
    this.edges(pressure, 0);
    for (let it = 0; it < 20; it++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          pressure[i] = (div[i] + pressure[i - 1] + pressure[i + 1] + pressure[i - w] + pressure[i + w]) / 4;
        }
      }
      this.edges(pressure, 0);
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        vx[i] -= 0.5 * (pressure[i + 1] - pressure[i - 1]);
        vy[i] -= 0.5 * (pressure[i + w] - pressure[i - w]);
      }
    }
    this.edges(vx, 1);
    this.edges(vy, 2);
  }

  private confine(dt: number, strength: number): void {
    const { w, h, vx, vy, curl } = this;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        curl[i] = 0.5 * (vy[i + 1] - vy[i - 1] - (vx[i + w] - vx[i - w]));
      }
    }
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const gx = 0.5 * (Math.abs(curl[i + 1]) - Math.abs(curl[i - 1]));
        const gy = 0.5 * (Math.abs(curl[i + w]) - Math.abs(curl[i - w]));
        const len = Math.hypot(gx, gy) + 1e-5;
        vx[i] += (gy / len) * curl[i] * strength * dt;
        vy[i] -= (gx / len) * curl[i] * strength * dt;
      }
    }
  }

  onPointer(input: PointerInput): void {
    if (input.type === "up" || !input.pressed) {
      this.pointer = null;
      return;
    }
    const dye = !(input.button === 2 || input.shift);
    if (input.type === "down" || !this.pointer) {
      this.pointer = { x: input.x, y: input.y, dx: 0, dy: 0, dye };
    } else {
      this.pointer.dx += input.x - this.pointer.x;
      this.pointer.dy += input.y - this.pointer.y;
      this.pointer.x = input.x;
      this.pointer.y = input.y;
    }
  }

  render(g: CanvasRenderingContext2D): void {
    if (!this.raster) return;
    const px = this.raster.pixels;
    const [r, gr, b] = this.dye;
    // Soft tone mapping keeps dense dye bright without hard clipping.
    for (let i = 0; i < px.length; i++) {
      px[i] = rgb(13 + 255 * (1 - Math.exp(-r[i] * 1.4)), 17 + 255 * (1 - Math.exp(-gr[i] * 1.4)), 23 + 255 * (1 - Math.exp(-b[i] * 1.4)));
    }
    this.raster.draw(g, this.w * this.cell, this.h * this.cell, true);
  }

  stats(): string {
    return `${this.w}×${this.h} grid`;
  }
}

export const fluid: ModelDefinition = {
  id: "fluid",
  name: "Ink in water",
  category: "Waves & fluids",
  description: "An incompressible fluid (Stam's stable fluids) carrying coloured dye. Vorticity confinement keeps the curls crisp.",
  hint: "Drag to stir in dye. Right-drag or Shift-drag stirs without adding dye.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "colors", label: "Dye", default: "rainbow",
      options: [
        { value: "rainbow", label: "Rainbow" },
        { value: "fire", label: "Fire" },
        { value: "ink", label: "Ink" },
      ],
    },
    { kind: "boolean", key: "jets", label: "Ambient jets", default: true },
    { kind: "number", key: "vorticity", label: "Swirl (vorticity)", min: 0, max: 30, step: 0.5, default: 10 },
    { kind: "number", key: "viscosity", label: "Viscosity", min: 0, max: 2, step: 0.05, default: 0.1 },
    { kind: "number", key: "fade", label: "Dye fade", min: 0, max: 2, step: 0.05, default: 0.35 },
    { kind: "number", key: "brush", label: "Brush size", min: 8, max: 80, step: 1, default: 28 },
    { kind: "number", key: "cellSize", label: "Cell size", min: 4, max: 16, step: 1, default: 7, resetOnChange: true },
  ],
  create: () => new FluidSim(),
};
