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

/** Birth and survival neighbour counts as bitmasks (bit n set = n neighbours). */
const RULES: Record<string, { birth: number; survive: number }> = {
  conway: { birth: 1 << 3, survive: (1 << 2) | (1 << 3) },
  highlife: { birth: (1 << 3) | (1 << 6), survive: (1 << 2) | (1 << 3) },
  daynight: { birth: (1 << 3) | (1 << 6) | (1 << 7) | (1 << 8), survive: (1 << 3) | (1 << 4) | (1 << 6) | (1 << 7) | (1 << 8) },
  seeds: { birth: 1 << 2, survive: 0 },
  maze: { birth: 1 << 3, survive: 0b111110 },
  coral: { birth: 1 << 3, survive: 0b111110000 },
};

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
  /** Pitch class of each cell (kept after death so its ghost keeps the colour). */
  private color = new Uint8Array(0);
  private nextColor = new Uint8Array(0);
  /** Fading afterimage of cells that died, 0..255. */
  private ghost = new Uint8Array(0);
  private rule = RULES.conway;
  private noise = 0;
  private trails = 0;
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
    this.ghost = new Uint8Array(n);
    const density = p.density as number;
    for (let i = 0; i < n; i++) this.cells[i] = Math.random() < density ? 1 : 0;
    this.generation = 0;
    this.accumulator = 0;
  }

  step(dt: number, p: ParamValues): void {
    this.rule = RULES[p.rule as string] ?? RULES.conway;
    this.noise = p.noise as number;
    this.trails = p.trails as number;
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
    const { cols, rows, cells, next, color, nextColor, ghost, noise, trails } = this;
    const { birth, survive } = this.rule;
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
        let live = ((alive ? survive : birth) >> n) & 1;
        let random = false;
        if (!live && noise > 0 && Math.random() < noise) { live = 1; random = true; }
        next[mid + x] = live;
        if (alive && !live) ghost[mid + x] = 255;
        else if (live) ghost[mid + x] = 0;
        else if (ghost[mid + x]) ghost[mid + x] = (ghost[mid + x] * trails) | 0;
        if (random) {
          nextColor[mid + x] = PLAIN;
        } else if (live && !alive) {
          // Inherit a colour from a live neighbour (the first one found).
          let c = PLAIN;
          for (const j of [up + x, mid + l, mid + r, down + x, up + l, up + r, down + l, down + r]) {
            if (cells[j] && color[j] !== PLAIN) { c = color[j]; break; }
          }
          nextColor[mid + x] = c;
        } else {
          nextColor[mid + x] = color[mid + x];
        }
      }
    }
    this.cells = next;
    this.next = cells;
    this.color = nextColor;
    this.nextColor = color;
    this.generation++;
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    if (ev.role !== "tone") {
      this.beatPending = true;
      if (ev.role !== "kick") return;
    }
    // Notes stamp a pattern: left to right by pitch, coloured by pitch class.
    // Kicks stamp a plain one somewhere random.
    // Extra seeds land scattered around the first one.
    const tone = ev.role === "tone";
    const cx0 = Math.floor((tone ? 0.04 + ev.x * 0.92 : Math.random()) * this.cols);
    const cy0 = Math.floor((tone ? 0.1 + noteHash(ev.note) * 0.8 : Math.random()) * this.rows);
    const stamp = STAMPS[(tone ? ev.note : this.generation) % STAMPS.length];
    const c = tone ? ((ev.note % 12) + 12) % 12 : PLAIN;
    const seeds = Math.max(1, Math.round((p.seeds as number) ?? 1));
    const spread = Math.max(6, Math.min(this.cols, this.rows) * 0.15);
    for (let s = 0; s < seeds; s++) {
      const cx = s === 0 ? cx0 : Math.round(cx0 + (Math.random() - 0.5) * 2 * spread);
      const cy = s === 0 ? cy0 : Math.round(cy0 + (Math.random() - 0.5) * 2 * spread);
      this.flip = (this.flip + 1) % 4;
      for (const [dx, dy] of stamp) {
        // Rotate the stamp a quarter turn each time so gliders head off in different directions.
        const [rx, ry] = [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx]][this.flip];
        const x = (((cx + rx) % this.cols) + this.cols) % this.cols;
        const y = (((cy + ry) % this.rows) + this.rows) % this.rows;
        this.cells[y * this.cols + x] = 1;
        this.color[y * this.cols + x] = c;
      }
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

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    const s = this.cell;
    const shift = (p.hueShift as number) || 0;
    const showGhosts = this.trails > 0;
    // Batch cells by colour: one path per pitch class plus the plain gold,
    // and for ghosts the same again in three brightness bands.
    const paths = Array.from({ length: PLAIN + 1 }, () => new Path2D());
    const ghosts = showGhosts ? Array.from({ length: (PLAIN + 1) * 3 }, () => new Path2D()) : null;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        if (this.cells[i]) paths[this.color[i]].rect(x * s, y * s, s - 1, s - 1);
        else if (ghosts && this.ghost[i] > 12) {
          const band = this.ghost[i] > 170 ? 2 : this.ghost[i] > 80 ? 1 : 0;
          ghosts[this.color[i] * 3 + band].rect(x * s, y * s, s - 1, s - 1);
        }
      }
    }
    const hue = (c: number) => ((c === PLAIN ? 40 : noteHue(c)) + shift) % 360;
    if (ghosts) {
      for (let c = 0; c <= PLAIN; c++) {
        for (let band = 0; band < 3; band++) {
          g.fillStyle = `hsl(${hue(c)} 70% ${18 + band * 9}%)`;
          g.fill(ghosts[c * 3 + band]);
        }
      }
    }
    for (let c = 0; c <= PLAIN; c++) {
      g.fillStyle = `hsl(${hue(c)} ${c === PLAIN ? 90 : 85}% 65%)`;
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
  description: "Conway's cellular automaton and its cousins: cells live, die or are born based on their eight neighbours. Notes seed coloured colonies that spread their colour as they grow.",
  hint: "Click or drag to draw cells. Pause first to sketch a pattern. Notes stamp gliders and other seeds; set Clock to \"Drum hits\" to step one generation per beat.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "rule", label: "Rule", default: "conway", group: "Behaviour",
      description: "Which birth and survival rule the cells follow. Each grows a different texture.",
      options: [
        { value: "conway", label: "Conway (B3/S23)" },
        { value: "highlife", label: "HighLife, self-copying (B36/S23)" },
        { value: "daynight", label: "Day & Night, blobs (B3678/S34678)" },
        { value: "seeds", label: "Seeds, explosive (B2/S)" },
        { value: "maze", label: "Maze (B3/S12345)" },
        { value: "coral", label: "Coral, slow growth (B3/S45678)" },
      ],
    },
    { kind: "number", key: "noise", label: "Random births", min: 0, max: 0.02, step: 0.0005, default: 0, group: "Behaviour",
      description: "Chance an empty cell springs to life each generation. Adds static and restarts dead boards." },
    { kind: "number", key: "seeds", label: "Seeds per note", min: 1, max: 12, step: 1, default: 1, group: "Behaviour",
      description: "How many patterns each note or kick stamps, scattered around where it lands." },
    {
      kind: "choice", key: "clock", label: "Clock", default: "time", group: "Simulation",
      description: "Step on a timer, or one generation per drum hit.",
      options: [
        { value: "time", label: "Generations per second" },
        { value: "beat", label: "Drum hits" },
      ],
    },
    { kind: "number", key: "speed", label: "Generations / sec", min: 1, max: 120, step: 1, default: 15, group: "Simulation",
      description: "How fast generations tick when Clock is on the timer." },
    { kind: "number", key: "trails", label: "Ghost trails", min: 0, max: 0.97, step: 0.01, default: 0.3, group: "Look",
      description: "How long dead cells leave a fading afterimage. 0 turns ghosts off." },
    { kind: "number", key: "hueShift", label: "Colour shift", min: 0, max: 360, step: 1, default: 0, group: "Look",
      description: "Rotates every cell's colour around the colour wheel." },
    { kind: "number", key: "cellSize", label: "Cell size", min: 3, max: 24, step: 1, default: 8, resetOnChange: true, group: "Setup",
      description: "Size of each cell in pixels. Smaller means a bigger world. Rebuilds the grid." },
    { kind: "number", key: "density", label: "Initial density", min: 0, max: 1, step: 0.05, default: 0.25, resetOnChange: true, group: "Setup",
      description: "Fraction of cells alive at the start. Rebuilds the grid." },
  ],
  macros: [
    { key: "tempo", label: "Faster", targets: [{ param: "speed", amount: 0.7 }] },
    { key: "chaos", label: "Chaos", targets: [{ param: "noise", amount: 0.4 }, { param: "seeds", amount: 0.7 }, { param: "speed", amount: 0.25 }] },
    { key: "ghosts", label: "Ghosts", targets: [{ param: "trails", amount: 0.7 }, { param: "hueShift", amount: 0.5 }] },
  ],
  modulations: [
    { source: "kick", target: "noise", amount: 0.4 },
    { source: "pitch", target: "hueShift", amount: 0.5 },
    { source: "lfoBar", target: "trails", amount: 0.6 },
    { source: "bass", target: "speed", amount: 0.4 },
  ],
  reactions: [
    { role: "tone", text: "Stamps a seed pattern coloured by pitch, placed left to right by pitch" },
    { role: "kick", text: "Stamps a plain seed somewhere random; steps a generation when Clock is Drum hits" },
    { role: "snare", text: "Steps one generation when Clock is Drum hits" },
    { role: "hat", text: "Steps one generation when Clock is Drum hits" },
  ],
  create: () => new LifeSim(),
};
