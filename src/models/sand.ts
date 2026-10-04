import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, rgb } from "./lib/raster";

const EMPTY = 0, SAND = 1, WATER = 2, WALL = 3, PLANT = 4, FIRE = 5, SMOKE = 6, LAVA = 7, STEAM = 8, STONE = 9;

const BRUSH: Record<string, number> = {
  sand: SAND, water: WATER, wall: WALL, plant: PLANT, fire: FIRE, lava: LAVA, erase: EMPTY,
};

/** Base colours per material; each cell gets a little random shade. */
const COLORS: [number, number, number][] = [];
COLORS[SAND] = [222, 190, 120];
COLORS[WATER] = [50, 120, 230];
COLORS[WALL] = [120, 120, 130];
COLORS[PLANT] = [60, 180, 70];
COLORS[FIRE] = [255, 120, 30];
COLORS[SMOKE] = [70, 70, 75];
COLORS[LAVA] = [240, 70, 20];
COLORS[STEAM] = [190, 205, 220];
COLORS[STONE] = [85, 75, 80];

/**
 * A falling-sand cellular automaton. Each cell holds a material with simple
 * local rules: sand piles, water flows, plants grow into water, fire burns
 * plants and lifts smoke, lava turns water to steam and cools into stone.
 */
class SandSim implements SimulationModel {
  private w = 0;
  private h = 0;
  private cell = 4;
  private grid = new Uint8Array(0);
  /** Per-cell lifetime counter (fire, smoke, steam) and colour jitter. */
  private life = new Uint8Array(0);
  private shade = new Uint8Array(0);
  /** Frame parity marks cells already moved this tick so nothing moves twice. */
  private moved = new Uint8Array(0);
  private tick = 0;
  private raster: Raster | null = null;
  private brush: { x: number; y: number; erase: boolean } | null = null;
  private palette = new Uint32Array(0);

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.w = Math.max(8, Math.floor(view.width / this.cell));
    this.h = Math.max(8, Math.floor(view.height / this.cell));
    const n = this.w * this.h;
    this.grid = new Uint8Array(n);
    this.life = new Uint8Array(n);
    this.shade = new Uint8Array(n);
    this.moved = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.shade[i] = (Math.random() * 16) | 0;
    this.raster = new Raster(this.w, this.h);
    // Precompute 16 shades of each material.
    this.palette = new Uint32Array(16 * 16);
    for (let m = 0; m < COLORS.length; m++) {
      const c = COLORS[m];
      for (let s = 0; s < 16; s++) {
        const f = 0.82 + s * 0.024;
        this.palette[m * 16 + s] = c ? rgb(c[0] * f, c[1] * f, c[2] * f) : rgb(13, 17, 23);
      }
    }
    if (p.scene) this.buildScene();
  }

  /** A small starter world: two ledges, a pool, a plant bed and a lava pocket. */
  private buildScene(): void {
    const { w, h } = this;
    const fill = (x0: number, y0: number, x1: number, y1: number, m: number) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, y1); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) this.grid[y * w + x] = m;
      }
    };
    fill(w * 0.1, h * 0.35, w * 0.4, h * 0.35 + 2, WALL);
    fill(w * 0.6, h * 0.55, w * 0.92, h * 0.55 + 2, WALL);
    fill(w * 0.15, h * 0.15, w * 0.3, h * 0.33, SAND);
    fill(w * 0.6, h * 0.85, w * 0.95, h, WATER);
    fill(w * 0.58, h * 0.8, w * 0.6, h, WALL);
    fill(w * 0.65, h * 0.4, w * 0.85, h * 0.55, WATER);
    fill(w * 0.25, h * 0.96, w * 0.45, h, PLANT);
    fill(w * 0.05, h * 0.9, w * 0.15, h, LAVA);
  }

  private get(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? WALL : this.grid[y * this.w + x];
  }

  private move(i: number, j: number): void {
    const g = this.grid, l = this.life, s = this.shade;
    const t = g[j]; g[j] = g[i]; g[i] = t;
    const tl = l[j]; l[j] = l[i]; l[i] = tl;
    const ts = s[j]; s[j] = s[i]; s[i] = ts;
    this.moved[j] = this.tick;
  }

  private set(i: number, m: number, life = 0): void {
    this.grid[i] = m;
    this.life[i] = life;
    this.moved[i] = this.tick;
  }

  step(_dt: number, p: ParamValues): void {
    if (this.brush) this.paint(p);
    const iters = p.speed as number;
    for (let k = 0; k < iters; k++) this.update();
  }

  private update(): void {
    const { w, h, grid } = this;
    this.tick = (this.tick % 254) + 1;
    const tick = this.tick;
    const leftFirst = tick % 2 === 0;
    // Bottom-up so falling things don't teleport; alternate direction each tick to avoid drift.
    for (let y = h - 1; y >= 0; y--) {
      for (let k = 0; k < w; k++) {
        const x = leftFirst ? k : w - 1 - k;
        const i = y * w + x;
        const m = grid[i];
        if (m === EMPTY || m === WALL || m === STONE || this.moved[i] === tick) continue;
        const dir = Math.random() < 0.5 ? -1 : 1;
        switch (m) {
          case SAND: this.fall(x, y, i, dir, false); break;
          case WATER: this.fall(x, y, i, dir, true); break;
          case LAVA: if (Math.random() < 0.5) this.lava(x, y, i, dir); break;
          case PLANT: this.plant(x, y); break;
          case FIRE: this.fire(x, y, i, dir); break;
          case SMOKE: case STEAM: this.gas(x, y, i, dir, m); break;
        }
      }
    }
  }

  /** Sand and water fall, slide diagonally, and (water / lava) spread sideways. */
  private fall(x: number, y: number, i: number, dir: number, liquid: boolean): boolean {
    const w = this.w;
    const below = this.get(x, y + 1);
    if (below === EMPTY || (!liquid && (below === WATER || below === STEAM || below === SMOKE))) { this.move(i, i + w); return true; }
    const d1 = this.get(x + dir, y + 1), d2 = this.get(x - dir, y + 1);
    const ok = (c: number) => c === EMPTY || (!liquid && c === WATER);
    if (ok(d1)) { this.move(i, i + w + dir); return true; }
    if (ok(d2)) { this.move(i, i + w - dir); return true; }
    if (liquid) {
      // Spread up to a few cells sideways so puddles level out quickly.
      for (const d of [dir, -dir]) {
        let reach = 0;
        while (reach < 4 && this.get(x + d * (reach + 1), y) === EMPTY) reach++;
        if (reach > 0) { this.move(i, i + d * reach); return true; }
      }
    }
    return false;
  }

  private lava(x: number, y: number, i: number, dir: number): void {
    // Lava touching water: the water boils off and the lava hardens.
    for (const [ox, oy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + ox, ny = y + oy;
      const n = this.get(nx, ny);
      const j = ny * this.w + nx;
      if (n === WATER) { this.set(j, STEAM, 60 + ((Math.random() * 60) | 0)); this.set(i, STONE); return; }
      if (n === PLANT && Math.random() < 0.3) this.set(j, FIRE, 30 + ((Math.random() * 40) | 0));
    }
    if (Math.random() < 0.0005) { this.set(i, STONE); return; }
    this.fall(x, y, i, dir, true);
  }

  private plant(x: number, y: number): void {
    // Plants drink adjacent water and grow into it.
    if (Math.random() > 0.08) return;
    const ox = ((Math.random() * 3) | 0) - 1, oy = ((Math.random() * 3) | 0) - 1;
    if (this.get(x + ox, y + oy) === WATER) this.set((y + oy) * this.w + x + ox, PLANT);
  }

  private fire(x: number, y: number, i: number, dir: number): void {
    const w = this.w;
    for (const [ox, oy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, -1], [-1, -1]]) {
      const n = this.get(x + ox, y + oy);
      const j = (y + oy) * w + x + ox;
      if (n === PLANT && Math.random() < 0.12) this.set(j, FIRE, 40 + ((Math.random() * 40) | 0));
      else if (n === WATER) { this.set(i, STEAM, 40); this.set(j, Math.random() < 0.5 ? STEAM : WATER, 40); return; }
    }
    if (this.life[i] === 0 || --this.life[i] === 0) {
      this.set(i, Math.random() < 0.4 ? SMOKE : EMPTY, 60 + ((Math.random() * 60) | 0));
      return;
    }
    // Flames flicker upward.
    const up = this.get(x + (Math.random() < 0.5 ? dir : 0), y - 1);
    if (up === EMPTY && Math.random() < 0.6) this.move(i, i - w + (this.grid[i - w] === EMPTY ? 0 : dir));
  }

  private gas(x: number, y: number, i: number, dir: number, m: number): void {
    const w = this.w;
    if (--this.life[i] === 0) {
      // When it cools, steam usually condenses back into rain.
      this.set(i, m === STEAM && Math.random() < 0.6 ? WATER : EMPTY);
      return;
    }
    const nx = x + (Math.random() < 0.6 ? dir : 0);
    if (this.get(nx, y - 1) === EMPTY) this.move(i, i - w + (nx - x));
    else if (this.get(x + dir, y) === EMPTY) this.move(i, i + dir);
  }

  private paint(p: ParamValues): void {
    if (!this.brush) return;
    const material = this.brush.erase ? EMPTY : BRUSH[p.material as string] ?? SAND;
    const cx = this.brush.x / this.cell, cy = this.brush.y / this.cell;
    const r = (p.brush as number) / this.cell;
    const solid = material === WALL || material === EMPTY || material === PLANT;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        // Loose materials pour in as a sprinkle; solid ones paint fully.
        if (!solid && Math.random() > 0.35) continue;
        const i = y * this.w + x;
        if (!solid && this.grid[i] !== EMPTY) continue;
        this.grid[i] = material;
        this.life[i] = material === FIRE ? 40 + ((Math.random() * 60) | 0) : 0;
      }
    }
  }

  onPointer(input: PointerInput): void {
    this.brush = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, erase: input.button === 2 || input.shift }
      : null;
  }

  render(g: CanvasRenderingContext2D): void {
    if (!this.raster) return;
    const px = this.raster.pixels, { grid, shade, life, palette } = this;
    const flicker = this.tick;
    for (let i = 0; i < grid.length; i++) {
      const m = grid[i];
      if (m === FIRE) {
        // Fire shifts from yellow to red as it burns out.
        const t = Math.min(1, life[i] / 60);
        px[i] = rgb(255, 60 + 170 * t + ((i + flicker) % 5) * 6, 20 + 40 * t);
      } else {
        px[i] = palette[m * 16 + shade[i]];
      }
    }
    this.raster.draw(g, this.w * this.cell, this.h * this.cell, false);
  }

  stats(): string {
    let n = 0;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] !== EMPTY) n++;
    return `${n.toLocaleString()} grains`;
  }
}

export const sand: ModelDefinition = {
  id: "sand",
  name: "Falling sand",
  category: "Algorithmic",
  description: "A falling-sand world: sand piles, water flows, plants drink water and burn, lava boils water into steam that rains back down.",
  hint: "Drag to pour the chosen material. Right-drag or Shift-drag erases.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "material", label: "Brush material", default: "sand",
      options: [
        { value: "sand", label: "Sand" },
        { value: "water", label: "Water" },
        { value: "wall", label: "Wall" },
        { value: "plant", label: "Plant" },
        { value: "fire", label: "Fire" },
        { value: "lava", label: "Lava" },
        { value: "erase", label: "Eraser" },
      ],
    },
    { kind: "number", key: "brush", label: "Brush size", min: 2, max: 60, step: 1, default: 14 },
    { kind: "number", key: "speed", label: "Updates per frame", min: 1, max: 4, step: 1, default: 2 },
    { kind: "number", key: "cellSize", label: "Grain size", min: 2, max: 8, step: 1, default: 4, resetOnChange: true },
    { kind: "boolean", key: "scene", label: "Start with a scene", default: true, resetOnChange: true },
  ],
  create: () => new SandSim(),
};
