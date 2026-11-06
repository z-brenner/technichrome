// The web engine must agree with the Python prototype (and therefore the Swift core, which is tested against
// the same fixture) on every fixture colour: dye densities, key density and the developed output, for the shipped
// look and for each parameter variant the fixture carries (unequal dye D max; lights, flare and no key).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ReferencePipeline } from '../src/engine/reference';
import { TECHNICHROME_V1, parametersFromJSON, type EngineParameters } from '../src/engine/parameters';
import { timingExposureEV, geometricMeanLuminance } from '../src/engine/timing';
import { CMF_TABLE, WAVELENGTHS, dcrawGamma, librawGammaDecode, librawGammaEncode, srgbDecode, srgbEncode, mat3, xyzOf, SRGB_TO_XYZ, P3_TO_SRGB, P3_TO_XYZ, SRGB_TO_P3 } from '../src/engine/spectral';
import { type DisplaySpace, PrintModel, buildLUT, lookupLUT, softClipGamut } from '../src/engine/printModel';

interface Sample { input: number[]; dye: number[]; key: number; output: number[] }
interface Fixture {
  parameters: EngineParameters;
  lutDimension: number;
  displaySpace: string;
  samples: Sample[];
  variants: { name: string; parameters: EngineParameters; samples: Sample[] }[];
}

const fixturePath = fileURLToPath(new URL('../../Tests/TechnichromeCoreTests/Fixtures/parity.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const blocks = [{ name: 'shipped look', parameters: fixture.parameters, samples: fixture.samples }, ...fixture.variants];

describe('parity with the Python prototype', () => {
  it('ships the same parameters as the fixture', () => {
    expect(TECHNICHROME_V1).toEqual(fixture.parameters);
    expect(fixture.variants.map((v) => v.name)).toEqual(['unequal dye D max', 'printer lights, screen flare, no key']);
  });

  it.each(blocks.map((b) => [b.name, b] as const))('reproduces dye densities, key density and output on every fixture sample (%s)', (name, block) => {
    const pipe = new ReferencePipeline(block.parameters, fixture.lutDimension, fixture.displaySpace === 'p3' ? 'displayP3' : 'sRGB');
    let worst = 0;
    for (const s of block.samples) {
      const { dye, key } = pipe.densities(s.input as [number, number, number]);
      const out = pipe.develop(s.input as [number, number, number]);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(dye[c] - s.dye[c])).toBeLessThan(1e-7);
        expect(Math.abs(out[c] - s.output[c])).toBeLessThan(1e-6);
        worst = Math.max(worst, Math.abs(out[c] - s.output[c]));
      }
      expect(Math.abs(key - s.key)).toBeLessThan(1e-7);
    }
    console.log(`max |web - Python| output error (${name}): ${worst.toExponential(2)}`);
  });

  it('keeps greys neutral and monotonic, and prints a saturated red dark and red', () => {
    const pipe = new ReferencePipeline(TECHNICHROME_V1, 17);
    let last = Infinity;
    for (let stop = 2; stop > -8; stop -= 0.5) {
      const g = Math.pow(2, stop);
      const out = pipe.develop([g, g, g]);
      const y = (out[0] + out[1] + out[2]) / 3;
      expect(y).toBeLessThanOrEqual(last + 1e-9);
      if (y > 0.01) {
        expect(Math.abs(out[0] - out[1]) / y).toBeLessThan(0.12);
        expect(Math.abs(out[2] - out[1]) / y).toBeLessThan(0.12);
      }
      last = y;
    }
    const red = pipe.develop([0.42, 0.04, 0.045]);
    expect(red[0]).toBeGreaterThan(red[1] * 2.5);
    expect(red[0]).toBeGreaterThan(red[2] * 2.5);
    expect(red[0]).toBeLessThan(0.42);
  });

  it('keeps the deepest blacks neutral (every cube axis spans gain · D max, so cyan does not run out first)', () => {
    const pipe = new ReferencePipeline(TECHNICHROME_V1, 17);
    const white = mat3.apply(P3_TO_XYZ, [1, 1, 1]);
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    for (let stop = -7; stop >= -14; stop--) {
      const g = Math.pow(2, stop);
      const xyz = mat3.apply(P3_TO_XYZ, pipe.develop([g, g, g]));
      const [fx, fy, fz] = [0, 1, 2].map((i) => f(xyz[i] / white[i]));
      expect(Math.hypot(500 * (fx - fy), 200 * (fy - fz))).toBeLessThan(1.0);
    }
  });

  it('lifts black to the documented 1:64 floor when screen flare is on', () => {
    const p = { ...TECHNICHROME_V1, screenFlare: 1 / 64 };
    const pipe = new ReferencePipeline(p, 17);
    const black = pipe.develop([0, 0, 0]);
    const floor = Math.pow(1 / 65, p.surroundExponent);
    expect(Math.min(...black)).toBeGreaterThan(floor * 0.98);
    expect(Math.min(...pipe.develop([4, 4, 4]))).toBeGreaterThan(0.9);
  });
});

describe('print timing', () => {
  it('moves toward the target partially, clamps, and ignores the photographer\'s compensation', () => {
    const ev = timingExposureEV(0.09, 0.16, 0.6, 1.25);
    expect(ev).toBeCloseTo(0.6 * Math.log2(0.16 / 0.09), 12);
    expect(timingExposureEV(0.001, 0.16, 1, 1.25)).toBe(1.25);
    expect(timingExposureEV(2.0, 0.16, 1, 1.25)).toBe(-1.25);
    expect(timingExposureEV(0.09, 0.16, 0, 1.25)).toBe(0);
    expect(timingExposureEV(0.045, 0.16, 0.6, 1.25, -1)).toBeCloseTo(ev, 12);
  });

  it('computes a geometric mean of luminance', () => {
    const buf = new Float32Array([0.04, 0.04, 0.04, 1, 1, 1]);
    expect(geometricMeanLuminance(buf, 2, 1, 1, 1)).toBeCloseTo(0.2, 6);
  });
});

describe('the observer', () => {
  it('is the CIE 1931 2° table: equal-energy white at xy (1/3, 1/3), ȳ summing to the CIE value', () => {
    expect(WAVELENGTHS.length).toBe(95);
    expect([WAVELENGTHS[0], WAVELENGTHS[94]]).toEqual([360, 830]);
    expect(CMF_TABLE.length).toBe(WAVELENGTHS.length);
    const [x, y, z] = xyzOf(new Array<number>(WAVELENGTHS.length).fill(1));
    expect(Math.abs(x / (x + y + z) - 1 / 3)).toBeLessThan(1e-4);
    expect(Math.abs(y / (x + y + z) - 1 / 3)).toBeLessThan(1e-4);
    expect(Math.abs(y * 5 - 106.857)).toBeLessThan(0.01);
    expect(CMF_TABLE[39]).toEqual([0.5120501, 1.0, 0.005749999]);   // 555 nm, as the CIE publishes it
  });
});

describe('transfer functions and matrices', () => {
  it('inverts the sRGB curve and dcraw\'s default output curve', () => {
    expect(srgbDecode(srgbEncode(0.18))).toBeCloseTo(0.18, 9);
    const g = dcrawGamma();
    // dcraw's bisection lands the knee where the toe and the power segment meet: the BT.709 numbers.
    expect(g.knee).toBeCloseTo(0.081, 3);
    expect(g.offset).toBeCloseTo(0.099, 3);
    expect(Math.abs(g.knee / g.ts - Math.pow((g.knee + g.offset) / (1 + g.offset), 1 / g.pwr))).toBeLessThan(1e-9);
    expect(librawGammaDecode(1)).toBeCloseTo(1, 9);
    for (const r of [0.001, 0.01, 0.05, 0.18, 0.5, 0.9]) expect(librawGammaDecode(librawGammaEncode(r))).toBeCloseTo(r, 9);
  });

  it('round-trips sRGB ↔ P3', () => {
    const v = mat3.apply(P3_TO_SRGB, mat3.apply(SRGB_TO_P3, [0.2, 0.5, 0.7]));
    expect(v[0]).toBeCloseTo(0.2, 9); expect(v[1]).toBeCloseTo(0.5, 9); expect(v[2]).toBeCloseTo(0.7, 9);
    const white = mat3.apply(SRGB_TO_XYZ, [1, 1, 1]);
    expect(white[1]).toBeCloseTo(1, 9);
  });

  it('builds a LUT whose corners are white and dark', () => {
    const lut = buildLUT(TECHNICHROME_V1, 9);
    expect(Math.min(...lookupLUT(lut, [0, 0, 0]))).toBeGreaterThan(0.93);
    expect(Math.max(...lookupLUT(lut, [1, 1, 1]))).toBeLessThan(0.02);
  });

  it('bakes the factorised cube equal to the print model evaluated at every node', () => {
    const worstNode = (p: EngineParameters, dim: number, space: DisplaySpace) => {
      const lut = buildLUT(p, dim, space);
      const model = new PrintModel(p, space);
      const n = dim - 1;
      let worst = 0;
      for (let b = 0; b < dim; b++) for (let g = 0; g < dim; g++) for (let r = 0; r < dim; r++) {
        // Each axis spans gain · D max of its dye.
        const direct = softClipGamut(model.displayLinear([r / n * p.dyeDMax[0] * p.dyeGain[0], g / n * p.dyeDMax[1] * p.dyeGain[1], b / n * p.dyeDMax[2] * p.dyeGain[2]]));
        const i = ((b * dim + g) * dim + r) * 4;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(lut.data[i + c] - direct[c]));
      }
      return worst;
    };
    expect(worstNode(TECHNICHROME_V1, 17, 'displayP3')).toBeLessThan(1e-6);
    // Three different D max (each dye its own transmittance table), another lamp, the sRGB cube.
    expect(worstNode({ ...TECHNICHROME_V1, dyeDMax: [3.1, 2.6, 2.3], projectorCCT: 4800, printDMin: 0.1 }, 9, 'sRGB')).toBeLessThan(1e-6);
  });
});

describe('parameter JSON', () => {
  it('decodes an older preset tolerantly', () => {
    const p = parametersFromJSON({ exposureEV: 0.25, keyStrength: 0, cyan: { lobes: [{ mu: 650, sigmaLeft: 50, sigmaRight: 60, amplitude: 1 }] }, name: 'old' });
    expect(p.exposureEV).toBe(0.25);
    expect(p.keyStrength).toBe(0);
    expect(p.cyan.lobes[0].shape).toBe(2);
    expect(p.magenta).toEqual(TECHNICHROME_V1.magenta);
    expect(p.screenFlare).toBe(TECHNICHROME_V1.screenFlare);
    expect(() => parametersFromJSON({ separationMatrix: [1, 2, 3] })).toThrow();
  });
});
