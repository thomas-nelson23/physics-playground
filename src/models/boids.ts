import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash, noteHue } from "./lib/music";

interface Boid {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Reynolds' boids: each agent steers by three local rules (separation,
 * alignment, cohesion). Neighbour search uses a uniform grid so a few
 * thousand boids stay interactive.
 */
class BoidsSim implements SimulationModel {
  private boids: Boid[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private pointer: { x: number; y: number; repel: boolean } | null = null;
  /** Short-lived pulls toward where recent notes landed. */
  private lures: { x: number; y: number; life: number; strength: number }[] = [];
  private hue = 160;
  private targetHue = 160;
  private flash = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.boids = Array.from({ length: p.count as number }, () => {
      const a = Math.random() * Math.PI * 2;
      return { x: Math.random() * view.width, y: Math.random() * view.height, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 };
    });
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  step(dt: number, p: ParamValues): void {
    const radius = p.radius as number;
    const r2 = radius * radius;
    const sepR2 = (radius * 0.4) ** 2;
    const maxSpeed = p.maxSpeed as number;
    const { width, height } = this.view;

    const cell = Math.max(radius, 8);
    const cols = Math.ceil(width / cell) + 1;
    const grid = new Map<number, Boid[]>();
    for (const b of this.boids) {
      const k = Math.floor(b.y / cell) * cols + Math.floor(b.x / cell);
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }

    for (const b of this.boids) {
      let ax = 0, ay = 0, cx = 0, cy = 0, sx = 0, sy = 0, n = 0;
      const gx = Math.floor(b.x / cell);
      const gy = Math.floor(b.y / cell);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = grid.get((gy + oy) * cols + gx + ox);
          if (!list) continue;
          for (const o of list) {
            if (o === b) continue;
            const dx = o.x - b.x;
            const dy = o.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            n++;
            ax += o.vx; ay += o.vy;
            cx += o.x; cy += o.y;
            if (d2 < sepR2 && d2 > 0) { sx -= dx / d2; sy -= dy / d2; }
          }
        }
      }
      let fx = 0, fy = 0;
      if (n > 0) {
        fx += (ax / n - b.vx) * (p.alignment as number);
        fy += (ay / n - b.vy) * (p.alignment as number);
        fx += (cx / n - b.x) * (p.cohesion as number);
        fy += (cy / n - b.y) * (p.cohesion as number);
        fx += sx * (p.separation as number) * 1000;
        fy += sy * (p.separation as number) * 1000;
      }
      for (const l of this.lures) {
        const dx = l.x - b.x, dy = l.y - b.y;
        const d = Math.hypot(dx, dy) + 1;
        const s = (l.strength * l.life * 3000) / d;
        fx += (dx / d) * s;
        fy += (dy / d) * s;
      }
      if (this.pointer) {
        const dx = this.pointer.x - b.x;
        const dy = this.pointer.y - b.y;
        const d = Math.hypot(dx, dy) + 1;
        const s = (this.pointer.repel ? -1 : 1) * 4000 / d;
        fx += (dx / d) * s;
        fy += (dy / d) * s;
      }
      b.vx += fx * dt;
      b.vy += fy * dt;
      const speed = Math.hypot(b.vx, b.vy);
      const minSpeed = maxSpeed * 0.3;
      if (speed > maxSpeed) { b.vx *= maxSpeed / speed; b.vy *= maxSpeed / speed; }
      else if (speed < minSpeed && speed > 0) { b.vx *= minSpeed / speed; b.vy *= minSpeed / speed; }
    }

    for (const l of this.lures) l.life -= dt * 1.5;
    this.lures = this.lures.filter((l) => l.life > 0);

    for (const b of this.boids) {
      b.x = (b.x + b.vx * dt + width) % width;
      b.y = (b.y + b.vy * dt + height) % height;
    }
  }

  onPointer(input: PointerInput): void {
    this.pointer = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, repel: input.button === 2 || input.shift }
      : null;
  }

  onNote(ev: NoteEvent): void {
    const { width, height } = this.view;
    if (ev.role === "tone") {
      // The flock chases each note: left to right by pitch, and turns its colour.
      this.lures.push({ x: width * (0.1 + ev.x * 0.8), y: height * (0.2 + noteHash(ev.note) * 0.6), life: 1, strength: ev.velocity });
      if (this.lures.length > 6) this.lures.shift();
      this.targetHue = noteHue(ev.note);
    } else if (ev.role === "kick") {
      // Scatter outward from the centre.
      for (const b of this.boids) {
        const dx = b.x - width / 2, dy = b.y - height / 2;
        const d = Math.hypot(dx, dy) + 1;
        b.vx += (dx / d) * 160 * ev.velocity;
        b.vy += (dy / d) * 160 * ev.velocity;
      }
      this.flash = ev.velocity;
    } else {
      this.flash = Math.max(this.flash, ev.velocity * 0.5);
    }
  }

  render(g: CanvasRenderingContext2D): void {
    // Ease the flock's colour toward the last note's hue, the short way round.
    const dh = ((this.targetHue - this.hue + 540) % 360) - 180;
    this.hue = (this.hue + dh * 0.05 + 360) % 360;
    g.fillStyle = `hsl(${this.hue} 70% ${60 + this.flash * 25}%)`;
    this.flash *= 0.9;
    for (const b of this.boids) {
      const a = Math.atan2(b.vy, b.vx);
      const c = Math.cos(a), s = Math.sin(a);
      g.beginPath();
      g.moveTo(b.x + c * 7, b.y + s * 7);
      g.lineTo(b.x - c * 4 - s * 3.5, b.y - s * 4 + c * 3.5);
      g.lineTo(b.x - c * 4 + s * 3.5, b.y - s * 4 - c * 3.5);
      g.closePath();
      g.fill();
    }
  }

  stats(): string {
    return `${this.boids.length} boids`;
  }
}

export const boids: ModelDefinition = {
  id: "boids",
  name: "Flocking (boids)",
  category: "Algorithmic",
  description: "Agents following separation, alignment and cohesion rules form emergent flocks.",
  hint: "Hold the mouse to attract the flock. Right-click or Shift to scatter it. The flock chases notes and takes on their colour; kicks scatter it.",
  fixedDt: 1 / 60,
  params: [
    { kind: "number", key: "count", label: "Boids", min: 10, max: 3000, step: 10, default: 600, resetOnChange: true },
    { kind: "number", key: "radius", label: "Vision radius", min: 10, max: 120, step: 1, default: 40 },
    { kind: "number", key: "separation", label: "Separation", min: 0, max: 5, step: 0.1, default: 1.5 },
    { kind: "number", key: "alignment", label: "Alignment", min: 0, max: 5, step: 0.1, default: 1 },
    { kind: "number", key: "cohesion", label: "Cohesion", min: 0, max: 5, step: 0.1, default: 0.8 },
    { kind: "number", key: "maxSpeed", label: "Max speed", min: 20, max: 400, step: 5, default: 140 },
  ],
  macros: [
    { key: "swarm", label: "Swarm", targets: [{ param: "cohesion", amount: 0.4 }, { param: "alignment", amount: 0.3 }] },
    { key: "panic", label: "Panic", targets: [{ param: "separation", amount: 0.5 }, { param: "maxSpeed", amount: 0.4 }] },
  ],
  modulations: [{ source: "kick", target: "maxSpeed", amount: 0.2 }],
  create: () => new BoidsSim(),
};
