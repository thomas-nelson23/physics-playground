import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Raster, rgb } from "./lib/raster";
import { gravityModeParam, uniformDir } from "./lib/gravity";

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
 * The eight neighbour directions in ring order (down, down-left, left, ...),
 * so index k ± 1 is 45° either side of k, k ± 2 is square to it and k + 4 is
 * opposite. Gravity is quantised to one of these per cell.
 */
const DX = [0, -1, -1, -1, 0, 1, 1, 1];
const DY = [1, 1, 0, -1, -1, -1, 0, 1];
const NO_DIR = -1;

/** Nearest ring direction to the vector (vx, vy), or NO_DIR for a zero vector. */
function dirIndex(vx: number, vy: number): number {
  if (vx === 0 && vy === 0) return NO_DIR;
  const k = Math.round((Math.atan2(vy, vx) - Math.PI / 2) / (Math.PI / 4));
  return ((k % 8) + 8) % 8;
}

/** Point modes that this cellular world handles: each cell falls toward its own target. */
const POINT_MODES = new Set(["center", "outward", "corners", "walls"]);

interface Field {
  /** One direction for every cell, or per-cell directions for the point modes. */
  dir: number;
  map: Int8Array | null;
  /** Two scan orders, "floor" first, with ties broken in opposite directions. */
  orders: [Uint32Array, Uint32Array];
}

/**
 * A falling-sand cellular automaton. Each cell holds a material with simple
 * local rules: sand piles, water flows, plants grow into water, fire burns
 * plants and lifts smoke, lava turns water to steam and cools into stone.
 *
 * Gravity can point any of eight ways, or toward a point (centre, corners,
 * walls). Each update visits cells nearest the "floor" first, and cells
 * that already moved this tick are skipped, so a grain moves at most one
 * cell per update whichever way it falls. Gases rise against gravity.
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
  private time = 0;
  private raster: Raster | null = null;
  private brush: { x: number; y: number; erase: boolean } | null = null;
  private palette = new Uint32Array(0);
  private paletteHue = NaN;
  /** Scan orders and direction maps, built on first use for each gravity setting. */
  private fields = new Map<string, Field>();
  private fall = 1;

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
    this.fields.clear();
    this.paletteHue = NaN;
    this.time = 0;
    if (p.scene) this.buildScene();
  }

  /** 16 shades of each material, hue-rotated by `deg`. */
  private buildPalette(deg: number): void {
    this.palette = new Uint32Array(16 * 16);
    // Standard hue-rotation matrix (as in CSS hue-rotate), luminance-preserving.
    const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const m = [
      0.213 + c * 0.787 - sn * 0.213, 0.715 - c * 0.715 - sn * 0.715, 0.072 - c * 0.072 + sn * 0.928,
      0.213 - c * 0.213 + sn * 0.143, 0.715 + c * 0.285 + sn * 0.14, 0.072 - c * 0.072 - sn * 0.283,
      0.213 - c * 0.213 - sn * 0.787, 0.715 - c * 0.715 + sn * 0.715, 0.072 + c * 0.928 + sn * 0.072,
    ];
    for (let k = 0; k < COLORS.length; k++) {
      const col = COLORS[k];
      for (let s = 0; s < 16; s++) {
        const f = 0.82 + s * 0.024;
        if (!col) { this.palette[k * 16 + s] = rgb(13, 17, 23); continue; }
        const [r, g, b] = col;
        this.palette[k * 16 + s] = rgb(
          (m[0] * r + m[1] * g + m[2] * b) * f,
          (m[3] * r + m[4] * g + m[5] * b) * f,
          (m[6] * r + m[7] * g + m[8] * b) * f,
        );
      }
    }
    this.paletteHue = deg;
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

  /** The direction gravity pulls everywhere right now, for the uniform modes. */
  private uniformIndex(mode: string): number {
    if (mode === "off") return NO_DIR;
    const [gx, gy] = uniformDir(mode, this.time);
    // Round small components away so "down" is exactly down.
    return dirIndex(Math.abs(gx) < 1e-6 ? 0 : gx, Math.abs(gy) < 1e-6 ? 0 : gy);
  }

  /**
   * Build (or fetch) the scan order and directions for a gravity setting.
   * Cells are counting-sorted by distance from the "floor" so the ones that
   * land first move first and columns fall together without gaps.
   */
  private field(mode: string): Field {
    const point = POINT_MODES.has(mode);
    const dir = point ? NO_DIR : this.uniformIndex(mode);
    const key = point ? mode : `u${dir}`;
    const cached = this.fields.get(key);
    if (cached) return cached;
    const { w, h } = this;
    const n = w * h;
    const keys = new Int32Array(n);
    const map = point ? new Int8Array(n) : null;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const far = Math.ceil(Math.hypot(cx, cy));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let k = 0;
        if (!point) {
          if (dir !== NO_DIR) {
            const dx = DX[dir], dy = DY[dir];
            k = (dx > 0 ? w - 1 - x : dx < 0 ? x : 0) + (dy > 0 ? h - 1 - y : dy < 0 ? y : 0);
          }
        } else if (mode === "walls") {
          const dl = x, dr = w - 1 - x, dt = y, db = h - 1 - y;
          k = Math.min(dl, dr, dt, db);
          map![i] = k === db ? 0 : k === dt ? 4 : k === dl ? 2 : 6;
        } else {
          let tx = cx, ty = cy;
          if (mode === "corners") { tx = x < w / 2 ? 0 : w - 1; ty = y < h / 2 ? 0 : h - 1; }
          const vx = tx - x, vy = ty - y;
          const d = Math.hypot(vx, vy);
          if (mode === "outward") {
            k = far - Math.floor(d);
            map![i] = d < 0.75 ? NO_DIR : dirIndex(-vx, -vy);
          } else {
            k = Math.floor(d);
            map![i] = d < 0.75 ? NO_DIR : dirIndex(vx, vy);
          }
        }
        keys[i] = k;
      }
    }
    // Stable counting sort, once forward and once backward, for the two tie orders.
    let maxKey = 0;
    for (let i = 0; i < n; i++) if (keys[i] > maxKey) maxKey = keys[i];
    const sortBy = (reverse: boolean): Uint32Array => {
      const count = new Uint32Array(maxKey + 2);
      for (let i = 0; i < n; i++) count[keys[i] + 1]++;
      for (let k = 1; k < count.length; k++) count[k] += count[k - 1];
      const out = new Uint32Array(n);
      for (let t = 0; t < n; t++) {
        const i = reverse ? n - 1 - t : t;
        out[count[keys[i]]++] = i;
      }
      return out;
    };
    const f: Field = { dir, map, orders: [sortBy(false), sortBy(true)] };
    this.fields.set(key, f);
    return f;
  }

  private get(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? WALL : this.grid[y * this.w + x];
  }

  /** Material one step from (x, y) in ring direction k (WALL off the edge). */
  private look(x: number, y: number, k: number): number {
    return this.get(x + DX[k], y + DY[k]);
  }

  /** Grid index one step from cell i in direction k. Only valid after `look` found it in bounds. */
  private off(i: number, k: number): number {
    return i + DY[k] * this.w + DX[k];
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

  step(dt: number, p: ParamValues): void {
    this.time += dt;
    if (this.brush) this.paint(p);
    const hue = p.hue as number;
    if (Math.abs(hue - this.paletteHue) > 0.5 || Number.isNaN(this.paletteHue)) this.buildPalette(hue);
    // Cap the cell visits per frame so small grains at high speed stay smooth.
    const n = this.w * this.h;
    const iters = Math.max(1, Math.min(Math.round(p.speed as number), Math.ceil(1_200_000 / n)));
    const mode = p.gravityMode as string;
    this.fall = Math.max(0, Math.min(1, p.gravity as number));
    const f = this.field(mode);
    for (let k = 0; k < iters; k++) this.update(f);
  }

  private update(f: Field): void {
    const { w, grid, moved } = this;
    this.tick = (this.tick % 254) + 1;
    const tick = this.tick;
    // Alternate the tie order each tick to avoid sideways drift.
    const order = f.orders[tick & 1];
    const map = f.map;
    const fall = this.fall;
    for (let t = 0; t < order.length; t++) {
      const i = order[t];
      const m = grid[i];
      if (m === EMPTY || m === WALL || m === STONE || moved[i] === tick) continue;
      const y = (i / w) | 0, x = i - y * w;
      const d = map ? map[i] : f.dir;
      const side = Math.random() < 0.5 ? -1 : 1;
      switch (m) {
        case SAND: if (fall >= 1 || Math.random() < fall) this.fallMove(x, y, i, d, side, false); break;
        case WATER: if (fall >= 1 || Math.random() < fall) this.fallMove(x, y, i, d, side, true); break;
        case LAVA: if (Math.random() < 0.5) this.lava(x, y, i, d, side); break;
        case PLANT: this.plant(x, y); break;
        case FIRE: this.fire(x, y, i, d, side); break;
        case SMOKE: case STEAM: this.gas(x, y, i, d, side, m); break;
      }
    }
  }

  /**
   * Sand and liquids fall along d, slide 45° either side of it, and liquids
   * spread square to it. With no gravity, liquids wander and sand stays put.
   */
  private fallMove(x: number, y: number, i: number, d: number, side: number, liquid: boolean): boolean {
    if (d === NO_DIR) {
      if (!liquid || Math.random() > 0.3) return false;
      const k = (Math.random() * 8) | 0;
      if (this.look(x, y, k) === EMPTY) { this.move(i, this.off(i, k)); return true; }
      return false;
    }
    const below = this.look(x, y, d);
    if (below === EMPTY || (!liquid && (below === WATER || below === STEAM || below === SMOKE))) { this.move(i, this.off(i, d)); return true; }
    const k1 = (d + side + 8) & 7, k2 = (d - side + 8) & 7;
    const ok = (c: number) => c === EMPTY || (!liquid && c === WATER);
    if (ok(this.look(x, y, k1))) { this.move(i, this.off(i, k1)); return true; }
    if (ok(this.look(x, y, k2))) { this.move(i, this.off(i, k2)); return true; }
    if (liquid) {
      // Spread up to a few cells sideways so puddles level out quickly.
      for (const k of [(d + 2 * side + 8) & 7, (d - 2 * side + 8) & 7]) {
        const dx = DX[k], dy = DY[k];
        let reach = 0;
        while (reach < 4 && this.get(x + dx * (reach + 1), y + dy * (reach + 1)) === EMPTY) reach++;
        if (reach > 0) { this.move(i, i + reach * (dy * this.w + dx)); return true; }
      }
    }
    return false;
  }

  private lava(x: number, y: number, i: number, d: number, side: number): void {
    // Lava touching water: the water boils off and the lava hardens.
    for (const k of [0, 4, 2, 6]) {
      const n = this.look(x, y, k);
      if (n === WALL) continue;
      const j = this.off(i, k);
      if (n === WATER) { this.set(j, STEAM, 60 + ((Math.random() * 60) | 0)); this.set(i, STONE); return; }
      if (n === PLANT && Math.random() < 0.3) this.set(j, FIRE, 30 + ((Math.random() * 40) | 0));
    }
    if (Math.random() < 0.0005) { this.set(i, STONE); return; }
    if (this.fall >= 1 || Math.random() < this.fall) this.fallMove(x, y, i, d, side, true);
  }

  private plant(x: number, y: number): void {
    // Plants drink adjacent water and grow into it.
    if (Math.random() > 0.08) return;
    const ox = ((Math.random() * 3) | 0) - 1, oy = ((Math.random() * 3) | 0) - 1;
    if (this.get(x + ox, y + oy) === WATER) this.set((y + oy) * this.w + x + ox, PLANT);
  }

  /** "Up" for flames and gases: against gravity, or a random way when there is none. */
  private upDir(d: number): number {
    return d === NO_DIR ? (Math.random() * 8) | 0 : (d + 4) & 7;
  }

  private fire(x: number, y: number, i: number, d: number, side: number): void {
    const up = this.upDir(d);
    // Burn everything around except the two cells diagonally underneath
    // (listed for downward gravity, then turned to match it).
    for (const k of [0, 4, 2, 6, 3, 5]) {
      const kk = d === NO_DIR ? k : (k + d) & 7;
      const n = this.look(x, y, kk);
      if (n === WALL) continue;
      const j = this.off(i, kk);
      if (n === PLANT && Math.random() < 0.12) this.set(j, FIRE, 40 + ((Math.random() * 40) | 0));
      else if (n === WATER) { this.set(i, STEAM, 40); this.set(j, Math.random() < 0.5 ? STEAM : WATER, 40); return; }
    }
    if (this.life[i] === 0 || --this.life[i] === 0) {
      this.set(i, Math.random() < 0.4 ? SMOKE : EMPTY, 60 + ((Math.random() * 60) | 0));
      return;
    }
    // Flames flicker upward.
    const k = Math.random() < 0.5 ? up : (up + side + 8) & 7;
    if (Math.random() < 0.6 && this.look(x, y, k) === EMPTY) this.move(i, this.off(i, k));
  }

  private gas(x: number, y: number, i: number, d: number, side: number, m: number): void {
    if (--this.life[i] === 0) {
      // When it cools, steam usually condenses back into rain.
      this.set(i, m === STEAM && Math.random() < 0.6 ? WATER : EMPTY);
      return;
    }
    // Weaker gravity means weaker buoyancy too.
    if (this.fall < 1 && Math.random() > this.fall) return;
    const up = this.upDir(d);
    const k = Math.random() < 0.6 ? (up + side + 8) & 7 : up;
    const across = (up + 2 * side + 8) & 7;
    if (this.look(x, y, k) === EMPTY) this.move(i, this.off(i, k));
    else if (this.look(x, y, across) === EMPTY) this.move(i, this.off(i, across));
  }

  private paint(p: ParamValues): void {
    if (!this.brush) return;
    const material = this.brush.erase ? EMPTY : BRUSH[p.material as string] ?? SAND;
    this.pour(this.brush.x / this.cell, this.brush.y / this.cell, (p.brush as number) / this.cell, material);
  }

  /** Fill a disc (in grid cells) with a material. Loose materials sprinkle. */
  private pour(cx: number, cy: number, r: number, material: number): void {
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

  /**
   * Where notes pour from: a point along the "ceiling" opposite gravity, `t`
   * (0..1) of the way along it. Point modes pour from the top edge (centre)
   * or across the middle (the outward modes).
   */
  private spout(t: number, mode: string): [number, number] {
    const { w, h } = this;
    const along = 0.05 + t * 0.9;
    if (mode === "outward" || mode === "corners" || mode === "walls") return [w * along, h / 2];
    const k = mode === "center" ? 0 : this.uniformIndex(mode);
    if (k === NO_DIR) return [w * along, h / 2];
    const dx = DX[k], dy = DY[k];
    // Cardinal parts decide which edge is the ceiling; diagonals use the first one.
    if (dy !== 0 && (dx === 0 || Math.random() < 0.5)) return [w * along, dy > 0 ? 3 : h - 4];
    return [dx > 0 ? 3 : w - 4, h * along];
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    // Keep a song from filling the whole world.
    let filled = 0;
    for (let i = 0; i < this.grid.length; i += 7) if (this.grid[i] !== EMPTY) filled++;
    if (filled * 7 > this.grid.length * 0.6) return;
    const { w, h } = this;
    const size = p.notePour as number;
    if (size <= 0) return;
    const r = (1.5 + ev.velocity * 3) * size;
    const mode = p.gravityMode as string;
    if (ev.role === "tone") {
      // Notes pour the brush material from the ceiling, placed by pitch.
      const m = BRUSH[p.material as string] || SAND;
      const [x, y] = this.spout(ev.x, mode);
      this.pour(x, y, r, m === WALL || m === PLANT ? SAND : m);
    } else if (ev.role === "kick") {
      const [x, y] = this.spout(0.15 + Math.random() * 0.7, mode);
      this.pour(x, y, r + size, WATER);
    } else if (ev.role === "snare") {
      // A spark that lands on whatever is below and may set plants alight.
      this.pour(Math.random() * w, h * (0.3 + Math.random() * 0.5), 1.2 * Math.max(1, size), FIRE);
    }
  }

  onPointer(input: PointerInput): void {
    this.brush = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, erase: input.button === 2 || input.shift }
      : null;
  }

  render(g: CanvasRenderingContext2D): void {
    if (!this.raster) return;
    if (Number.isNaN(this.paletteHue)) this.buildPalette(0);
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
  hint: "Drag to pour the chosen material. Right-drag or Shift-drag erases. Notes pour the chosen material from the ceiling, kicks pour water, snares throw sparks. Try pointing gravity at the centre.",
  fixedDt: 1 / 60,
  params: [
    gravityModeParam("down", ["down", "up", "left", "right", "spin", "center", "outward", "corners", "walls", "off"], {
      description: "Which way everything falls. Smoke and steam rise the opposite way.",
    }),
    { kind: "number", key: "gravity", label: "Gravity strength", min: 0.05, max: 1, step: 0.05, default: 1, group: "Gravity",
      description: "How eagerly grains fall and gases rise. Low values drift like the Moon." },
    {
      kind: "choice", key: "material", label: "Brush material", default: "sand", group: "Brush",
      description: "What your brush and the melody notes pour.",
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
    { kind: "number", key: "brush", label: "Brush size", min: 2, max: 160, step: 1, default: 14, group: "Brush",
      description: "Width of the brush when you drag on the canvas." },
    { kind: "number", key: "notePour", label: "Note pour size", min: 0, max: 5, step: 0.1, default: 1, group: "Brush",
      description: "How much each note and drum pours in. 0 stops the music adding anything." },
    { kind: "number", key: "speed", label: "Updates per frame", min: 1, max: 10, step: 1, default: 2, group: "Simulation",
      description: "Simulation speed. Higher makes everything fall and burn faster." },
    { kind: "number", key: "hue", label: "Colour shift", min: 0, max: 360, step: 1, default: 0, group: "Simulation",
      description: "Rotates every material's colour around the colour wheel." },
    { kind: "number", key: "cellSize", label: "Grain size", min: 2, max: 16, step: 1, default: 4, resetOnChange: true, group: "Setup",
      description: "Size of each grain on screen. Changing it clears the world." },
    { kind: "boolean", key: "scene", label: "Start with a scene", default: true, resetOnChange: true, group: "Setup",
      description: "Begin with ledges, pools, plants and lava instead of an empty box." },
  ],
  macros: [
    { key: "rush", label: "Fast forward", targets: [{ param: "speed", amount: 0.7 }] },
    { key: "pour", label: "Downpour", targets: [{ param: "brush", amount: 0.5 }, { param: "notePour", amount: 0.6 }] },
    { key: "moon", label: "Moon gravity", targets: [{ param: "gravity", amount: -0.85 }, { param: "hue", amount: 0.5 }] },
  ],
  modulations: [
    { source: "kick", target: "speed", amount: 0.35 },
    { source: "lfoBar", target: "gravity", amount: -0.4 },
    { source: "pitch", target: "hue", amount: 0.2 },
    { source: "bass", target: "notePour", amount: 0.4 },
  ],
  reactions: [
    { role: "kick", text: "Pours a splash of water from the ceiling" },
    { role: "snare", text: "Throws a spark that can set plants alight" },
    { role: "tone", text: "Pours the brush material from the ceiling, placed by pitch" },
  ],
  create: () => new SandSim(),
};
