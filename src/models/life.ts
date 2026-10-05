import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash, noteHue } from "./lib/music";

/** Colour index for cells that weren't seeded by a note. */
const PLAIN = 12;

/** Small patterns notes stamp onto the grid, as [dx, dy] live cells. */
const STAMPS: [number, number][][] = [
  [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]], // glider
  [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]], // R-pentomino
  [[0, 0], [1, 0], [2, 0]], // blinker
  [[1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [2, 2], [1, 3]], // a small explosion
];

/**
 * Conway's Game of Life on a wrapping grid. Cell size is a parameter, and
 * the grid is rebuilt when it or the viewport changes. Cells remember the
 * pitch class of the note that seeded them, and newborn cells take a
 * neighbour's colour, so melodies spread as coloured colonies.
 */
class LifeSim implements SimulationModel {
  private cols = 0;
  private rows = 0;
  private cell = 8;
  private cells = new Uint8Array(0);
  private next = new Uint8Array(0);
  private color = new Uint8Array(0);
  private nextColor = new Uint8Array(0);
  private accumulator = 0;
  private generation = 0;
  private paintValue: 0 | 1 | null = null;
  private beatPending = false;
  private flip = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.cols = Math.max(1, Math.floor(view.width / this.cell));
    this.rows = Math.max(1, Math.floor(view.height / this.cell));
    const n = this.cols * this.rows;
    this.cells = new Uint8Array(n);
    this.next = new Uint8Array(n);
    this.color = new Uint8Array(n).fill(PLAIN);
    this.nextColor = new Uint8Array(n).fill(PLAIN);
    const density = p.density as number;
    for (let i = 0; i < n; i++) this.cells[i] = Math.random() < density ? 1 : 0;
    this.generation = 0;
    this.accumulator = 0;
  }

  step(dt: number, p: ParamValues): void {
    if (p.clock === "beat") {
      // One generation per drum hit (several hits in one frame count once).
      if (this.beatPending) this.tick();
      this.beatPending = false;
      return;
    }
    this.accumulator += dt * (p.speed as number);
    while (this.accumulator >= 1) {
      this.accumulator -= 1;
      this.tick();
    }
  }

  private tick(): void {
    const { cols, rows, cells, next, color, nextColor } = this;
    for (let y = 0; y < rows; y++) {
      const up = ((y - 1 + rows) % rows) * cols;
      const mid = y * cols;
      const down = ((y + 1) % rows) * cols;
      for (let x = 0; x < cols; x++) {
        const l = (x - 1 + cols) % cols;
        const r = (x + 1) % cols;
        const n =
          cells[up + l] + cells[up + x] + cells[up + r] +
          cells[mid + l] + cells[mid + r] +
          cells[down + l] + cells[down + x] + cells[down + r];
        const alive = cells[mid + x];
        const live = n === 3 || (alive && n === 2) ? 1 : 0;
        next[mid + x] = live;
        if (live && !alive) {
          // Inherit a colour from a live neighbour (the first one found).
          let c = PLAIN;
          for (const j of [up + x, mid + l, mid + r, down + x, up + l, up + r, down + l, down + r]) {
            if (cells[j] && color[j] !== PLAIN) { c = color[j]; break; }
          }
          nextColor[mid + x] = c;
        } else {
          nextColor[mid + x] = live ? color[mid + x] : PLAIN;
        }
      }
    }
    this.cells = next;
    this.next = cells;
    this.color = nextColor;
    this.nextColor = color;
    this.generation++;
  }

  onNote(ev: NoteEvent): void {
    if (ev.role !== "tone") {
      this.beatPending = true;
      if (ev.role !== "kick") return;
    }
    // Notes stamp a pattern: left to right by pitch, coloured by pitch class.
    // Kicks stamp a plain one somewhere random.
    const tone = ev.role === "tone";
    const cx = Math.floor((tone ? 0.04 + ev.x * 0.92 : Math.random()) * this.cols);
    const cy = Math.floor((tone ? 0.1 + noteHash(ev.note) * 0.8 : Math.random()) * this.rows);
    const stamp = STAMPS[(tone ? ev.note : this.generation) % STAMPS.length];
    const c = tone ? ev.note % 12 : PLAIN;
    this.flip = (this.flip + 1) % 4;
    for (const [dx, dy] of stamp) {
      // Rotate the stamp a quarter turn each time so gliders head off in different directions.
      const [rx, ry] = [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx]][this.flip];
      const x = (cx + rx + this.cols) % this.cols;
      const y = (cy + ry + this.rows) % this.rows;
      this.cells[y * this.cols + x] = 1;
      this.color[y * this.cols + x] = c;
    }
  }

  onPointer(input: PointerInput): void {
    // Click toggles a cell; dragging paints with whatever the first click set.
    const x = Math.floor(input.x / this.cell);
    const y = Math.floor(input.y / this.cell);
    const inside = x >= 0 && y >= 0 && x < this.cols && y < this.rows;
    if (input.type === "down" && inside) {
      const i = y * this.cols + x;
      this.paintValue = this.cells[i] ? 0 : 1;
      this.cells[i] = this.paintValue;
      this.color[i] = PLAIN;
    } else if (input.type === "move" && this.paintValue !== null && inside) {
      this.cells[y * this.cols + x] = this.paintValue;
      this.color[y * this.cols + x] = PLAIN;
    } else if (input.type === "up") {
      this.paintValue = null;
    }
  }

  render(g: CanvasRenderingContext2D): void {
    const s = this.cell;
    // Batch cells by colour: one path per pitch class plus the plain gold.
    const paths = Array.from({ length: PLAIN + 1 }, () => new Path2D());
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        if (this.cells[i]) paths[this.color[i]].rect(x * s, y * s, s - 1, s - 1);
      }
    }
    for (let c = 0; c <= PLAIN; c++) {
      g.fillStyle = c === PLAIN ? "hsl(40 90% 65%)" : `hsl(${noteHue(c)} 85% 65%)`;
      g.fill(paths[c]);
    }
  }

  stats(): string {
    return `Generation ${this.generation}`;
  }
}

export const life: ModelDefinition = {
  id: "life",
  name: "Game of Life",
  category: "Algorithmic",
  description: "Conway's cellular automaton: cells live, die or are born based on their eight neighbours. Notes seed coloured colonies that spread their colour as they grow.",
  hint: "Click or drag to draw cells. Pause first to sketch a pattern. Notes stamp gliders and other seeds; set Clock to \"Drum hits\" to step one generation per beat.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "clock", label: "Clock", default: "time",
      options: [
        { value: "time", label: "Generations per second" },
        { value: "beat", label: "Drum hits" },
      ],
    },
    { kind: "number", key: "speed", label: "Generations / sec", min: 1, max: 60, step: 1, default: 15 },
    { kind: "number", key: "cellSize", label: "Cell size", min: 3, max: 24, step: 1, default: 8, resetOnChange: true },
    { kind: "number", key: "density", label: "Initial density", min: 0, max: 1, step: 0.05, default: 0.25, resetOnChange: true },
  ],
  macros: [
    { key: "tempo", label: "Faster", targets: [{ param: "speed", amount: 0.6 }] },
  ],
  create: () => new LifeSim(),
};
