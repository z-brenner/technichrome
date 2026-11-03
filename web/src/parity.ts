// Hooks for test/gl-parity.cjs:
//   __technichromeParity      renders given scene-linear colours through the WebGL pipeline and returns the
//                             display-linear P3 result, the same check the app's simulator tests run on Metal;
//   __technichromeTiledCheck  prints a synthetic image whole, in tiles and as a windowed crop, and returns how
//                             far the tiled and cropped results are from the whole-image render.

import { type EngineParameters, TECHNICHROME_V1 } from './engine/parameters';
import { GLEngine } from './gl/engine';
import { renderTiled } from './gl/tiled';
import { LIBRAW16_TO_LINEAR, type StoredImage, linearRegion } from './raw/decoder';

declare global {
  interface Window {
    __technichromeParity?: (inputs: number[][], parameters: EngineParameters, lutDimension: number) => number[][];
    __technichromeTiledCheck?: (width: number, height: number, tile: number) => Promise<{ tiledVsWhole: number; cropVsWhole: number; plainTiledVsWhole: number; halo: number; tiles: number }>;
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
  window.__technichromeParity = (inputs, parameters, lutDimension) => {
    const probe = new GLEngine(document.createElement('canvas'), lutDimension);
    const n = inputs.length;
    const rgb = new Float32Array(n * 3);
    inputs.forEach((v, i) => { rgb[i * 3] = v[0]; rgb[i * 3 + 1] = v[1]; rgb[i * 3 + 2] = v[2]; });
    const source = probe.uploadLinear(rgb, n, 1);
    const target = probe.createFloatTarget(n, 1);
    probe.render(source, parameters, { exposureScale: Math.pow(2, parameters.exposureEV), spatial: false, output: 'linearP3', target });
    const out = probe.readFloat(target);
    probe.deleteTarget(target);
    probe.deleteSource(source);
    void engine;
    return inputs.map((_, i) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]);
  };

  window.__technichromeTiledCheck = async (width, height, tile) => {
    const probe = new GLEngine(document.createElement('canvas'), 17);
    const p: EngineParameters = { ...TECHNICHROME_V1, diffusionSigmaAt4K: 60 };   // σ ≈ 5 px at this size: a 15 px halo
    const image = syntheticImage(width, height);
    const exposureScale = Math.pow(2, p.exposureEV);
    const longEdge = Math.max(width, height);
    const render = (plain: boolean) => {
      const whole = linearRegion(image, 0, 0, width, height);
      const src = probe.uploadLinear(whole.rgb, width, height);
      const target = probe.createFloatTarget(width, height);
      if (plain) probe.renderPlain(src, exposureScale, 'linearP3', target);
      else probe.render(src, p, { exposureScale, spatial: true, output: 'linearP3', target });
      const out = probe.readFloat(target, true);
      probe.deleteTarget(target); probe.deleteSource(src);
      return out;
    };
    const whole = render(false);
    const wholePlain = render(true);
    const tiledInto = async (plain: boolean) => {
      const out = new Float32Array(width * height * 4);
      const info = await renderTiled(probe, image, {
        parameters: p, exposureScale, output: 'linearP3', spatial: true, plain, tile, float: true, yieldBetweenTiles: false,
        onTile: (pixels, t) => {
          const px = pixels as Float32Array;
          for (let row = 0; row < t.height; row++) out.set(px.subarray(row * t.width * 4, (row + 1) * t.width * 4), ((t.y + row) * width + t.x) * 4);
        },
      });
      return { out, info };
    };
    const tiled = await tiledInto(false);
    const tiledPlain = await tiledInto(true);
    // A crop the way the loupe takes it: a window at an odd offset, a 32 px halo, σ from the whole image's edge.
    const win = { x: Math.floor(width * 0.37), y: Math.floor(height * 0.23), width: Math.min(141, width), height: Math.min(97, height) };
    const halo = 32;
    const region = linearRegion(image, win.x - halo, win.y - halo, win.width + 2 * halo, win.height + 2 * halo);
    const src = probe.uploadLinear(region.rgb, region.width, region.height);
    const target = probe.createFloatTarget(win.width, win.height);
    probe.render(src, p, { exposureScale, spatial: true, output: 'linearP3', target, longEdge, window: { x: win.x - region.x, y: win.y - region.y, width: win.width, height: win.height } });
    const crop = probe.readFloat(target, true);
    probe.deleteTarget(target); probe.deleteSource(src);
    let cropVsWhole = 0;
    for (let row = 0; row < win.height; row++) {
      const a = crop.subarray(row * win.width * 4, (row + 1) * win.width * 4);
      const b = whole.subarray(((win.y + row) * width + win.x) * 4, ((win.y + row) * width + win.x + win.width) * 4);
      cropVsWhole = Math.max(cropVsWhole, maxDiff(a, b));
    }
    return { tiledVsWhole: maxDiff(tiled.out, whole), cropVsWhole, plainTiledVsWhole: maxDiff(tiledPlain.out, wholePlain), halo: tiled.info.halo, tiles: tiled.info.tiles };
  };
}
