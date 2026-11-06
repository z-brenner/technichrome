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

/** Wavelength grid: 360–830 nm in 5 nm steps (95 samples), the range of the CIE tables. */
export const WAVELENGTHS: number[] = [];
for (let l = 360; l <= 830; l += 5) WAVELENGTHS.push(l);
export const SAMPLE_COUNT = WAVELENGTHS.length;

// BEGIN DATA: CIE 1931 2° colour-matching functions ===============================================
// Source: CIE 2019, "Colour-matching functions of CIE 1931 standard colorimetric observer", International
//   Commission on Illumination (CIE), Vienna. DOI 10.25039/CIE.DS.xvudnb9b,
//   https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer (file CIE_xyz_1931_2deg.csv;
//   original source CIE 018:2019, The Basis of Physical Photometry, Table 6).
// Licence: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0),
//   https://creativecommons.org/licenses/by-sa/4.0/
// Changes: values unchanged, sampled every 5 nm. The CIE tabulates 360-830 nm at 1 nm; this block keeps its rows at
//   360, 365, ..., 830 nm (95 rows), digits as published (trailing zeros dropped).
/**
 * CIE 1931 2° standard observer (x̄, ȳ, z̄) on the wavelength grid, 360–830 nm every 5 nm: the CIE's table (see the
 * notice above), the same rows as SpectralMath.swift and tools/colorscience/tcspectral.py. Equal-energy white
 * integrates to xy (0.33331, 0.33329).
 */
export const CMF_TABLE: Vec3[] = [
  [0.0001299, 0.000003917, 0.0006061],  // 360
  [0.0002321, 0.000006965, 0.001086],  // 365
  [0.0004149, 0.00001239, 0.001946],  // 370
  [0.0007416, 0.00002202, 0.003486],  // 375
  [0.001368, 0.000039, 0.006450001],  // 380
  [0.002236, 0.000064, 0.01054999],  // 385
  [0.004243, 0.00012, 0.02005001],  // 390
  [0.00765, 0.000217, 0.03621],  // 395
  [0.01431, 0.000396, 0.06785001],  // 400
  [0.02319, 0.00064, 0.1102],  // 405
  [0.04351, 0.00121, 0.2074],  // 410
  [0.07763, 0.00218, 0.3713],  // 415
  [0.13438, 0.004, 0.6456],  // 420
  [0.21477, 0.0073, 1.0390501],  // 425
  [0.2839, 0.0116, 1.3856],  // 430
  [0.3285, 0.01684, 1.62296],  // 435
  [0.34828, 0.023, 1.74706],  // 440
  [0.34806, 0.0298, 1.7826],  // 445
  [0.3362, 0.038, 1.77211],  // 450
  [0.3187, 0.048, 1.7441],  // 455
  [0.2908, 0.06, 1.6692],  // 460
  [0.2511, 0.0739, 1.5281],  // 465
  [0.19536, 0.09098, 1.28764],  // 470
  [0.1421, 0.1126, 1.0419],  // 475
  [0.09564, 0.13902, 0.8129501],  // 480
  [0.05795001, 0.1693, 0.6162],  // 485
  [0.03201, 0.20802, 0.46518],  // 490
  [0.0147, 0.2586, 0.3533],  // 495
  [0.0049, 0.323, 0.272],  // 500
  [0.0024, 0.4073, 0.2123],  // 505
  [0.0093, 0.503, 0.1582],  // 510
  [0.0291, 0.6082, 0.1117],  // 515
  [0.06327, 0.71, 0.07824999],  // 520
  [0.1096, 0.7932, 0.05725001],  // 525
  [0.1655, 0.862, 0.04216],  // 530
  [0.2257499, 0.9148501, 0.02984],  // 535
  [0.2904, 0.954, 0.0203],  // 540
  [0.3597, 0.9803, 0.0134],  // 545
  [0.4334499, 0.9949501, 0.008749999],  // 550
  [0.5120501, 1.0, 0.005749999],  // 555
  [0.5945, 0.995, 0.0039],  // 560
  [0.6784, 0.9786, 0.002749999],  // 565
  [0.7621, 0.952, 0.0021],  // 570
  [0.8425, 0.9154, 0.0018],  // 575
  [0.9163, 0.87, 0.001650001],  // 580
  [0.9786, 0.8163, 0.0014],  // 585
  [1.0263, 0.757, 0.0011],  // 590
  [1.0567, 0.6949, 0.001],  // 595
  [1.0622, 0.631, 0.0008],  // 600
  [1.0456, 0.5668, 0.0006],  // 605
  [1.0026, 0.503, 0.00034],  // 610
  [0.9384, 0.4412, 0.00024],  // 615
  [0.8544499, 0.381, 0.00019],  // 620
  [0.7514, 0.321, 0.0001],  // 625
  [0.6424, 0.265, 0.00004999999],  // 630
  [0.5419, 0.217, 0.00003],  // 635
  [0.4479, 0.175, 0.00002],  // 640
  [0.3608, 0.1382, 0.00001],  // 645
  [0.2835, 0.107, 0.0],  // 650
  [0.2187, 0.0816, 0.0],  // 655
  [0.1649, 0.061, 0.0],  // 660
  [0.1212, 0.04458, 0.0],  // 665
  [0.0874, 0.032, 0.0],  // 670
  [0.0636, 0.0232, 0.0],  // 675
  [0.04677, 0.017, 0.0],  // 680
  [0.0329, 0.01192, 0.0],  // 685
  [0.0227, 0.00821, 0.0],  // 690
  [0.01584, 0.005723, 0.0],  // 695
  [0.01135916, 0.004102, 0.0],  // 700
  [0.008110916, 0.002929, 0.0],  // 705
  [0.005790346, 0.002091, 0.0],  // 710
  [0.004109457, 0.001484, 0.0],  // 715
  [0.002899327, 0.001047, 0.0],  // 720
  [0.00204919, 0.00074, 0.0],  // 725
  [0.001439971, 0.00052, 0.0],  // 730
  [0.0009999493, 0.0003611, 0.0],  // 735
  [0.0006900786, 0.0002492, 0.0],  // 740
  [0.0004760213, 0.0001719, 0.0],  // 745
  [0.0003323011, 0.00012, 0.0],  // 750
  [0.0002348261, 0.0000848, 0.0],  // 755
  [0.0001661505, 0.00006, 0.0],  // 760
  [0.000117413, 0.0000424, 0.0],  // 765
  [0.00008307527, 0.00003, 0.0],  // 770
  [0.00005870652, 0.0000212, 0.0],  // 775
  [0.00004150994, 0.00001499, 0.0],  // 780
  [0.00002935326, 0.0000106, 0.0],  // 785
  [0.00002067383, 0.0000074657, 0.0],  // 790
  [0.00001455977, 0.0000052578, 0.0],  // 795
  [0.00001025398, 0.0000037029, 0.0],  // 800
  [0.000007221456, 0.0000026078, 0.0],  // 805
  [0.000005085868, 0.0000018366, 0.0],  // 810
  [0.000003581652, 0.0000012934, 0.0],  // 815
  [0.000002522525, 0.00000091093, 0.0],  // 820
  [0.000001776509, 0.00000064153, 0.0],  // 825
  [0.000001251141, 0.00000045181, 0.0],  // 830
];
// END DATA: CIE 1931 2° colour-matching functions =================================================

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
