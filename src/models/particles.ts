import type { ModelDefinition, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  m: number;
  r: number;
  hue: number;
}

/**
 * N-body gravity with elastic collisions and wall bounces. O(n^2) pairwise
 * forces, which is fine for a few hundred bodies; a Barnes–Hut model can be
 * added later as a separate definition.
 */
class ParticleSim implements SimulationModel {
  private bodies: Body[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private drag: { x0: number; y0: number; x: number; y: number } | null = null;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.bodies = [];
    const n = p.count as number;
    for (let i = 0; i < n; i++) {
      this.bodies.push(
        this.makeBody(
          Math.random() * view.width,
          Math.random() * view.height,
          (Math.random() - 0.5) * 40,
          (Math.random() - 0.5) * 40,
        ),
      );
    }
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private makeBody(x: number, y: number, vx: number, vy: number, m = 1 + Math.random() * 4): Body {
    return { x, y, vx, vy, m, r: 2 + Math.sqrt(m) * 2, hue: 190 + Math.random() * 80 };
  }

  step(dt: number, p: ParamValues): void {
    const G = p.gravity as number;
    const soft = 25; // softening length^2 avoids singular forces at close range
    const bodies = this.bodies;
    const n = bodies.length;

    const ax = new Float64Array(n);
    const ay = new Float64Array(n);
    if (G > 0) {
      for (let i = 0; i < n; i++) {
        const a = bodies[i];
        for (let j = i + 1; j < n; j++) {
          const b = bodies[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + soft;
          const inv = G / (d2 * Math.sqrt(d2));
          ax[i] += dx * inv * b.m;
          ay[i] += dy * inv * b.m;
          ax[j] -= dx * inv * a.m;
          ay[j] -= dy * inv * a.m;
        }
      }
    }

    const damping = 1 - (p.damping as number) * dt;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.vx = (b.vx + ax[i] * dt) * damping;
      b.vy = (b.vy + (ay[i] + (p.downwardGravity as number)) * dt) * damping;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    if (p.collisions) this.collide(p.restitution as number);
    if (p.walls) this.bounceWalls(p.restitution as number);
  }

  private collide(e: number): void {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minD = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        // Push apart in proportion to inverse mass.
        const overlap = minD - d;
        const total = a.m + b.m;
        a.x -= nx * overlap * (b.m / total);
        a.y -= ny * overlap * (b.m / total);
        b.x += nx * overlap * (a.m / total);
        b.y += ny * overlap * (a.m / total);
        // Impulse along the contact normal.
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel > 0) continue;
        const jImp = (-(1 + e) * rel) / (1 / a.m + 1 / b.m);
        a.vx -= (jImp * nx) / a.m;
        a.vy -= (jImp * ny) / a.m;
        b.vx += (jImp * nx) / b.m;
        b.vy += (jImp * ny) / b.m;
      }
    }
  }

  private bounceWalls(e: number): void {
    const { width, height } = this.view;
    for (const b of this.bodies) {
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * e; }
      if (b.x > width - b.r) { b.x = width - b.r; b.vx = -Math.abs(b.vx) * e; }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * e; }
      if (b.y > height - b.r) { b.y = height - b.r; b.vy = -Math.abs(b.vy) * e; }
    }
  }

  onPointer(input: PointerInput): void {
    // Drag to fling a new body: the drag vector sets its velocity.
    if (input.type === "down" && input.button === 0) {
      this.drag = { x0: input.x, y0: input.y, x: input.x, y: input.y };
    } else if (input.type === "move" && this.drag) {
      this.drag.x = input.x;
      this.drag.y = input.y;
    } else if (input.type === "up" && this.drag) {
      const { x0, y0, x, y } = this.drag;
      const mass = input.shift ? 60 : 1 + Math.random() * 4;
      this.bodies.push(this.makeBody(x0, y0, (x0 - x) * 2, (y0 - y) * 2, mass));
      this.drag = null;
    }
  }

  render(g: CanvasRenderingContext2D, _view: Viewport, p: ParamValues): void {
    for (const b of this.bodies) {
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fillStyle = `hsl(${b.hue} 80% 65%)`;
      g.fill();
      if (p.showVelocity) {
        g.beginPath();
        g.moveTo(b.x, b.y);
        g.lineTo(b.x + b.vx * 0.2, b.y + b.vy * 0.2);
        g.strokeStyle = "rgba(255,255,255,0.35)";
        g.stroke();
      }
    }
    if (this.drag) {
      const { x0, y0, x, y } = this.drag;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x, y);
      g.setLineDash([4, 4]);
      g.strokeStyle = "rgba(255,255,255,0.6)";
      g.stroke();
      g.setLineDash([]);
    }
  }

  stats(): string {
    return `${this.bodies.length} bodies`;
  }
}

export const particles: ModelDefinition = {
  id: "particles",
  name: "Particles & gravity",
  category: "Particle physics",
  description: "Bodies that attract each other, collide elastically, and bounce off the walls.",
  hint: "Drag on the canvas to fling a new body. Hold Shift for a heavy one.",
  fixedDt: 1 / 120,
  params: [
    { kind: "number", key: "count", label: "Bodies", min: 0, max: 600, step: 10, default: 150, resetOnChange: true },
    { kind: "number", key: "gravity", label: "Mutual gravity", min: 0, max: 2000, step: 10, default: 300 },
    { kind: "number", key: "downwardGravity", label: "Downward gravity", min: 0, max: 800, step: 10, default: 0 },
    { kind: "number", key: "restitution", label: "Bounciness", min: 0, max: 1, step: 0.05, default: 0.9 },
    { kind: "number", key: "damping", label: "Air drag", min: 0, max: 2, step: 0.05, default: 0 },
    { kind: "boolean", key: "collisions", label: "Collisions", default: true },
    { kind: "boolean", key: "walls", label: "Walls", default: true },
    { kind: "boolean", key: "showVelocity", label: "Show velocity", default: false },
  ],
  create: () => new ParticleSim(),
};
