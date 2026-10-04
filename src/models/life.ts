import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";

/**
 * Conway's Game of Life on a wrapping grid. Cell size is a parameter, and
 * the grid is rebuilt when it or the viewport changes.
 */
class LifeSim implements SimulationModel {
  private cols = 0;
  private rows = 0;
  private cell = 8;
  private cells = new Uint8Array(0);
  private next = new Uint8Array(0);
  private accumulator = 0;
  private generation = 0;
  private paintValue: 0 | 1 | null = null;

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.cols = Math.max(1, Math.floor(view.width / this.cell));
    this.rows = Math.max(1, Math.floor(view.height / this.cell));
    this.cells = new Uint8Array(this.cols * this.rows);
    this.next = new Uint8Array(this.cols * this.rows);
    const density = p.density as number;
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = Math.random() < density ? 1 : 0;
    this.generation = 0;
    this.accumulator = 0;
  }

  step(dt: number, p: ParamValues): void {
    this.accumulator += dt * (p.speed as number);
    while (this.accumulator >= 1) {
      this.accumulator -= 1;
      this.tick();
    }
  }

  private tick(): void {
    const { cols, rows, cells, next } = this;
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
        next[mid + x] = n === 3 || (alive && n === 2) ? 1 : 0;
      }
    }
    this.cells = next;
    this.next = cells;
    this.generation++;
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
    } else if (input.type === "move" && this.paintValue !== null && inside) {
      this.cells[y * this.cols + x] = this.paintValue;
    } else if (input.type === "up") {
      this.paintValue = null;
    }
  }

  render(g: CanvasRenderingContext2D): void {
    const s = this.cell;
    g.fillStyle = "hsl(40 90% 65%)";
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.cells[y * this.cols + x]) g.fillRect(x * s, y * s, s - 1, s - 1);
      }
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
  description: "Conway's cellular automaton: cells live, die or are born based on their eight neighbours.",
  hint: "Click or drag to draw cells. Pause first to sketch a pattern.",
  fixedDt: 1 / 60,
  params: [
    { kind: "number", key: "speed", label: "Generations / sec", min: 1, max: 60, step: 1, default: 15 },
    { kind: "number", key: "cellSize", label: "Cell size", min: 3, max: 24, step: 1, default: 8, resetOnChange: true },
    { kind: "number", key: "density", label: "Initial density", min: 0, max: 1, step: 0.05, default: 0.25, resetOnChange: true },
  ],
  create: () => new LifeSim(),
};
