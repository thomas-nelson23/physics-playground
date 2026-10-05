import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, hsl, rgb } from "./lib/raster";
import { noteHue } from "./lib/music";

/** Velocity cap in cells per second (about five cells per step at 60 Hz). */
const MAX_SPEED = 300;

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
        const power = p.jetPower as number;
        // Stronger jets also carry a little more dye so they stay visible.
        const ink = 0.15 * Math.min(2.5, 0.5 + power / 80);
        this.splat(cx, cy, Math.cos(a) * power, Math.sin(a) * power, [r * ink, g * ink, b * ink], Math.max(1.5, radius * 0.6), true);
      }
    }

    if (p.vorticity) this.confine(dt, p.vorticity as number);
    this.project();
    this.advect(this.vx, this.tmpX, dt);
    this.advect(this.vy, this.tmpY, dt);
    [this.vx, this.tmpX] = [this.tmpX, this.vx];
    [this.vy, this.tmpY] = [this.tmpY, this.vy];
    this.project();

    const fade = Math.max(0, 1 - (p.fade as number) * dt);
    const visc = Math.max(0, 1 - (p.viscosity as number) * dt);
    // Strong swirl confinement feeds on itself; capping the speed (in cells/s)
    // keeps the top of the Swirl slider wild but bounded.
    const vmax = MAX_SPEED;
    const { vx, vy } = this;
    for (let i = 0; i < w * h; i++) {
      const x = vx[i] * visc, y = vy[i] * visc;
      vx[i] = x > vmax ? vmax : x < -vmax ? -vmax : x;
      vy[i] = y > vmax ? vmax : y < -vmax ? -vmax : y;
    }
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

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { w, h } = this;
    const radius = Math.max(1.5, (p.brush as number) / this.cell);
    const tint = (): [number, number, number] => {
      if (p.colors !== "rainbow") return this.colour(p.colors as string);
      const [r, g, b] = hsl(noteHue(ev.note), 0.9, 0.55);
      return [r / 255, g / 255, b / 255];
    };
    if (ev.role === "tone") {
      // A jet rising from the floor, placed left to right by pitch.
      const c = tint().map((v) => v * 1.4 * ev.velocity) as [number, number, number];
      this.splat(w * (0.1 + ev.x * 0.8), h * 0.88, 0, -260 * ev.velocity, c, radius);
    } else if (ev.role === "kick") {
      // A ring burst from the centre.
      const c = tint().map((v) => v * 0.5 * ev.velocity) as [number, number, number];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + this.time;
        this.splat(w / 2 + Math.cos(a) * radius * 2, h / 2 + Math.sin(a) * radius * 2, Math.cos(a) * 200 * ev.velocity, Math.sin(a) * 200 * ev.velocity, c, radius * 0.7);
      }
    } else {
      const a = Math.random() * Math.PI * 2;
      const c = ev.role === "snare" ? tint().map((v) => v * 0.6) as [number, number, number] : null;
      this.splat(Math.random() * w, Math.random() * h, Math.cos(a) * 150 * ev.velocity, Math.sin(a) * 150 * ev.velocity, c, radius * 0.5);
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

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    if (!this.raster) return;
    const px = this.raster.pixels;
    const [r, gr, b] = this.dye;
    const k = p.exposure as number;
    // Soft tone mapping keeps dense dye bright without hard clipping.
    for (let i = 0; i < px.length; i++) {
      px[i] = rgb(13 + 255 * (1 - Math.exp(-r[i] * k)), 17 + 255 * (1 - Math.exp(-gr[i] * k)), 23 + 255 * (1 - Math.exp(-b[i] * k)));
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
  hint: "Drag to stir in dye. Right-drag or Shift-drag stirs without adding dye. Notes fire jets of dye from the floor, coloured and placed by pitch; kicks burst a ring from the centre.",
  fixedDt: 1 / 60,
  params: [
    { kind: "boolean", key: "jets", label: "Ambient jets", default: true, group: "Forces",
      description: "Two slowly turning jets that keep the water moving when nobody stirs." },
    { kind: "number", key: "jetPower", label: "Jet power", min: 0, max: 200, step: 1, default: 40, group: "Forces",
      description: "How hard the ambient jets push. High values churn the whole tank." },
    { kind: "number", key: "vorticity", label: "Swirl (vorticity)", min: 0, max: 100, step: 0.5, default: 10, group: "Forces",
      description: "Feeds the small curls. High values boil the dye into tight eddies." },
    { kind: "number", key: "viscosity", label: "Viscosity", min: 0, max: 8, step: 0.05, default: 0.1, group: "Forces",
      description: "Thickness of the water. High values feel like syrup and stop flows fast." },
    {
      kind: "choice", key: "colors", label: "Dye", default: "rainbow", group: "Look",
      description: "Colour of the dye from the brush and jets. Rainbow colours notes by pitch.",
      options: [
        { value: "rainbow", label: "Rainbow" },
        { value: "fire", label: "Fire" },
        { value: "ink", label: "Ink" },
      ],
    },
    { kind: "number", key: "fade", label: "Dye fade", min: 0, max: 6, step: 0.05, default: 0.35, group: "Look",
      description: "How quickly dye disappears. 0 lets it build up into a dense cloud." },
    { kind: "number", key: "exposure", label: "Glow", min: 0.2, max: 6, step: 0.05, default: 1.4, group: "Look",
      description: "Brightness of the dye. High values make faint wisps glow." },
    { kind: "number", key: "brush", label: "Brush size", min: 4, max: 200, step: 1, default: 28, group: "Brush",
      description: "Width of your stirring brush, the jets and the note splashes." },
    { kind: "number", key: "cellSize", label: "Cell size", min: 4, max: 24, step: 1, default: 7, resetOnChange: true, group: "Setup",
      description: "Size of each grid square. Small gives fine detail but runs slower." },
  ],
  macros: [
    { key: "swirl", label: "Swirl", targets: [{ param: "vorticity", amount: 0.6 }, { param: "jetPower", amount: 0.3 }] },
    { key: "linger", label: "Linger", targets: [{ param: "fade", amount: -0.1 }, { param: "viscosity", amount: -0.05 }, { param: "exposure", amount: 0.25 }] },
    { key: "torrent", label: "Torrent", targets: [{ param: "jetPower", amount: 0.8 }, { param: "brush", amount: 0.3 }, { param: "vorticity", amount: 0.2 }] },
  ],
  modulations: [
    { source: "kick", target: "exposure", amount: 0.25 },
    { source: "env", target: "vorticity", amount: 0.3 },
    { source: "bass", target: "jetPower", amount: 0.4 },
    { source: "lfoBar", target: "brush", amount: 0.15 },
  ],
  reactions: [
    { role: "kick", text: "Bursts a ring of dye out from the centre" },
    { role: "snare", text: "Splashes dye in a random direction at a random spot" },
    { role: "hat", text: "Gives the water a quick undyed stir at a random spot" },
    { role: "tone", text: "Fires a jet of dye up from the floor, placed and coloured by pitch" },
  ],
  create: () => new FluidSim(),
};
