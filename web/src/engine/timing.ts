// Print timing: the printer light that moves a scene's geometric-mean luminance toward a target key, partially
// and within a limit, with the photographer's exposure compensation excluded. Port of PrintTiming.swift.

export function timingExposureEV(geometricMean: number, target: number, strength: number, limit: number, cameraBiasEV = 0): number {
  if (!(geometricMean > 0) || !(target > 0) || !Number.isFinite(geometricMean) || !(strength > 0)) return 0;
  const placement = geometricMean / Math.pow(2, cameraBiasEV);
  const full = Math.log2(target / placement);
  const scaled = full * Math.min(Math.max(strength, 0), 1);
  const lim = Math.max(0, limit);
  return Math.min(Math.max(scaled, -lim), lim);
}

/** Geometric mean of the luminance of a scene-linear RGB buffer (sRGB-primaries weights), sampled on a stride. */
export function geometricMeanLuminance(rgb: Float32Array, width: number, height: number, exposureScale = 1, stride = 4): number {
  let sum = 0, count = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 3;
      const lum = (0.2126 * Math.max(rgb[i], 0) + 0.7152 * Math.max(rgb[i + 1], 0) + 0.0722 * Math.max(rgb[i + 2], 0)) * exposureScale;
      sum += Math.log2(Math.max(lum, 1e-5));
      count++;
    }
  }
  return count > 0 ? Math.pow(2, sum / count) : 0;
}
