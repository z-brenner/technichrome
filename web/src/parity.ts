// Hooks for test/gl-parity.cjs:
//   __technichromeParity      renders given scene-linear colours through the WebGL pipeline and returns the
//                             display-linear P3 result, the same check the app's simulator tests run on Metal (or,
//                             with output 'sRGB', what the sRGB canvas is given: the sRGB print, encoded);
//   __technichromeTiledCheck  prints a synthetic image whole, in tiles and as a windowed crop, and returns how
//                             far the tiled and cropped results are from the whole-image render (with parameter
//                             overrides, so the halation glow and the misregistration are covered too);
//   __technichromeBloomCheck  the halation glow against a CPU reference (threshold, the same Gaussian, the
//                             per-pixel reference pipeline on scene + glow);
//   __technichromeShiftCheck  the app's own misregistration test: a uniform image shifted against itself prints
//                             unchanged, and a textured one does change.

import { type EngineParameters, TECHNICHROME_V1 } from './engine/parameters';
import { ReferencePipeline } from './engine/reference';
import { type Vec3 } from './engine/spectral';
import { GLEngine, type GlowField, glowKernel, spatialHalo } from './gl/engine';
import { renderTiled } from './gl/tiled';
import { LIBRAW16_TO_LINEAR, type StoredImage, linearRegion } from './raw/decoder';

declare global {
  interface Window {
    __technichromeParity?: (inputs: number[][], parameters: EngineParameters, lutDimension: number, output?: 'linearP3' | 'sRGB') => number[][];
    __technichromeTiledCheck?: (width: number, height: number, tile: number, overrides?: Partial<EngineParameters>) => Promise<{ tiledVsWhole: number; cropVsWhole: number; plainTiledVsWhole: number; halo: number; tiles: number }>;
    __technichromeBloomCheck?: (width: number, height: number, amount: number, threshold: number, radiusPercent: number) => { vsReference: number; effect: number; factor: number };
    __technichromeShiftCheck?: () => { uniform: number; textured: number };
  }
}

/** A 16-bit test image with edges, a gradient and texture, so the blur halo and the window offsets matter. */
function syntheticImage(width: number, height: number): StoredImage {
  const samples = new Uint16Array(width * height * 3);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inDisc = (x - width * 0.6) ** 2 + (y - height * 0.4) ** 2 < (Math.min(width, height) * 0.2) ** 2;
      const stripe = ((x >> 4) + (y >> 4)) % 2 === 0 ? 0.15 : 0;
      const base = [0.1 + 0.8 * x / width, 0.2 + 0.6 * y / height, 0.5 + 0.4 * Math.sin(x * 0.05)];
      for (let c = 0; c < 3; c++) {
        const v = Math.min(1, Math.max(0, (inDisc ? 0.95 : base[c]) + stripe + 0.05 * rnd()));
        samples[i + c] = Math.round(v * 65535);
      }
    }
  }
  return { width, height, samples, toLinear: LIBRAW16_TO_LINEAR };
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) {    // RGBA; alpha is constant
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[i + c] - b[i + c]));
  }
  return worst;
}

export function installParityHook(engine: GLEngine) {
  window.__technichromeParity = (inputs, parameters, lutDimension, output = 'linearP3') => {
    const probe = new GLEngine(document.createElement('canvas'), lutDimension);
    const n = inputs.length;
    const rgb = new Float32Array(n * 3);
    inputs.forEach((v, i) => { rgb[i * 3] = v[0]; rgb[i * 3 + 1] = v[1]; rgb[i * 3 + 2] = v[2]; });
    const source = probe.uploadLinear(rgb, n, 1);
    const target = probe.createFloatTarget(n, 1);
    probe.render(source, parameters, { exposureScale: Math.pow(2, parameters.exposureEV), spatial: false, output, target });
    const out = probe.readFloat(target);
    probe.deleteTarget(target);
    probe.deleteSource(source);
    void engine;
    return inputs.map((_, i) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]);
  };

  window.__technichromeTiledCheck = async (width, height, tile, overrides = {}) => {
    const probe = new GLEngine(document.createElement('canvas'), 17);
    const p: EngineParameters = { ...TECHNICHROME_V1, diffusionSigmaAt4K: 60, ...overrides };   // σ ≈ 5 px at this size: a 15 px halo
    const image = syntheticImage(width, height);
    const exposureScale = Math.pow(2, p.exposureEV);
    const longEdge = Math.max(width, height);
    const full = { width, height };
    // The glow is a whole-image quantity, built once (here from the whole image itself, as the page does from the preview).
    const wholeRGB = linearRegion(image, 0, 0, width, height);
    const wholeSrc = probe.uploadLinear(wholeRGB.rgb, width, height);
    const glow: GlowField | undefined = p.bloomAmount > 0 ? probe.buildGlow(wholeSrc, p) : undefined;
    const render = (plain: boolean) => {
      const target = probe.createFloatTarget(width, height);
      if (plain) probe.renderPlain(wholeSrc, exposureScale, 'linearP3', target);
      else probe.render(wholeSrc, p, { exposureScale, spatial: true, output: 'linearP3', target, glow: glow && { field: glow, full, origin: { x: 0, y: 0 } } });
      const out = probe.readFloat(target, true);
      probe.deleteTarget(target);
      return out;
    };
    const whole = render(false);
    const wholePlain = render(true);
    const tiledInto = async (plain: boolean) => {
      const out = new Float32Array(width * height * 4);
      const info = await renderTiled(probe, image, {
        parameters: p, exposureScale, output: 'linearP3', spatial: true, plain, tile, float: true, yieldBetweenTiles: false, glow,
        onTile: (pixels, t) => {
          const px = pixels as Float32Array;
          for (let row = 0; row < t.height; row++) out.set(px.subarray(row * t.width * 4, (row + 1) * t.width * 4), ((t.y + row) * width + t.x) * 4);
        },
      });
      return { out, info };
    };
    const tiled = await tiledInto(false);
    const tiledPlain = await tiledInto(true);
    // A crop the way the loupe takes it: a window at an odd offset, a halo of at least 32 px, σ from the whole image's edge.
    const win = { x: Math.floor(width * 0.37), y: Math.floor(height * 0.23), width: Math.min(141, width), height: Math.min(97, height) };
    const halo = Math.max(32, spatialHalo(p, longEdge, true));
    const region = linearRegion(image, win.x - halo, win.y - halo, win.width + 2 * halo, win.height + 2 * halo);
    const src = probe.uploadLinear(region.rgb, region.width, region.height);
    const target = probe.createFloatTarget(win.width, win.height);
    probe.render(src, p, { exposureScale, spatial: true, output: 'linearP3', target, longEdge, window: { x: win.x - region.x, y: win.y - region.y, width: win.width, height: win.height },
      glow: glow && { field: glow, full, origin: { x: region.x, y: region.y } } });
    const crop = probe.readFloat(target, true);
    probe.deleteTarget(target); probe.deleteSource(src); probe.deleteSource(wholeSrc); probe.deleteGlow(glow);
    let cropVsWhole = 0;
    for (let row = 0; row < win.height; row++) {
      const a = crop.subarray(row * win.width * 4, (row + 1) * win.width * 4);
      const b = whole.subarray(((win.y + row) * width + win.x) * 4, ((win.y + row) * width + win.x + win.width) * 4);
      cropVsWhole = Math.max(cropVsWhole, maxDiff(a, b));
    }
    return { tiledVsWhole: maxDiff(tiled.out, whole), cropVsWhole, plainTiledVsWhole: maxDiff(tiledPlain.out, wholePlain), halo: tiled.info.halo, tiles: tiled.info.tiles };
  };

  window.__technichromeBloomCheck = (width, height, amount, threshold, radiusPercent) => {
    const probe = new GLEngine(document.createElement('canvas'), 17);
    const p: EngineParameters = { ...TECHNICHROME_V1, diffusionSigmaAt4K: 0, bloomAmount: amount, bloomThreshold: threshold, bloomRadiusPercent: radiusPercent };
    const exposureScale = Math.pow(2, p.exposureEV);
    const image = syntheticImage(width, height);
    const whole = linearRegion(image, 0, 0, width, height);
    const src = probe.uploadLinear(whole.rgb, width, height);
    const full = { width, height };
    const field = probe.buildGlow(src, p);
    const target = probe.createFloatTarget(width, height);
    probe.render(src, p, { exposureScale, spatial: true, output: 'linearP3', target, glow: { field, full, origin: { x: 0, y: 0 } } });
    const gpu = probe.readFloat(target, true);
    probe.render(src, p, { exposureScale, spatial: true, output: 'linearP3', target });   // no glow field: no halation
    const without = probe.readFloat(target, true);
    probe.deleteTarget(target); probe.deleteSource(src); probe.deleteGlow(field);
    // The CPU reference: the same threshold, the same separable Gaussian with repeated edges (the glow is at full
    // resolution here: the reduction factor is 1 for a radius this small), the per-pixel pipeline on scene + glow.
    const k = glowKernel(p, Math.max(width, height));
    if (k.factor !== 1) throw new Error(`the bloom check needs a glow at full resolution (factor ${k.factor})`);
    const weights: number[] = [];
    let sum = 0;
    for (let i = 0; i <= k.radius; i++) { weights[i] = Math.exp(-0.5 * (i * i) / (k.sigma * k.sigma)); sum += i === 0 ? weights[i] : 2 * weights[i]; }
    for (let i = 0; i <= k.radius; i++) weights[i] /= sum;
    const n = width * height;
    const excess = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) excess[i] = Math.max(whole.rgb[i] - threshold, 0);
    const blurred = (input: Float32Array, dx: number, dy: number) => {
      const out = new Float32Array(n * 3);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
        let acc = input[(y * width + x) * 3 + c] * weights[0];
        for (let i = 1; i <= k.radius; i++) {
          const xa = Math.min(width - 1, Math.max(0, x + dx * i)), ya = Math.min(height - 1, Math.max(0, y + dy * i));
          const xb = Math.min(width - 1, Math.max(0, x - dx * i)), yb = Math.min(height - 1, Math.max(0, y - dy * i));
          acc += (input[(ya * width + xa) * 3 + c] + input[(yb * width + xb) * 3 + c]) * weights[i];
        }
        out[(y * width + x) * 3 + c] = acc;
      }
      return out;
    };
    const glow = blurred(blurred(excess, 1, 0), 0, 1);
    const ref = new ReferencePipeline(p, 17, 'displayP3');
    let vsReference = 0;
    for (let i = 0; i < n; i++) {
      const e: Vec3 = [0, 1, 2].map((c) => whole.rgb[i * 3 + c] + amount * glow[i * 3 + c]) as Vec3;
      const out = ref.develop(e, exposureScale);
      for (let c = 0; c < 3; c++) vsReference = Math.max(vsReference, Math.abs(out[c] - gpu[i * 4 + c]));
    }
    return { vsReference, effect: maxDiff(gpu, without), factor: k.factor };
  };

  window.__technichromeShiftCheck = () => {
    const probe = new GLEngine(document.createElement('canvas'), 17);
    const base: EngineParameters = { ...TECHNICHROME_V1, diffusionSigmaAt4K: 0 };
    const shifted: EngineParameters = { ...base, misregistrationAt4K: 2 };
    const exposureScale = Math.pow(2, base.exposureEV);
    const centre = (rgbOf: (x: number, y: number) => number[], width: number, height: number) => {
      const rgb = new Float32Array(width * height * 3);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(rgbOf(x, y), (y * width + x) * 3);
      const src = probe.uploadLinear(rgb, width, height);
      const target = probe.createFloatTarget(width, height);
      const read = (p: EngineParameters, spatial: boolean) => {
        probe.render(src, p, { exposureScale, spatial, output: 'linearP3', target, longEdge: 4000 });   // 2 px at 4K: a 2 px shift
        const out = probe.readFloat(target, true);
        const i = ((height >> 1) * width + (width >> 1)) * 4;
        return [out[i], out[i + 1], out[i + 2]];
      };
      const plain = read(base, false), moved = read(shifted, true);
      probe.deleteTarget(target); probe.deleteSource(src);
      return Math.max(...plain.map((v, c) => Math.abs(v - moved[c])));
    };
    const uniform = centre(() => [0.42, 0.04, 0.045], 16, 16);   // the app's test: a uniform image shifted against itself prints the same
    const textured = centre((x, y) => ((x + y) & 1) ? [0.9, 0.9, 0.9] : [0.05, 0.05, 0.05], 16, 16);   // a checkerboard does change
    return { uniform, textured };
  };
}
