/**
 * A small offscreen pixel buffer for grid-based models. Models write packed
 * RGBA pixels into `pixels` (one per grid cell) and `draw` scales the buffer
 * up onto the main canvas, which is far cheaper than one fillRect per cell.
 */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint32Array;
  private readonly image: ImageData;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext("2d")!;
    this.image = this.ctx.createImageData(this.width, this.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  /** Copy `pixels` onto the buffer's canvas and return it, to draw it yourself. */
  update(): HTMLCanvasElement {
    this.ctx.putImageData(this.image, 0, 0);
    return this.canvas;
  }

  /** Blit the buffer to `g`, stretched to `w` x `h` CSS pixels. */
  draw(g: CanvasRenderingContext2D, w: number, h: number, smooth = false, x = 0, y = 0): void {
    this.update();
    const prev = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = smooth;
    g.drawImage(this.canvas, x, y, w, h);
    g.imageSmoothingEnabled = prev;
  }
}

/** Pack an opaque colour into the little-endian RGBA layout ImageData uses. */
export function rgb(r: number, g: number, b: number): number {
  return ((255 << 24) | (clamp255(b) << 16) | (clamp255(g) << 8) | clamp255(r)) >>> 0;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Build a 256-entry colour lookup table by interpolating between stops,
 * each `[position 0..1, r, g, b]`.
 */
export function palette(stops: [number, number, number, number][]): Uint32Array {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    lut[i] = rgb(r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f);
  }
  return lut;
}

/** Convert HSL (h in degrees, s and l in 0..1) to [r, g, b] in 0..255. */
export function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
