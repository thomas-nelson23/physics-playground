import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash } from "./lib/music";
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
    // The explicit scheme is only stable for c^2 <= 0.5 per step, so faster
    // waves take more, smaller substeps instead of a bigger c.
    const speed = Math.max(0.01, p.speed as number);
    const subs = 2 * Math.ceil(speed);
    const c2 = (speed / Math.ceil(speed)) ** 2 * 0.5;
    // Damping is spread over the substeps so it is per second, whatever the speed.
    const damping = 1 - (p.damping as number) * 0.02 / subs;
    const omega = (p.frequency as number) * Math.PI * 2;
    const amp = p.amplitude as number;
    for (let sub = 0; sub < subs; sub++) {
      this.time += dt / subs;
      const drive = Math.sin(this.time * omega) * amp;
      if (p.setup !== "open" && p.planeWave) {
        // A line source near the left edge, just inside the absorbing border.
        const x = SPONGE + 2;
        for (let y = SPONGE; y < rows - SPONGE; y++) this.u[y * cols + x] = drive;
      }
      if (this.source) {
        const sx = Math.floor(this.source.x / this.cell), sy = Math.floor(this.source.y / this.cell);
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const x = sx + ox, y = sy + oy;
            if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) this.u[y * cols + x] = drive * 1.7;
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

  /** Lift a smooth bump of water; it spreads out as a ring. */
  private drop(px: number, py: number, radius: number, height: number): void {
    const { cols, rows } = this;
    const cx = px / this.cell, cy = py / this.cell;
    for (let y = Math.max(1, Math.floor(cy - radius)); y < Math.min(rows - 1, cy + radius); y++) {
      for (let x = Math.max(1, Math.floor(cx - radius)); x < Math.min(cols - 1, cx + radius); x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d >= 1) continue;
        const i = y * cols + x;
        if (this.wall[i]) continue;
        const v = height * 0.5 * (1 + Math.cos(Math.PI * d));
        this.u[i] += v;
        this.prev[i] += v;
      }
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const w = this.cols * this.cell, h = this.rows * this.cell;
    const k = p.noteSize as number;
    if (k <= 0) return;
    // Bigger drops are wider as well as taller, so they read as bigger splashes.
    const r = (base: number) => base * (0.6 + 0.4 * k);
    if (ev.role === "kick") this.drop(w * 0.6, h / 2, r(9), 3 * ev.velocity * k);
    else if (ev.role === "snare") this.drop(w * (0.45 + Math.random() * 0.45), h * (0.15 + Math.random() * 0.7), r(5), 2 * ev.velocity * k);
    else if (ev.role === "hat") this.drop(w * (0.45 + Math.random() * 0.45), h * (0.15 + Math.random() * 0.7), r(2.5), ev.velocity * k);
    // Melody notes rain down on the right of the tank, placed by pitch.
    else this.drop(w * (0.42 + ev.x * 0.5), h * (0.2 + noteHash(ev.note) * 0.6), r(4 + ev.velocity * 3), 2.4 * ev.velocity * k);
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

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    if (!this.raster) return;
    const px = this.raster.pixels, { u, wall, lut } = this;
    const wallColor = 0xffd0c8c0;
    const gain = p.contrast as number;
    for (let i = 0; i < u.length; i++) {
      if (wall[i]) { px[i] = wallColor; continue; }
      const v = Math.max(-1, Math.min(1, u[i] * gain));
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
  hint: "Hold the mouse to make an oscillating source and drag it around. Right-drag or Shift-drag draws walls; Shift + right-drag erases them. Notes drop ripples into the tank; kicks make big ones.",
  fixedDt: 1 / 60,
  params: [
    { kind: "boolean", key: "planeWave", label: "Plane wave source", default: true, group: "Motion",
      description: "A wavemaker along the left edge sending straight wavefronts across the tank." },
    { kind: "number", key: "frequency", label: "Frequency", min: 0.1, max: 16, step: 0.1, default: 3, group: "Motion",
      description: "How fast the sources wobble. Higher packs the ripples closer together." },
    { kind: "number", key: "amplitude", label: "Source strength", min: 0, max: 4, step: 0.05, default: 1.2, group: "Motion",
      description: "How tall the waves from the wavemaker and your mouse are." },
    { kind: "number", key: "speed", label: "Wave speed", min: 0.05, max: 2.5, step: 0.05, default: 0.9, group: "Motion",
      description: "How fast ripples travel. Low is slow motion; high races across the tank." },
    { kind: "number", key: "damping", label: "Damping", min: 0, max: 6, step: 0.05, default: 0.1, group: "Motion",
      description: "How quickly ripples die away. High values leave only waves near their source." },
    { kind: "number", key: "noteSize", label: "Note splash size", min: 0, max: 4, step: 0.05, default: 1, group: "Motion",
      description: "How big the ripples dropped by notes and drums are. 0 turns them off." },
    { kind: "number", key: "contrast", label: "Contrast", min: 0.2, max: 6, step: 0.05, default: 1, group: "Look",
      description: "Brightens faint ripples. High values turn the tank into sharp bands." },
    {
      kind: "choice", key: "setup", label: "Experiment", default: "double", resetOnChange: true, group: "Setup",
      description: "Which walls the tank starts with. Changing it clears the water.",
      options: [
        { value: "double", label: "Double slit" },
        { value: "single", label: "Single slit" },
        { value: "dish", label: "Parabolic mirror" },
        { value: "open", label: "Open water" },
      ],
    },
    { kind: "number", key: "cellSize", label: "Cell size", min: 2, max: 12, step: 1, default: 4, resetOnChange: true, group: "Setup",
      description: "Size of each grid square. Small is sharp but slower; large is blocky and fast." },
  ],
  macros: [
    { key: "chop", label: "Chop", targets: [{ param: "frequency", amount: 0.5 }, { param: "amplitude", amount: 0.3 }] },
    { key: "calm", label: "Calm", targets: [{ param: "damping", amount: 0.6 }, { param: "contrast", amount: -0.1 }] },
    { key: "surge", label: "Surge", targets: [{ param: "speed", amount: 0.6 }, { param: "amplitude", amount: 0.5 }, { param: "contrast", amount: 0.4 }, { param: "noteSize", amount: 0.5 }] },
  ],
  modulations: [
    { source: "kick", target: "contrast", amount: 0.3 },
    { source: "snare", target: "amplitude", amount: 0.3 },
    { source: "pitch", target: "frequency", amount: 0.25 },
    { source: "lfoBar", target: "speed", amount: 0.2 },
    { source: "bass", target: "amplitude", amount: 0.4 },
  ],
  reactions: [
    { role: "kick", text: "Drops a big ripple right of the slits" },
    { role: "snare", text: "Drops a medium ripple at a random spot on the right" },
    { role: "hat", text: "Drops a small ripple at a random spot on the right" },
    { role: "tone", text: "Drops a ripple placed left to right by pitch" },
  ],
  create: () => new WavesSim(),
};
