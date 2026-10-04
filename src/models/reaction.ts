import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, palette } from "./lib/raster";

/** Feed and kill rates for well-known Gray–Scott regimes. */
const PRESETS: Record<string, [number, number]> = {
  coral: [0.0545, 0.062],
  mitosis: [0.0367, 0.0649],
  fingerprints: [0.037, 0.06],
  maze: [0.029, 0.057],
  bubbles: [0.098, 0.0555],
  waves: [0.014, 0.045],
};

const PALETTES: Record<string, Uint32Array> = {
  ocean: palette([[0, 8, 12, 22], [0.25, 10, 60, 110], [0.5, 40, 170, 200], [0.75, 210, 240, 230], [1, 255, 255, 255]]),
  ember: palette([[0, 10, 6, 6], [0.3, 120, 20, 10], [0.6, 240, 120, 30], [1, 255, 240, 180]]),
  bio: palette([[0, 6, 10, 8], [0.35, 30, 90, 40], [0.65, 150, 220, 80], [1, 240, 255, 200]]),
};

/**
 * Gray–Scott reaction–diffusion: two chemicals diffuse at different rates
 * while one feeds on the other. Tiny changes to the feed and kill rates
 * produce spots, stripes, mazes and self-replicating cells, the same
 * mechanism Turing proposed for animal coat patterns.
 */
class ReactionSim implements SimulationModel {
  private w = 0;
  private h = 0;
  private cell = 3;
  private a = new Float32Array(0);
  private b = new Float32Array(0);
  private na = new Float32Array(0);
  private nb = new Float32Array(0);
  private feed = new Float32Array(0);
  private kill = new Float32Array(0);
  private raster: Raster | null = null;
  private brush: { x: number; y: number; erase: boolean } | null = null;
  private steps = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.w = Math.max(8, Math.ceil(view.width / this.cell));
    this.h = Math.max(8, Math.ceil(view.height / this.cell));
    const n = this.w * this.h;
    this.a = new Float32Array(n).fill(1);
    this.b = new Float32Array(n);
    this.na = new Float32Array(n);
    this.nb = new Float32Array(n);
    this.feed = new Float32Array(n);
    this.kill = new Float32Array(n);
    this.raster = new Raster(this.w, this.h);
    this.steps = 0;
    this.applyPattern(p.pattern as string);
    // Seed a scattering of chemical-B blobs to get things started.
    const seeds = p.pattern === "map" ? 60 : 14;
    for (let s = 0; s < seeds; s++) {
      this.paint(Math.random() * this.w, Math.random() * this.h, 3 + Math.random() * 5, false);
    }
  }

  private applyPattern(pattern: string): void {
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (pattern === "map") {
          // Kill rate varies left to right, feed rate bottom to top: a live map of every regime.
          this.kill[i] = 0.045 + (x / w) * 0.025;
          this.feed[i] = 0.01 + (1 - y / h) * 0.09;
        } else {
          const [f, k] = PRESETS[pattern] ?? PRESETS.coral;
          this.feed[i] = f;
          this.kill[i] = k;
        }
      }
    }
  }

  private paint(cx: number, cy: number, r: number, erase: boolean): void {
    const { w, h } = this;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = ((y + h) % h) * w + ((x + w) % w);
        if (erase) { this.a[i] = 1; this.b[i] = 0; }
        else { this.a[i] = 0.5; this.b[i] = 0.25 + Math.random() * 0.05; }
      }
    }
  }

  step(_dt: number, p: ParamValues): void {
    if (this.brush) this.paint(this.brush.x / this.cell, this.brush.y / this.cell, (p.brush as number) / this.cell, this.brush.erase);
    const iters = p.speed as number;
    const { w, h, feed, kill } = this;
    const dA = 1.0, dB = 0.5;
    for (let it = 0; it < iters; it++) {
      const a = this.a, b = this.b, na = this.na, nb = this.nb;
      for (let y = 0; y < h; y++) {
        const up = ((y - 1 + h) % h) * w, mid = y * w, down = ((y + 1) % h) * w;
        for (let x = 0; x < w; x++) {
          const l = x === 0 ? w - 1 : x - 1, r = x === w - 1 ? 0 : x + 1;
          const i = mid + x;
          // 9-point Laplacian: 0.2 for edges, 0.05 for corners.
          const lapA = 0.2 * (a[up + x] + a[down + x] + a[mid + l] + a[mid + r])
            + 0.05 * (a[up + l] + a[up + r] + a[down + l] + a[down + r]) - a[i];
          const lapB = 0.2 * (b[up + x] + b[down + x] + b[mid + l] + b[mid + r])
            + 0.05 * (b[up + l] + b[up + r] + b[down + l] + b[down + r]) - b[i];
          const abb = a[i] * b[i] * b[i];
          na[i] = a[i] + dA * lapA - abb + feed[i] * (1 - a[i]);
          nb[i] = b[i] + dB * lapB + abb - (kill[i] + feed[i]) * b[i];
        }
      }
      this.a = na; this.na = a;
      this.b = nb; this.nb = b;
    }
    this.steps += iters;
  }

  onPointer(input: PointerInput): void {
    this.brush = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, erase: input.button === 2 || input.shift }
      : null;
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    if (!this.raster) return;
    const lut = PALETTES[p.palette as string] ?? PALETTES.ocean;
    const px = this.raster.pixels, { a, b } = this;
    for (let i = 0; i < px.length; i++) {
      const v = Math.max(0, Math.min(1, (a[i] - b[i]) * -1.6 + 1.25));
      px[i] = lut[(v * 255) | 0];
    }
    this.raster.draw(g, this.w * this.cell, this.h * this.cell, true);
  }

  stats(): string {
    return `${this.steps.toLocaleString()} reaction steps`;
  }
}

export const reaction: ModelDefinition = {
  id: "reaction",
  name: "Reaction–diffusion",
  category: "Algorithmic",
  description: "Gray–Scott chemistry: two diffusing chemicals grow coral, spots, mazes and dividing cells, like Turing's animal-skin patterns.",
  hint: "Drag to drop chemical B and grow new patterns. Right-drag or Shift-drag to wipe an area clean.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "pattern", label: "Pattern", default: "coral", resetOnChange: true,
      options: [
        { value: "coral", label: "Coral" },
        { value: "mitosis", label: "Cell division" },
        { value: "fingerprints", label: "Fingerprints" },
        { value: "maze", label: "Maze" },
        { value: "bubbles", label: "Bubbles" },
        { value: "waves", label: "Chaotic waves" },
        { value: "map", label: "Map of every pattern" },
      ],
    },
    {
      kind: "choice", key: "palette", label: "Colours", default: "ocean",
      options: [
        { value: "ocean", label: "Ocean" },
        { value: "ember", label: "Ember" },
        { value: "bio", label: "Bioluminescent" },
      ],
    },
    { kind: "number", key: "speed", label: "Steps per frame", min: 1, max: 24, step: 1, default: 8 },
    { kind: "number", key: "brush", label: "Brush size", min: 4, max: 60, step: 1, default: 14 },
    { kind: "number", key: "cellSize", label: "Cell size", min: 2, max: 8, step: 1, default: 4, resetOnChange: true },
  ],
  create: () => new ReactionSim(),
};
