// Minimal spectral colour toolkit: CIE 1931 2° observer, black-body illuminants, RGB colour spaces and
// chromatic adaptation. A line-for-line port of Technichrome/Engine/Core/SpectralMath.swift (which itself
// mirrors tools/colorscience/tcspectral.py); the parity test compares the three.

export type Vec3 = [number, number, number];
/** 3×3 row-major matrix. */
export type Mat3 = number[];

export const mat3 = {
  identity(): Mat3 { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; },
  rows(r0: Vec3, r1: Vec3, r2: Vec3): Mat3 { return [...r0, ...r1, ...r2]; },
  apply(a: Mat3, v: Vec3): Vec3 {
    return [
      a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
      a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
      a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
    ];
  },
  mul(a: Mat3, b: Mat3): Mat3 {
    const r = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
        r[i * 3 + j] = s;
      }
    }
    return r;
  },
  transpose(m: Mat3): Mat3 { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; },
  inverse(a: Mat3): Mat3 {
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (Math.abs(det) < 1e-14) throw new Error('singular matrix');
    const inv = 1 / det;
    return [
      (a[4] * a[8] - a[5] * a[7]) * inv, (a[2] * a[7] - a[1] * a[8]) * inv, (a[1] * a[5] - a[2] * a[4]) * inv,
      (a[5] * a[6] - a[3] * a[8]) * inv, (a[0] * a[8] - a[2] * a[6]) * inv, (a[2] * a[3] - a[0] * a[5]) * inv,
      (a[3] * a[7] - a[4] * a[6]) * inv, (a[1] * a[6] - a[0] * a[7]) * inv, (a[0] * a[4] - a[1] * a[3]) * inv,
    ];
  },
  diagonal(d: Vec3): Mat3 { return [d[0], 0, 0, 0, d[1], 0, 0, 0, d[2]]; },
  row(m: Mat3, i: number): Vec3 { return [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]]; },
};

/** Wavelength grid: 380–730 nm in 5 nm steps (71 samples). */
export const WAVELENGTHS: number[] = [];
for (let l = 380; l <= 730; l += 5) WAVELENGTHS.push(l);
export const SAMPLE_COUNT = WAVELENGTHS.length;

function lobe(l: number, mu: number, s1: number, s2: number): number {
  const s = l < mu ? s1 : s2;
  const t = (l - mu) / s;
  return Math.exp(-0.5 * t * t);
}

/** CIE 1931 2° colour-matching functions, multi-lobe Gaussian fit of Wyman, Sloan & Shirley (2013). */
export function cmf(l: number): Vec3 {
  const x = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
  const y = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
  const z = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

export const CMF_TABLE: Vec3[] = WAVELENGTHS.map(cmf);

/** Relative spectral radiance of a Planckian radiator, peak-normalised, on the wavelength grid. */
export function planck(kelvin: number): number[] {
  const c1 = 3.741771e-16;
  const c2 = 1.438776e-2;
  const out = WAVELENGTHS.map((nm) => {
    const l = nm * 1e-9;
    return c1 / Math.pow(l, 5) / (Math.exp(c2 / (l * kelvin)) - 1);
  });
  const peak = Math.max(...out);
  return out.map((v) => v / peak);
}

/** Asymmetric generalised Gaussian exp(−½·|(λ−μ)/σ|^shape) on the wavelength grid. */
export function asymmetricGaussian(mu: number, sigmaLeft: number, sigmaRight: number, shape = 2): number[] {
  return WAVELENGTHS.map((l) => {
    const s = l < mu ? sigmaLeft : sigmaRight;
    return Math.exp(-0.5 * Math.pow(Math.abs((l - mu) / s), shape));
  });
}

/** ∫ spd · cmf dλ (un-normalised). */
export function xyzOf(spd: number[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < spd.length; i++) {
    const c = CMF_TABLE[i];
    x += c[0] * spd[i]; y += c[1] * spd[i]; z += c[2] * spd[i];
  }
  return [x, y, z];
}

export const D65: [number, number] = [0.3127, 0.3290];
const SRGB_PRIMARIES: [number, number][] = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
const P3_PRIMARIES: [number, number][] = [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]];

export function xyToXYZ(xy: [number, number], Y = 1): Vec3 {
  return [xy[0] * Y / xy[1], Y, (1 - xy[0] - xy[1]) * Y / xy[1]];
}

/** RGB→XYZ matrix from chromaticities (columns are the primaries' XYZ, scaled so RGB(1,1,1) = white). */
export function rgbToXYZMatrix(primaries: [number, number][], white: [number, number]): Mat3 {
  const cols = primaries.map((p): Vec3 => [p[0] / p[1], 1, (1 - p[0] - p[1]) / p[1]]);
  const M = mat3.rows([cols[0][0], cols[1][0], cols[2][0]], [cols[0][1], cols[1][1], cols[2][1]], [cols[0][2], cols[1][2], cols[2][2]]);
  const W = xyToXYZ(white);
  const S = mat3.apply(mat3.inverse(M), W);
  return mat3.rows(
    [M[0] * S[0], M[1] * S[1], M[2] * S[2]],
    [M[3] * S[0], M[4] * S[1], M[5] * S[2]],
    [M[6] * S[0], M[7] * S[1], M[8] * S[2]],
  );
}

export const SRGB_TO_XYZ = rgbToXYZMatrix(SRGB_PRIMARIES, D65);
export const XYZ_TO_SRGB = mat3.inverse(SRGB_TO_XYZ);
export const P3_TO_XYZ = rgbToXYZMatrix(P3_PRIMARIES, D65);
export const XYZ_TO_P3 = mat3.inverse(P3_TO_XYZ);
export const SRGB_TO_P3 = mat3.mul(XYZ_TO_P3, SRGB_TO_XYZ);
export const P3_TO_SRGB = mat3.inverse(SRGB_TO_P3);

const BRADFORD: Mat3 = mat3.rows([0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]);

/** Bradford chromatic adaptation from `source` white to `destination` white (both XYZ with Y = 1). */
export function bradfordAdaptation(source: Vec3, destination: Vec3): Mat3 {
  const s = mat3.apply(BRADFORD, source);
  const d = mat3.apply(BRADFORD, destination);
  const D = mat3.diagonal([d[0] / s[0], d[1] / s[1], d[2] / s[2]]);
  return mat3.mul(mat3.mul(mat3.inverse(BRADFORD), D), BRADFORD);
}

export function srgbEncode(v: number): number {
  const c = Math.min(Math.max(v, 0), 1);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * dcraw/LibRaw's output gamma curve, as `gamma_curve(pwr, ts)` builds it: a linear toe of slope `ts` joined
 * continuously to a power `pwr` segment, the knee found by bisection exactly as dcraw does. The defaults
 * (pwr 1/2.222, ts 4.5) are the BT.709 curve, which libraw-wasm applies to its output whatever gamma is
 * requested; `librawGammaDecode` inverts it to recover the linear decode.
 */
export function dcrawGamma(pwr = 1 / 2.222, ts = 4.5): { knee: number; offset: number; pwr: number; ts: number } {
  const bnd = [0, 0];
  let g2 = 0, g4 = 0;
  bnd[ts >= 1 ? 1 : 0] = 1;
  if (ts && (ts - 1) * (pwr - 1) <= 0) {
    for (let i = 0; i < 48; i++) {
      g2 = (bnd[0] + bnd[1]) / 2;
      bnd[(Math.pow(g2 / ts, -pwr) - 1) / pwr - 1 / g2 > -1 ? 1 : 0] = g2;
    }
    g4 = g2 * (1 / pwr - 1);
  }
  return { knee: g2, offset: g4, pwr, ts };
}

const LIBRAW_DEFAULT_GAMMA = dcrawGamma();

/** Encoded → linear for LibRaw's default output curve (BT.709 form). */
export function librawGammaDecode(v: number, g = LIBRAW_DEFAULT_GAMMA): number {
  return v < g.knee ? v / g.ts : Math.pow((v + g.offset) / (1 + g.offset), 1 / g.pwr);
}

/** Linear → encoded, the curve LibRaw applies (for tests and for undoing on the way in). */
export function librawGammaEncode(r: number, g = LIBRAW_DEFAULT_GAMMA): number {
  return r < g.knee / g.ts ? r * g.ts : Math.pow(r, g.pwr) * (1 + g.offset) - g.offset;
}
