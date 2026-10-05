import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";
import { gravityAt, gravityModeParam, isUniform, uniformDir } from "./lib/gravity";

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  m: number;
  r: number;
  hue: number;
}

const MAX_SPEED = 2500;

/**
 * N-body gravity with elastic collisions and wall bounces, plus an optional
 * gravity field (a direction, or a pull toward the centre, corners or walls). O(n^2) pairwise
 * forces, which is fine for a few hundred bodies; a Barnes–Hut model can be
 * added later as a separate definition.
 */
class ParticleSim implements SimulationModel {
  private bodies: Body[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private drag: { x0: number; y0: number; x: number; y: number } | null = null;
  private flash = 0;
  private time = 0;

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

    // The gravity field: a direction, or a pull toward a point / edge.
    this.time += dt;
    const mode = p.gravityMode as string;
    const fg = p.fieldGravity as number;
    const { width: w, height: h } = this.view;
    const uniform = isUniform(mode);
    const [ux, uy] = uniformDir(mode, this.time);

    const damping = Math.max(0, 1 - (p.damping as number) * dt);
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      let gx = ux * fg, gy = uy * fg;
      if (!uniform) [gx, gy] = gravityAt(mode, fg, b.x, b.y, w, h, this.time, 60);
      b.vx = (b.vx + (ax[i] + gx) * dt) * damping;
      b.vy = (b.vy + (ay[i] + gy) * dt) * damping;
      // A speed cap keeps close passes at extreme gravity from flinging bodies through each other.
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(v2);
        b.vx *= k;
        b.vy *= k;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    if (p.collisions) this.collide(p.restitution as number);
    if (p.walls) this.bounceWalls(p.restitution as number);
    else this.wrap();
  }

  /** Without walls, bodies leaving one edge come back on the opposite one, so a field can't empty the screen. */
  private wrap(): void {
    const { width: w, height: h } = this.view;
    for (const b of this.bodies) {
      if (b.x < -b.r) b.x += w + 2 * b.r;
      else if (b.x > w + b.r) b.x -= w + 2 * b.r;
      if (b.y < -b.r) b.y += h + 2 * b.r;
      else if (b.y > h + b.r) b.y -= h + 2 * b.r;
    }
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
    const light = 65 + this.flash * 20;
    this.flash *= 0.9;
    for (const b of this.bodies) {
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fillStyle = `hsl(${b.hue} 80% ${light}%)`;
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

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { width: w, height: h } = this.view;
    if (ev.role === "kick" || ev.role === "snare") {
      // A shockwave from the centre (kick) or a random spot (snare).
      const cx = ev.role === "kick" ? w / 2 : Math.random() * w;
      const cy = ev.role === "kick" ? h / 2 : Math.random() * h;
      const force = (ev.role === "kick" ? 260 : 140) * ev.velocity;
      // The wave fades to nothing before the walls. A wave that reached them pushed bodies at the
      // edges along the wall, away from the centre, beat after beat, until they all piled into the corners.
      const reach = Math.min(w, h) * (ev.role === "kick" ? 0.5 : 0.35);
      for (const b of this.bodies) {
        const dx = b.x - cx, dy = b.y - cy;
        const d = Math.hypot(dx, dy) + 30;
        const fade = Math.max(0, 1 - d / reach);
        if (fade === 0) continue;
        const f = ((force * 120) / d) * fade * fade;
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
      }
      this.flash = Math.max(this.flash, ev.velocity);
    } else if (ev.role === "tone") {
      // Each note drops a body coloured by its pitch, from the top, across the width by pitch.
      const body = this.makeBody(w * (0.08 + ev.x * 0.84), 10, (Math.random() - 0.5) * 40, 120 + ev.velocity * 260, 1 + ev.velocity * 5);
      body.hue = noteHue(ev.note);
      this.bodies.push(body);
      const max = Math.max(20, (p.count as number) * 1.5);
      if (this.bodies.length > max) this.bodies.splice(0, this.bodies.length - max);
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
  description: "Bodies that attract each other, collide and bounce, inside a gravity field you can point down, at the centre, the corners or the walls.",
  hint: "Drag on the canvas to fling a new body. Hold Shift for a heavy one. Notes drop bodies coloured by pitch; kicks and snares send out shockwaves.",
  fixedDt: 1 / 120,
  params: [
    {
      kind: "number", key: "gravity", label: "Mutual gravity", min: 0, max: 6000, step: 10, default: 300, group: "Gravity",
      description: "How strongly bodies pull on each other. High values collapse everything into clumps.",
    },
    gravityModeParam("center"),
    {
      kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 1500, step: 10, default: 80, group: "Gravity",
      description: "How hard the gravity field pulls. Low keeps a loose cloud; high packs bodies tight.",
    },
    {
      kind: "number", key: "restitution", label: "Bounciness", min: 0, max: 1, step: 0.05, default: 0.85, group: "Motion",
      description: "How much speed a body keeps after a bounce. 0 is dead clay, 1 is a superball.",
    },
    {
      kind: "number", key: "damping", label: "Air drag", min: 0, max: 5, step: 0.05, default: 0.15, group: "Motion",
      description: "Slows every body over time. Zero lets shockwaves keep everything flying forever.",
    },
    {
      kind: "boolean", key: "collisions", label: "Collisions", default: true, group: "Motion",
      description: "Bodies bump off each other instead of passing through.",
    },
    {
      kind: "boolean", key: "walls", label: "Walls", default: true, group: "Motion",
      description: "Bodies bounce off the edges. Off: they wrap round to the opposite side.",
    },
    {
      kind: "boolean", key: "showVelocity", label: "Show velocity", default: false, group: "Look",
      description: "Draws a line from each body showing where and how fast it is moving.",
    },
    {
      kind: "number", key: "count", label: "Bodies", min: 0, max: 800, step: 10, default: 150, resetOnChange: true, group: "Setup",
      description: "How many bodies the scene starts with. Changing it restarts the scene.",
    },
  ],
  macros: [
    {
      key: "attract", label: "Collapse",
      targets: [{ param: "gravity", amount: 0.7 }, { param: "fieldGravity", amount: 0.3 }, { param: "damping", amount: 0.15 }],
    },
    {
      key: "bounce", label: "Bounce",
      targets: [{ param: "restitution", amount: 0.3 }, { param: "damping", amount: -0.1 }, { param: "gravity", amount: -0.05 }, { param: "fieldGravity", amount: 0.5 }],
    },
  ],
  modulations: [
    { source: "kick", target: "gravity", amount: 0.3 },
    { source: "snare", target: "fieldGravity", amount: 0.4 },
    { source: "lfoBar", target: "fieldGravity", amount: 0.25 },
    { source: "bass", target: "gravity", amount: 0.35 },
  ],
  reactions: [
    { role: "kick", text: "Shockwave out from the centre" },
    { role: "snare", text: "Smaller shockwave from a random spot" },
    { role: "tone", text: "Drops a body coloured by pitch, left to right by pitch" },
  ],
  create: () => new ParticleSim(),
};
