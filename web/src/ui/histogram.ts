// A readout of what is on screen: per-channel histograms of the rendered 8-bit pixels and how much of the
// picture is clipped at either end. Pure functions on pixel buffers, so they are unit-tested; the drawing is
// a small canvas in the Laboratory.

export interface Histogram {
  /** 256 bins per channel (R, G, B). */
  bins: [Uint32Array, Uint32Array, Uint32Array];
  /** Fraction of the pixels counted whose brightest channel is at or above 254 (clipped highlights). */
  clippedHigh: number;
  /** Fraction whose brightest channel is at or below 1 (crushed shadows). */
  crushedLow: number;
  count: number;
}

/** Histogram of an RGBA buffer, sampling every `step`-th pixel in both directions. */
export function histogramOf(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, step = 1): Histogram {
  const bins: [Uint32Array, Uint32Array, Uint32Array] = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let high = 0, low = 0, count = 0;
  const s = Math.max(1, Math.floor(step));
  for (let y = 0; y < height; y += s) {
    for (let x = 0; x < width; x += s) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      bins[0][r]++; bins[1][g]++; bins[2][b]++;
      const brightest = Math.max(r, g, b);
      if (brightest >= 254) high++;
      else if (brightest <= 1) low++;
      count++;
    }
  }
  return { bins, clippedHigh: count ? high / count : 0, crushedLow: count ? low / count : 0, count };
}

/** Draws the three channels, red, green and blue, as faint areas with a drawn edge (square-root scale, so the
 *  shape stays readable where the channels overlap, which is most of a photograph). */
export function drawHistogram(canvas: HTMLCanvasElement, h: Histogram) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, ht = canvas.height;
  ctx.clearRect(0, 0, w, ht);
  let peak = 1;
  for (const b of h.bins) for (let i = 1; i < 255; i++) peak = Math.max(peak, b[i]);   // the end bins (clipping) do not set the scale
  const scale = (v: number) => Math.min(1, Math.sqrt(v / peak));
  const fills = ['rgba(236, 80, 80, 0.16)', 'rgba(90, 200, 110, 0.16)', 'rgba(90, 140, 240, 0.16)'];
  const edges = ['rgba(236, 90, 90, 0.9)', 'rgba(100, 210, 120, 0.9)', 'rgba(110, 150, 245, 0.9)'];
  h.bins.forEach((bins, c) => {
    ctx.beginPath();
    ctx.moveTo(0, ht);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, ht - scale(bins[i]) * (ht - 3));
    ctx.lineTo(w, ht);
    ctx.closePath();
    ctx.fillStyle = fills[c];
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < 256; i++) { const x = (i / 255) * w, y = ht - scale(bins[i]) * (ht - 3); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.strokeStyle = edges[c];
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

export function describeClipping(h: Histogram): string {
  const pct = (v: number) => (v * 100 < 0.05 && v > 0 ? '<0.1' : (v * 100).toFixed(1));
  return `highlights clipped ${pct(h.clippedHigh)}% · shadows crushed ${pct(h.crushedLow)}%`;
}
