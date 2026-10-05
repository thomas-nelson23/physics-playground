import type { ParamSpec, ParamValues, Viewport } from "../types";

/**
 * Shared looks for the visualizer models: fading trails with an optional
 * zoom-and-spin "tunnel" feedback, glowing sprites, and colour helpers.
 */

/** The near-black the visualizers fade toward. */
export const BACKGROUND = "#06080c";

/**
 * Video feedback: each frame the previous image is redrawn slightly faded,
 * zoomed and rotated about the centre, then the model draws on top. Low
 * afterglow gives short motion trails; high afterglow with a little zoom
 * gives the classic tunnel of echoes.
 */
export class Feedback {
  private buf: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private last = 0;

  /**
   * Fade the canvas toward the background. `afterglow` is how much of the
   * picture is left after a 60th of a second, `zoom` the scale per second
   * (0 = none, 0.3 = 30% bigger each second), `spin` degrees per second.
   * `moving` false (e.g. while paused) holds the image still instead.
   */
  apply(g: CanvasRenderingContext2D, view: Viewport, afterglow: number, zoom = 0, spin = 0, moving = true): void {
    const now = performance.now();
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const keep = moving ? Math.pow(Math.min(0.995, Math.max(0, afterglow)), dt * 60) : afterglow > 0 ? 1 : 0;
    if (keep <= 0.01) {
      g.fillStyle = BACKGROUND;
      g.fillRect(0, 0, view.width, view.height);
      return;
    }
    const c = g.canvas;
    const z = moving ? 1 + zoom * dt : 1;
    const r = moving ? (spin * Math.PI / 180) * dt : 0;
    if (z === 1 && r === 0) {
      // No motion: a translucent wash is all a fade needs.
      g.globalAlpha = 1 - keep;
      g.fillStyle = BACKGROUND;
      g.fillRect(0, 0, view.width, view.height);
      g.globalAlpha = 1;
      return;
    }
    if (!this.buf || this.buf.width !== c.width || this.buf.height !== c.height) {
      this.buf = document.createElement("canvas");
      this.buf.width = c.width;
      this.buf.height = c.height;
      this.ctx = this.buf.getContext("2d");
    }
    const b = this.ctx!;
    b.globalCompositeOperation = "copy";
    b.drawImage(c, 0, 0);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = BACKGROUND;
    g.fillRect(0, 0, c.width, c.height);
    g.globalAlpha = keep;
    g.translate(c.width / 2, c.height / 2);
    g.rotate(r);
    g.scale(z, z);
    g.translate(-c.width / 2, -c.height / 2);
    g.drawImage(this.buf, 0, 0);
    g.restore();
  }
}

/**
 * The trail controls every visualizer shares, under a "Look" heading:
 * afterglow, tunnel zoom and spin.
 */
export function feedbackParams(afterglow: number, zoom = 0, spin = 0): ParamSpec[] {
  return [
    { kind: "number", key: "afterglow", label: "Afterglow", min: 0, max: 0.99, step: 0.01, default: afterglow, group: "Look",
      description: "How long everything leaves a fading trail. Near the top, trails pile up into smoky echoes." },
    { kind: "number", key: "zoom", label: "Tunnel zoom", min: -1, max: 1, step: 0.01, default: zoom, group: "Look",
      description: "Trails grow outward (positive) or shrink inward (negative), like flying through a tunnel." },
    { kind: "number", key: "spin", label: "Tunnel spin", min: -90, max: 90, step: 1, default: spin, group: "Look",
      description: "Trails turn around the centre, degrees per second. Combine with zoom for a spiral." },
  ];
}

/** Run the shared feedback with a model's afterglow / zoom / spin values. */
export function applyFeedback(fb: Feedback, g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, moving: boolean): void {
  fb.apply(g, view, p.afterglow as number, p.zoom as number, p.spin as number, moving);
}

/**
 * Soft round glow sprites, one per 10° of hue, drawn with additive blending
 * so overlapping lights add up to white-hot cores.
 */
const sprites = new Map<number, HTMLCanvasElement>();

export function glowSprite(hue: number, sat = 90): HTMLCanvasElement {
  const key = Math.round((((hue % 360) + 360) % 360) / 10) * 1000 + sat;
  let s = sprites.get(key);
  if (s) return s;
  s = document.createElement("canvas");
  s.width = s.height = 64;
  const c = s.getContext("2d")!;
  const h = Math.round((((hue % 360) + 360) % 360) / 10) * 10;
  const grad = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `hsla(${h} ${sat}% 92% / 1)`);
  grad.addColorStop(0.18, `hsla(${h} ${sat}% 70% / 0.75)`);
  grad.addColorStop(0.5, `hsla(${h} ${sat}% 55% / 0.18)`);
  grad.addColorStop(1, `hsla(${h} ${sat}% 50% / 0)`);
  c.fillStyle = grad;
  c.fillRect(0, 0, 64, 64);
  sprites.set(key, s);
  return s;
}

/** Ease `from` toward `to` by fraction `t`, the short way round the colour wheel. */
export function hueToward(from: number, to: number, t: number): number {
  const d = ((to - from + 540) % 360) - 180;
  return (from + d * t + 360) % 360;
}

/** The colour-scheme dropdown several visualizers share. */
export function colourParam(def: string, extra: { value: string; label: string }[] = []): ParamSpec {
  return {
    kind: "choice", key: "colours", label: "Colours", default: def, group: "Look",
    description: "Where the colours come from. Notes colours everything by the pitch of the melody.",
    options: [
      { value: "notes", label: "Follow the melody" },
      { value: "rainbow", label: "Rainbow, cycling with the beat" },
      { value: "fire", label: "Fire" },
      { value: "ice", label: "Ice" },
      ...extra,
    ],
  };
}

/**
 * A hue for something at position `t` (0..1, e.g. its height or index)
 * under the chosen scheme. `noteHue` is the melody's hue, `beats` the clock.
 */
export function schemeHue(scheme: string, t: number, noteHue: number, beats: number): number {
  switch (scheme) {
    case "rainbow": return (t * 300 + beats * 15) % 360;
    case "fire": return 5 + t * 50;
    case "ice": return 180 + t * 60;
    default: return (noteHue + (t - 0.5) * 70 + 360) % 360;
  }
}
