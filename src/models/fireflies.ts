import type { ModelDefinition, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";

const TAU = Math.PI * 2;

/**
 * Synchronising fireflies: the Kuramoto model of coupled oscillators. Each
 * firefly flashes when its phase wraps round, and nudges the phases of
 * nearby fireflies toward its own. Above a critical coupling the swarm
 * locks into flashing together, spreading as waves. Drum hits act as an
 * outside flash every firefly sees, so the swarm entrains to the beat.
 */
class FirefliesSim implements SimulationModel {
  private n = 0;
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private phase = new Float32Array(0);
  private omega = new Float32Array(0);
  private dphase = new Float32Array(0);
  private hue = new Float32Array(0);
  private view: Viewport = { width: 1, height: 1 };
  private order = 0;
  private lure: { x: number; y: number } | null = null;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const n = (this.n = p.count as number);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.omega = new Float32Array(n);
    this.dphase = new Float32Array(n);
    this.hue = new Float32Array(n).fill(65);
    for (let i = 0; i < n; i++) {
      this.x[i] = Math.random() * view.width;
      this.y[i] = Math.random() * view.height;
      this.phase[i] = Math.random() * TAU;
      // A fixed spread per firefly, scaled by the slider at each step.
      this.omega[i] = Math.random() * 2 - 1;
    }
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  step(dt: number, p: ParamValues): void {
    const { n, x, y, vx, vy, phase, omega, dphase } = this;
    const { width: w, height: h } = this.view;
    const base = (p.rate as number) * TAU;
    const spread = (p.spread as number) * TAU;
    const K = p.coupling as number;
    const R = p.radius as number;
    const R2 = R * R;

    // Local Kuramoto coupling: dθi/dt = ωi + K/Ni Σ sin(θj − θi) over neighbours j.
    let sumC = 0, sumS = 0;
    for (let i = 0; i < n; i++) {
      let s = 0, cnt = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = x[j] - x[i], dy = y[j] - y[i];
        if (dx * dx + dy * dy > R2) continue;
        s += Math.sin(phase[j] - phase[i]);
        cnt++;
      }
      dphase[i] = base + omega[i] * spread + (cnt ? (K * s) / cnt : 0);
      sumC += Math.cos(phase[i]);
      sumS += Math.sin(phase[i]);
    }
    // r = |mean of e^{iθ}|: 0 when random, 1 when perfectly in sync.
    this.order = n ? Math.hypot(sumC, sumS) / n : 0;

    const wander = p.wander as number;
    for (let i = 0; i < n; i++) {
      phase[i] = (((phase[i] + dphase[i] * dt) % TAU) + TAU) % TAU;
      // Slow drifting flight.
      vx[i] += (Math.random() - 0.5) * wander * 60 * dt;
      vy[i] += (Math.random() - 0.5) * wander * 60 * dt;
      if (this.lure) {
        const dx = this.lure.x - x[i], dy = this.lure.y - y[i];
        const d = Math.hypot(dx, dy) + 20;
        vx[i] += (dx / d) * 80 * dt;
        vy[i] += (dy / d) * 80 * dt;
      }
      vx[i] *= 0.98;
      vy[i] *= 0.98;
      x[i] = (x[i] + vx[i] * dt + w) % w;
      y[i] = (y[i] + vy[i] * dt + h) % h;
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { n, phase, x, hue } = this;
    if (ev.role === "tone") {
      // A melody note sets off the fireflies in its column and paints them its colour.
      const cx = ev.x * this.view.width;
      const half = this.view.width * 0.08;
      const h = noteHue(ev.note);
      for (let i = 0; i < n; i++) {
        if (Math.abs(x[i] - cx) > half) continue;
        phase[i] = 0.001;
        hue[i] = h;
      }
      return;
    }
    // Drum hits are a flash everyone sees: each phase is pulled toward a
    // flash (phase 0) by an amount set by the Beat pull slider.
    const pull = (p.entrain as number) * ev.velocity * (ev.role === "hat" ? 0.4 : 1);
    for (let i = 0; i < n; i++) {
      phase[i] = (phase[i] - pull * Math.sin(phase[i]) + TAU) % TAU;
      hue[i] += (65 - hue[i]) * 0.1;
    }
  }

  onPointer(input: PointerInput): void {
    this.lure = input.pressed && input.type !== "up" ? { x: input.x, y: input.y } : null;
  }

  render(g: CanvasRenderingContext2D): void {
    const { n, x, y, phase, hue } = this;
    g.fillStyle = "rgba(255,255,255,0.12)";
    for (let i = 0; i < n; i++) g.fillRect(x[i] - 1, y[i] - 1, 2, 2);
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i++) {
      // Bright for a short moment just after the phase wraps, then dark.
      const b = Math.exp(-phase[i] * 3);
      if (b < 0.03) continue;
      const r = 3 + b * 9;
      g.fillStyle = `hsla(${hue[i]} 95% 65% / ${b * 0.35})`;
      g.beginPath();
      g.arc(x[i], y[i], r, 0, TAU);
      g.fill();
      g.fillStyle = `hsla(${hue[i]} 100% 85% / ${b})`;
      g.fillRect(x[i] - 1.5, y[i] - 1.5, 3, 3);
    }
    g.globalCompositeOperation = "source-over";
  }

  stats(): string {
    return `${this.n} fireflies · sync ${(this.order * 100).toFixed(0)}%`;
  }
}

export const fireflies: ModelDefinition = {
  id: "fireflies",
  name: "Fireflies",
  category: "Sound & music",
  description: "Coupled oscillators (the Kuramoto model). Each firefly nudges its neighbours toward its own rhythm until the swarm flashes together. Drum hits pull everyone toward the beat.",
  hint: "Hold the mouse to draw the swarm in. Play the sequencer and watch them lock to the beat; melody notes light up a column in the note's colour.",
  fixedDt: 1 / 60,
  params: [
    { kind: "number", key: "count", label: "Fireflies", min: 50, max: 900, step: 10, default: 450, resetOnChange: true },
    { kind: "number", key: "rate", label: "Flash rate (Hz)", min: 0.2, max: 4, step: 0.05, default: 0.9 },
    { kind: "number", key: "spread", label: "Rate spread (Hz)", min: 0, max: 1, step: 0.01, default: 0.15 },
    { kind: "number", key: "coupling", label: "Coupling", min: 0, max: 6, step: 0.05, default: 1.2 },
    { kind: "number", key: "radius", label: "Sight radius", min: 20, max: 400, step: 5, default: 110 },
    { kind: "number", key: "entrain", label: "Beat pull", min: 0, max: 1.5, step: 0.05, default: 0.6 },
    { kind: "number", key: "wander", label: "Wander", min: 0, max: 5, step: 0.1, default: 1.5 },
  ],
  macros: [
    { key: "sync", label: "Sync", targets: [{ param: "coupling", amount: 0.5 }, { param: "spread", amount: -0.15 }] },
    { key: "chaos", label: "Chaos", targets: [{ param: "spread", amount: 0.6 }, { param: "coupling", amount: -0.2 }] },
  ],
  create: () => new FirefliesSim(),
};
