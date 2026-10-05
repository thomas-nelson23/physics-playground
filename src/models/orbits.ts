import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Gravitational parameter G*m, in px^3/s^2. */
  gm: number;
  r: number;
  star: boolean;
  hue: number;
  trail: Float32Array;
  trailHead: number;
  trailLen: number;
}

const BASE_GM = 4.5e6; // a 200px orbit around a 1x star moves at ~150 px/s
const TRAIL_MAX = 600;
const SUBSTEPS = 4;

/**
 * A planetary system: heavy stars and light planets under Newtonian
 * gravity, integrated with a symplectic (leapfrog) scheme so orbits stay
 * closed over long runs. Planets that hit a star are swallowed.
 */
class OrbitsSim implements SimulationModel {
  private bodies: Body[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private drag: { x0: number; y0: number; x: number; y: number; star: boolean } | null = null;
  private swallowed = 0;
  private pulse = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.bodies = [];
    this.swallowed = 0;
    const cx = view.width / 2, cy = view.height / 2;
    const starGm = BASE_GM * (p.starMass as number);
    const span = Math.min(view.width, view.height) * 0.45;

    if (p.system === "binary") {
      const a = span * 0.18;
      const v = Math.sqrt(starGm / (4 * a)); // two equal stars orbiting their centre
      this.bodies.push(this.make(cx - a, cy, 0, v, starGm, true), this.make(cx + a, cy, 0, -v, starGm, true));
      // Circumbinary planets far enough out to be (mostly) stable.
      for (let i = 0; i < (p.planets as number); i++) {
        const r = span * (0.55 + Math.random() * 0.45);
        this.addCircular(cx, cy, r, 2 * starGm);
      }
    } else if (p.system === "planets") {
      this.bodies.push(this.make(cx, cy, 0, 0, starGm, true));
      for (let i = 0; i < (p.planets as number); i++) {
        const r = span * (0.15 + Math.random() * 0.85);
        this.addCircular(cx, cy, r, starGm);
      }
    } else {
      this.bodies.push(this.make(cx, cy, 0, 0, starGm, true));
    }
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private make(x: number, y: number, vx: number, vy: number, gm: number, star: boolean): Body {
    return {
      x, y, vx, vy, gm, star,
      r: star ? 10 + Math.sqrt(gm / BASE_GM) * 6 : 2.5 + Math.random() * 2.5,
      hue: star ? 45 : Math.random() * 360,
      trail: new Float32Array(TRAIL_MAX * 2),
      trailHead: 0,
      trailLen: 0,
    };
  }

  private addCircular(cx: number, cy: number, r: number, centralGm: number): void {
    const a = Math.random() * Math.PI * 2;
    const v = Math.sqrt(centralGm / r) * (0.95 + Math.random() * 0.1);
    const dir = Math.random() < 0.85 ? 1 : -1;
    this.bodies.push(
      this.make(cx + Math.cos(a) * r, cy + Math.sin(a) * r, -Math.sin(a) * v * dir, Math.cos(a) * v * dir, BASE_GM * 0.002, false),
    );
  }

  private accelerate(dt: number, mutual: boolean): void {
    const bs = this.bodies;
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i];
      let ax = 0, ay = 0;
      for (let j = 0; j < bs.length; j++) {
        if (i === j) continue;
        const b = bs[j];
        if (!b.star && !mutual) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 16;
        const inv = b.gm / (d2 * Math.sqrt(d2));
        ax += dx * inv;
        ay += dy * inv;
      }
      a.vx += ax * dt;
      a.vy += ay * dt;
    }
  }

  step(dt: number, p: ParamValues): void {
    const h = (dt * (p.timeScale as number)) / SUBSTEPS;
    const mutual = Boolean(p.mutual);
    for (let s = 0; s < SUBSTEPS; s++) {
      // Kick-drift-kick leapfrog.
      this.accelerate(h / 2, mutual);
      for (const b of this.bodies) { b.x += b.vx * h; b.y += b.vy * h; }
      this.accelerate(h / 2, mutual);
      this.absorb();
    }

    const { width: w, height: hgt } = this.view;
    this.bodies = this.bodies.filter((b) => b.star || (b.x > -w && b.x < 2 * w && b.y > -hgt && b.y < 2 * hgt));
    const trailLen = Math.min(TRAIL_MAX, p.trail as number);
    for (const b of this.bodies) {
      b.trail[b.trailHead * 2] = b.x;
      b.trail[b.trailHead * 2 + 1] = b.y;
      b.trailHead = (b.trailHead + 1) % TRAIL_MAX;
      b.trailLen = Math.min(b.trailLen + 1, trailLen);
    }
  }

  /** Planets that fall into a star are removed; colliding stars merge. */
  private absorb(): void {
    const bs = this.bodies;
    for (const s of bs) {
      if (!s.star || s.gm === 0) continue;
      for (const b of bs) {
        if (b === s || b.gm === 0) continue;
        if ((b.x - s.x) ** 2 + (b.y - s.y) ** 2 > (s.r + b.r * 0.5) ** 2) continue;
        if (b.star && b.gm > s.gm) continue;
        // Merge with momentum conservation.
        const m = s.gm + b.gm;
        s.vx = (s.vx * s.gm + b.vx * b.gm) / m;
        s.vy = (s.vy * s.gm + b.vy * b.gm) / m;
        s.gm = m;
        s.r = 10 + Math.sqrt(m / BASE_GM) * 6;
        if (!b.star) this.swallowed++;
        b.gm = 0;
      }
    }
    if (bs.some((b) => b.gm === 0)) this.bodies = bs.filter((b) => b.gm !== 0);
  }

  onPointer(input: PointerInput): void {
    if (input.type === "down") {
      this.drag = { x0: input.x, y0: input.y, x: input.x, y: input.y, star: input.button === 2 || input.shift };
    } else if (input.type === "move" && this.drag) {
      this.drag.x = input.x;
      this.drag.y = input.y;
    } else if (input.type === "up" && this.drag) {
      const { x0, y0, x, y, star } = this.drag;
      this.bodies.push(this.make(x0, y0, (x0 - x) * 1.5, (y0 - y) * 1.5, star ? BASE_GM * 0.5 : BASE_GM * 0.002, star));
      this.drag = null;
    }
  }

  onNote(ev: NoteEvent): void {
    if (ev.role !== "tone") {
      // Drums make the stars pulse.
      this.pulse = Math.max(this.pulse, ev.velocity * (ev.role === "hat" ? 0.4 : 1));
      return;
    }
    // A note births a planet on a circular orbit: low notes far out, high notes close in.
    const star = this.bodies.find((b) => b.star);
    if (!star) return;
    const span = Math.min(this.view.width, this.view.height) * 0.45;
    const r = span * (0.95 - ev.x * 0.75);
    const before = this.bodies.length;
    this.addCircular(star.x, star.y, r, star.gm);
    const planet = this.bodies[before];
    planet.vx += star.vx;
    planet.vy += star.vy;
    planet.hue = noteHue(ev.note);
    planet.r = 2.5 + ev.velocity * 3;
    const planets = this.bodies.filter((b) => !b.star);
    if (planets.length > 260) this.bodies.splice(this.bodies.indexOf(planets[0]), 1);
  }

  /** Where a body launched from the current drag would go (stars held fixed). */
  private predict(): number[] {
    if (!this.drag) return [];
    const { x0, y0, x, y } = this.drag;
    let px = x0, py = y0, vx = (x0 - x) * 1.5, vy = (y0 - y) * 1.5;
    const stars = this.bodies.filter((b) => b.star);
    const pts = [px, py];
    const h = 1 / 240;
    for (let i = 0; i < 1200; i++) {
      for (const s of stars) {
        const dx = s.x - px, dy = s.y - py;
        const d2 = dx * dx + dy * dy + 16;
        if (d2 < s.r * s.r) return pts;
        const inv = s.gm / (d2 * Math.sqrt(d2));
        vx += dx * inv * h;
        vy += dy * inv * h;
      }
      px += vx * h;
      py += vy * h;
      if (i % 3 === 0) pts.push(px, py);
    }
    return pts;
  }

  render(g: CanvasRenderingContext2D): void {
    this.pulse *= 0.9;
    // Trails fade from transparent (oldest) to solid (newest) in a few bands.
    const bands = 4;
    for (const b of this.bodies) {
      const n = b.trailLen;
      if (n < 2) continue;
      for (let k = 0; k < bands; k++) {
        const from = Math.floor((k * (n - 1)) / bands), to = Math.floor(((k + 1) * (n - 1)) / bands);
        g.beginPath();
        for (let i = from; i <= to; i++) {
          const idx = ((b.trailHead - n + i + TRAIL_MAX) % TRAIL_MAX) * 2;
          if (i === from) g.moveTo(b.trail[idx], b.trail[idx + 1]);
          else g.lineTo(b.trail[idx], b.trail[idx + 1]);
        }
        g.strokeStyle = `hsla(${b.hue} 80% 65% / ${((k + 1) / bands) * 0.55})`;
        g.stroke();
      }
    }

    for (const b of this.bodies) {
      if (b.star) {
        const R = b.r * (3 + this.pulse * 3);
        const glow = g.createRadialGradient(b.x, b.y, 0, b.x, b.y, R);
        glow.addColorStop(0, "rgba(255,220,140,0.9)");
        glow.addColorStop(0.35, "rgba(255,170,60,0.35)");
        glow.addColorStop(1, "rgba(255,140,40,0)");
        g.fillStyle = glow;
        g.beginPath();
        g.arc(b.x, b.y, R, 0, Math.PI * 2);
        g.fill();
      }
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fillStyle = b.star ? "hsl(45 100% 80%)" : `hsl(${b.hue} 75% 65%)`;
      g.fill();
    }

    const path = this.predict();
    if (path.length > 2) {
      g.beginPath();
      g.moveTo(path[0], path[1]);
      for (let i = 2; i < path.length; i += 2) g.lineTo(path[i], path[i + 1]);
      g.setLineDash([3, 5]);
      g.strokeStyle = "rgba(255,255,255,0.5)";
      g.stroke();
      g.setLineDash([]);
    }
  }

  stats(): string {
    const stars = this.bodies.filter((b) => b.star).length;
    return `${stars} star${stars === 1 ? "" : "s"} · ${this.bodies.length - stars} planets · ${this.swallowed} swallowed`;
  }
}

export const orbits: ModelDefinition = {
  id: "orbits",
  name: "Orbits",
  category: "Particle physics",
  description: "Planets orbiting stars under Newtonian gravity, with trails. A dashed line previews where a launch will go.",
  hint: "Drag to launch a planet (the drag sets its velocity). Right-drag or Shift-drag launches a new star. Each note adds a planet, low notes on outer orbits.",
  fixedDt: 1 / 60,
  params: [
    {
      kind: "choice", key: "system", label: "System", default: "planets", resetOnChange: true,
      options: [
        { value: "planets", label: "Star with planets" },
        { value: "binary", label: "Binary star" },
        { value: "empty", label: "Lone star" },
      ],
    },
    { kind: "number", key: "planets", label: "Planets", min: 0, max: 200, step: 1, default: 40, resetOnChange: true },
    { kind: "number", key: "starMass", label: "Star mass", min: 0.2, max: 3, step: 0.1, default: 1, resetOnChange: true },
    { kind: "number", key: "timeScale", label: "Time scale", min: 0.1, max: 4, step: 0.1, default: 1 },
    { kind: "number", key: "trail", label: "Trail length", min: 0, max: TRAIL_MAX, step: 10, default: 200 },
    { kind: "boolean", key: "mutual", label: "Planets attract each other", default: false },
  ],
  macros: [
    { key: "warp", label: "Time warp", targets: [{ param: "timeScale", amount: 0.5 }] },
    { key: "trails", label: "Long trails", targets: [{ param: "trail", amount: 0.7 }] },
  ],
  modulations: [{ source: "kick", target: "timeScale", amount: 0.12 }],
  create: () => new OrbitsSim(),
};
