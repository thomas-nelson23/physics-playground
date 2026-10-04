import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, palette } from "./lib/raster";

const SPONGE = 14; // cells of absorbing border so waves leave instead of echoing

/**
 * A ripple tank: the 2D wave equation on a grid, solved with an explicit
 * finite-difference scheme. Walls reflect, the border absorbs, and the
 * presets set up classic optics experiments (slits, a lens-like dish).
 */
class WavesSim implements SimulationModel {
  private cols = 0;
  private rows = 0;
  private cell = 4;
  private u = new Float32Array(0);
  private prev = new Float32Array(0);
  private wall = new Uint8Array(0);
  private absorb = new Float32Array(0);
  private raster: Raster | null = null;
  private time = 0;
  private source: { x: number; y: number } | null = null;
  private painting: { erase: boolean; lx: number; ly: number } | null = null;
  private lut = palette([
    [0, 40, 120, 255],
    [0.38, 10, 30, 70],
    [0.5, 8, 12, 22],
    [0.62, 80, 35, 10],
    [1, 255, 200, 90],
  ]);

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.cols = Math.max(8, Math.ceil(view.width / this.cell));
    this.rows = Math.max(8, Math.ceil(view.height / this.cell));
    const n = this.cols * this.rows;
    this.u = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.wall = new Uint8Array(n);
    this.absorb = new Float32Array(n);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const d = Math.min(x, y, this.cols - 1 - x, this.rows - 1 - y);
        this.absorb[y * this.cols + x] = d < SPONGE ? ((SPONGE - d) / SPONGE) ** 2 * 0.15 : 0;
      }
    }
    this.raster = new Raster(this.cols, this.rows);
    this.time = 0;
    this.buildSetup(p.setup as string);
  }

  private buildSetup(setup: string): void {
    const { cols, rows } = this;
    const wx = Math.floor(cols * 0.38);
    const mid = rows / 2;
    const slitW = Math.max(2, Math.round(rows * 0.03));
    const setWall = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < cols && y < rows) this.wall[y * cols + x] = 1;
    };
    if (setup === "double" || setup === "single") {
      const gaps = setup === "double" ? [mid - rows * 0.08, mid + rows * 0.08] : [mid];
      for (let y = 0; y < rows; y++) {
        if (gaps.some((g) => Math.abs(y - g) < slitW)) continue;
        setWall(wx, y);
        setWall(wx + 1, y);
      }
    } else if (setup === "dish") {
      // A parabolic reflector: plane waves from the left focus to a point.
      const vx = Math.floor(cols * 0.8);
      const f = cols * 0.18;
      for (let y = Math.floor(rows * 0.1); y < rows * 0.9; y++) {
        const dy = y - mid;
        const x = Math.round(vx - (dy * dy) / (4 * f));
        setWall(x, y);
        setWall(x + 1, y);
      }
    }
  }

  step(dt: number, p: ParamValues): void {
    const { cols, rows, wall, absorb } = this;
    const c2 = (p.speed as number) ** 2 * 0.5; // <= 0.5 keeps the scheme stable
    const damping = 1 - (p.damping as number) * 0.01;
    const omega = (p.frequency as number) * Math.PI * 2;
    for (let sub = 0; sub < 2; sub++) {
      this.time += dt / 2;
      const drive = Math.sin(this.time * omega);
      if (p.setup !== "open" && p.planeWave) {
        // A line source near the left edge, just inside the absorbing border.
        const x = SPONGE + 2;
        for (let y = SPONGE; y < rows - SPONGE; y++) this.u[y * cols + x] = drive * 1.2;
      }
      if (this.source) {
        const sx = Math.floor(this.source.x / this.cell), sy = Math.floor(this.source.y / this.cell);
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const x = sx + ox, y = sy + oy;
            if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) this.u[y * cols + x] = drive * 2;
          }
        }
      }
      const u = this.u, prev = this.prev;
      for (let y = 1; y < rows - 1; y++) {
        const row = y * cols;
        for (let x = 1; x < cols - 1; x++) {
          const i = row + x;
          if (wall[i]) { prev[i] = 0; continue; }
          const lap = u[i - 1] + u[i + 1] + u[i - cols] + u[i + cols] - 4 * u[i];
          prev[i] = (2 * u[i] - prev[i] + c2 * lap) * damping * (1 - absorb[i]);
        }
      }
      this.prev = u;
      this.u = prev;
    }
  }

  onPointer(input: PointerInput): void {
    const erase = input.shift && input.button === 2;
    const drawWall = input.button === 2 || input.shift;
    if (input.type === "down") {
      if (drawWall) this.painting = { erase, lx: input.x, ly: input.y };
      else this.source = { x: input.x, y: input.y };
    }
    if (input.type === "move") {
      if (this.source) this.source = { x: input.x, y: input.y };
    }
    if (this.painting && input.type !== "up") {
      // Interpolate along the drag so fast strokes leave solid walls.
      const { lx, ly } = this.painting;
      const steps = Math.max(1, Math.ceil(Math.hypot(input.x - lx, input.y - ly) / (this.cell / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = Math.floor((lx + ((input.x - lx) * s) / steps) / this.cell);
        const y = Math.floor((ly + ((input.y - ly) * s) / steps) / this.cell);
        for (let oy = 0; oy <= 1; oy++) {
          for (let ox = 0; ox <= 1; ox++) {
            const cx = x + ox, cy = y + oy;
            if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) continue;
            const i = cy * this.cols + cx;
            this.wall[i] = this.painting.erase ? 0 : 1;
            this.u[i] = 0;
            this.prev[i] = 0;
          }
        }
      }
      this.painting.lx = input.x;
      this.painting.ly = input.y;
    }
    if (input.type === "up") {
      this.source = null;
      this.painting = null;
    }
  }

  render(g: CanvasRenderingContext2D): void {
    if (!this.raster) return;
    const px = this.raster.pixels, { u, wall, lut } = this;
    const wallColor = 0xffd0c8c0;
    for (let i = 0; i < u.length; i++) {
      if (wall[i]) { px[i] = wallColor; continue; }
      const v = Math.max(-1, Math.min(1, u[i]));
      px[i] = lut[((v + 1) * 127.5) | 0];
    }
    this.raster.draw(g, this.cols * this.cell, this.rows * this.cell, true);
  }

  stats(): string {
    return `${this.cols}×${this.rows} grid`;
  }
}

export const waves: ModelDefinition = {
  id: "waves",
  name: "Ripple tank",
  category: "Waves & fluids",
  description: "The 2D wave equation. Watch diffraction and interference through slits, or focus plane waves with a parabolic mirror.",
  hint: "Hold the mouse to make an oscillating source and drag it around. Right-drag or Shift-drag draws walls; Shift + right-drag erases them.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "setup", label: "Experiment", default: "double", resetOnChange: true,
      options: [
        { value: "double", label: "Double slit" },
        { value: "single", label: "Single slit" },
        { value: "dish", label: "Parabolic mirror" },
        { value: "open", label: "Open water" },
      ],
    },
    { kind: "boolean", key: "planeWave", label: "Plane wave source", default: true },
    { kind: "number", key: "frequency", label: "Frequency", min: 0.5, max: 8, step: 0.1, default: 3 },
    { kind: "number", key: "speed", label: "Wave speed", min: 0.2, max: 1, step: 0.05, default: 0.9 },
    { kind: "number", key: "damping", label: "Damping", min: 0, max: 2, step: 0.05, default: 0.1 },
    { kind: "number", key: "cellSize", label: "Cell size", min: 2, max: 8, step: 1, default: 4, resetOnChange: true },
  ],
  create: () => new WavesSim(),
};
