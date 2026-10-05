import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash } from "./lib/music";
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
    const df = (p.feedShift as number) || 0;
    const dk = (p.killShift as number) || 0;
    // Explicit Euler with this 9-point stencil is stable for diffusion up to
    // about 1.25 (less once the reaction terms are added), so cap it at 1.05.
    const scale = Math.min(1.05, Math.max(0.05, (p.diffusion as number) || 1));
    const dA = 1.0 * scale, dB = 0.5 * scale;
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
          const f = Math.max(0, feed[i] + df), k = Math.max(0, kill[i] + dk);
          na[i] = a[i] + dA * lapA - abb + f * (1 - a[i]);
          nb[i] = b[i] + dB * lapB + abb - (k + f) * b[i];
        }
      }
      this.a = na; this.na = a;
      this.b = nb; this.nb = b;
    }
    this.steps += iters;
  }

  onNote(ev: NoteEvent): void {
    const { w, h } = this;
    if (ev.role === "tone") {
      this.paint(w * (0.05 + ev.x * 0.9), h * (0.1 + noteHash(ev.note) * 0.8), 2 + ev.velocity * 4, false);
    } else if (ev.role === "kick") {
      // A thin ring of chemical B around the centre, which grows outward.
      const r = Math.min(w, h) * (0.15 + Math.random() * 0.2);
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        this.paint(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 1.5 + ev.velocity, false);
      }
    } else if (ev.role === "snare") {
      // Snares wipe a hole the pattern has to regrow into.
      this.paint(Math.random() * w, Math.random() * h, 4 + ev.velocity * 6, true);
    }
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
    // Contrast stretches the a-b difference around the same midpoint as before.
    const c = (p.contrast as number) || 1.6;
    const off = 0.5 + (1.25 - 0.5) * (c / 1.6);
    for (let i = 0; i < px.length; i++) {
      const v = Math.max(0, Math.min(1, (a[i] - b[i]) * -c + off));
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
  hint: "Drag to drop chemical B and grow new patterns. Right-drag or Shift-drag to wipe an area clean. Notes seed new growth by pitch, kicks seed rings, snares wipe holes.",
  fixedDt: 1 / 60,
  params: [
    { kind: "number", key: "feedShift", label: "Feed shift", min: -0.02, max: 0.02, step: 0.0005, default: 0, group: "Behaviour",
      description: "Nudges how fast fresh chemical is fed in. Up floods with growth, down starves it." },
    { kind: "number", key: "killShift", label: "Kill shift", min: -0.008, max: 0.008, step: 0.0002, default: 0, group: "Behaviour",
      description: "Nudges how fast the pattern dies off. Down spreads blobs, up erodes into dots." },
    { kind: "number", key: "diffusion", label: "Pattern scale", min: 0.2, max: 1.05, step: 0.01, default: 1, group: "Behaviour",
      description: "How far the chemicals spread. Lower makes finer, tighter patterns." },
    { kind: "number", key: "speed", label: "Steps per frame", min: 1, max: 32, step: 1, default: 8, group: "Behaviour",
      description: "How many reaction steps run each frame, i.e. how fast patterns grow." },
    {
      kind: "choice", key: "palette", label: "Colours", default: "ocean", group: "Look",
      description: "Colour scheme for the chemicals.",
      options: [
        { value: "ocean", label: "Ocean" },
        { value: "ember", label: "Ember" },
        { value: "bio", label: "Bioluminescent" },
      ],
    },
    { kind: "number", key: "contrast", label: "Contrast", min: 0.4, max: 5, step: 0.05, default: 1.6, group: "Look",
      description: "How sharply the pattern's edges stand out. High values glow and saturate." },
    { kind: "number", key: "brush", label: "Brush size", min: 4, max: 150, step: 1, default: 14, group: "Brush",
      description: "Size of the area you seed or wipe when dragging." },
    {
      kind: "choice", key: "pattern", label: "Pattern", default: "coral", resetOnChange: true, group: "Setup",
      description: "Which feed and kill rates to start from. Each grows a different family of shapes.",
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
    { kind: "number", key: "cellSize", label: "Cell size", min: 2, max: 8, step: 1, default: 4, resetOnChange: true, group: "Setup",
      description: "Pixels per simulation cell. Smaller is sharper but slower. Restarts the pattern." },
  ],
  macros: [
    { key: "grow", label: "Growth", targets: [{ param: "speed", amount: 0.8 }, { param: "contrast", amount: 0.2 }] },
    { key: "bloom", label: "Bloom", targets: [{ param: "killShift", amount: -0.6 }, { param: "feedShift", amount: 0.3 }, { param: "contrast", amount: 0.3 }] },
    { key: "dissolve", label: "Dissolve", targets: [{ param: "killShift", amount: 0.6 }, { param: "feedShift", amount: -0.3 }, { param: "diffusion", amount: -0.5 }] },
  ],
  modulations: [
    { source: "kick", target: "speed", amount: 0.5 },
    { source: "snare", target: "killShift", amount: 0.3 },
    { source: "tone", target: "feedShift", amount: 0.25 },
    { source: "lfoBar", target: "diffusion", amount: -0.4 },
    { source: "bass", target: "contrast", amount: 0.4 },
  ],
  reactions: [
    { role: "tone", text: "Seeds a blob of growth, placed by pitch" },
    { role: "kick", text: "Seeds a ring of growth around the centre" },
    { role: "snare", text: "Wipes a random hole for the pattern to regrow into" },
  ],
  create: () => new ReactionSim(),
};
