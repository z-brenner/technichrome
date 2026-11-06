// The "virtual dye-transfer print": three dyes with spectral absorbances, a neutral base density, a projector
// lamp, the CIE observer and chromatic adaptation of the screen white to the display. Baked into the dye cube
// (factorised per dye), never evaluated per pixel; `xyz` is the direct evaluation the bake is tested against.
// Port of PrintModel.swift and LUTBuilder.swift.

import { type EngineParameters, absorbance } from './parameters';
import { CMF_TABLE, SAMPLE_COUNT, D65, type Mat3, type Vec3, asymmetricGaussian, bradfordAdaptation, mat3, planck, xyToXYZ, xyzOf, XYZ_TO_P3, XYZ_TO_SRGB } from './spectral';

export type DisplaySpace = 'displayP3' | 'sRGB';

export class PrintModel {
  readonly absorbances: number[][];
  readonly projector: number[];
  readonly printDMin: number;
  readonly whiteScale: number;
  readonly xyzToDisplay: Mat3;

  constructor(p: EngineParameters, displaySpace: DisplaySpace = 'displayP3') {
    this.absorbances = [absorbance(p.cyan, asymmetricGaussian), absorbance(p.magenta, asymmetricGaussian), absorbance(p.yellow, asymmetricGaussian)];
    this.projector = planck(p.projectorCCT);
    this.printDMin = p.printDMin;
    const baseT = Math.pow(10, -p.printDMin);
    const whiteXYZ = xyzOf(this.projector.map((v) => v * baseT));
    this.whiteScale = 1 / whiteXYZ[1];
    const srcWhite: Vec3 = [whiteXYZ[0] * this.whiteScale, whiteXYZ[1] * this.whiteScale, whiteXYZ[2] * this.whiteScale];
    const cat = bradfordAdaptation(srcWhite, xyToXYZ(D65));
    this.xyzToDisplay = mat3.mul(displaySpace === 'displayP3' ? XYZ_TO_P3 : XYZ_TO_SRGB, cat);
  }

  /** XYZ of the print, relative to the print white (Y_white = 1), for absolute dye densities. */
  xyz(d: Vec3): Vec3 {
    let x = 0, y = 0, z = 0;
    const [ac, am, ay] = this.absorbances;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const density = d[0] * ac[i] + d[1] * am[i] + d[2] * ay[i] + this.printDMin;
      const t = Math.pow(10, -density) * this.projector[i];
      const c = CMF_TABLE[i];
      x += c[0] * t; y += c[1] * t; z += c[2] * t;
    }
    return [x * this.whiteScale, y * this.whiteScale, z * this.whiteScale];
  }

  displayLinear(d: Vec3): Vec3 {
    return mat3.apply(this.xyzToDisplay, this.xyz(d));
  }
}

/** Bring out-of-gamut colours inside [0,1]: chroma scaled toward luminance for negatives, a soft knee above 0.95. */
export function softClipGamut(rgb: Vec3): Vec3 {
  const Y = 0.2290 * rgb[0] + 0.6917 * rgb[1] + 0.0793 * rgb[2];
  const mn = Math.min(rgb[0], rgb[1], rgb[2]);
  let c: Vec3 = rgb;
  if (mn < 0) {
    const t = Y / Math.max(Y - mn, 1e-9);
    c = [Y + (rgb[0] - Y) * t, Y + (rgb[1] - Y) * t, Y + (rgb[2] - Y) * t];
  }
  const k = 0.95;
  const knee = (v: number) => (v > k ? k + (1 - k) * Math.tanh((v - k) / (1 - k)) : v);
  return [Math.min(Math.max(knee(c[0]), 0), 1), Math.min(Math.max(knee(c[1]), 0), 1), Math.min(Math.max(knee(c[2]), 0), 1)];
}

/** The baked dye cube: dimension³ × RGBA float32, red (cyan) fastest, then green (magenta), then blue (yellow). */
export interface DyeLUT { dimension: number; data: Float32Array }

/** Bakes the cube, factorised per dye as LUTBuilder.swift does: 10^−(d_c·a_c(λ) + d_m·a_m(λ) + d_y·a_y(λ) + Dmin)
 *  = T_c(λ)·T_m(λ)·T_y(λ)·10^−Dmin, so three tables of dimension × wavelengths transmittances replace a power per
 *  entry and wavelength. Equal at every node to `softClipGamut(model.displayLinear(d))` (the parity test checks it). */
export function buildLUT(p: EngineParameters, dimension = 33, displaySpace: DisplaySpace = 'displayP3'): DyeLUT {
  const model = new PrintModel(p, displaySpace);
  const L = SAMPLE_COUNT;
  const n = dimension - 1;
  const transmittances = (k: number) => {   // 10^−(j/n · Dmax · gain · a(λ)) for dye k, node j major: each axis spans gain · D max
    const a = model.absorbances[k];
    const t = new Float64Array(dimension * L);
    for (let j = 0; j < dimension; j++) {
      const d = j / n * p.dyeDMax[k] * p.dyeGain[k];
      for (let i = 0; i < L; i++) t[j * L + i] = Math.pow(10, -d * a[i]);
    }
    return t;
  };
  const tc = transmittances(0), tm = transmittances(1), ty = transmittances(2);
  // The lamp through the clear base, seen by the observer, relative to the print white; then through magenta and yellow.
  const base = Math.pow(10, -model.printDMin) * model.whiteScale;
  const light = new Float64Array(3 * L);
  for (let i = 0; i < L; i++) {
    const s = model.projector[i] * base;
    light[i] = CMF_TABLE[i][0] * s; light[L + i] = CMF_TABLE[i][1] * s; light[2 * L + i] = CMF_TABLE[i][2] * s;
  }
  const through = new Float64Array(3 * L);
  const data = new Float32Array(dimension * dimension * dimension * 4);
  let idx = 0;
  for (let b = 0; b < dimension; b++) {
    for (let g = 0; g < dimension; g++) {
      for (let i = 0; i < L; i++) {
        const t = tm[g * L + i] * ty[b * L + i];
        through[i] = light[i] * t; through[L + i] = light[L + i] * t; through[2 * L + i] = light[2 * L + i] * t;
      }
      for (let r = 0; r < dimension; r++) {
        let x = 0, y = 0, z = 0;
        const o = r * L;
        for (let i = 0; i < L; i++) {
          const t = tc[o + i];
          x += through[i] * t; y += through[L + i] * t; z += through[2 * L + i] * t;
        }
        const rgb = softClipGamut(mat3.apply(model.xyzToDisplay, [x, y, z]));
        data[idx] = rgb[0]; data[idx + 1] = rgb[1]; data[idx + 2] = rgb[2]; data[idx + 3] = 1;
        idx += 4;
      }
    }
  }
  return { dimension, data };
}

/** Trilinear lookup with normalised densities in [0,1]³ (the same arithmetic as the GPU cube). */
export function lookupLUT(lut: DyeLUT, v: Vec3): Vec3 {
  const dim = lut.dimension;
  const n = dim - 1;
  const c = [Math.min(Math.max(v[0], 0), 1) * n, Math.min(Math.max(v[1], 0), 1) * n, Math.min(Math.max(v[2], 0), 1) * n];
  const i0 = [Math.min(Math.floor(c[0]), dim - 2), Math.min(Math.floor(c[1]), dim - 2), Math.min(Math.floor(c[2]), dim - 2)];
  const f = [c[0] - i0[0], c[1] - i0[1], c[2] - i0[2]];
  const out: Vec3 = [0, 0, 0];
  for (let dr = 0; dr <= 1; dr++) {
    for (let dg = 0; dg <= 1; dg++) {
      for (let db = 0; db <= 1; db++) {
        const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
        const i = (((i0[2] + db) * dim + (i0[1] + dg)) * dim + (i0[0] + dr)) * 4;
        out[0] += lut.data[i] * w; out[1] += lut.data[i + 1] * w; out[2] += lut.data[i + 2] * w;
      }
    }
  }
  return out;
}
