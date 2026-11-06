// Scalar CPU implementation of the per-pixel engine maths: the specification the GLSL follows, and what the
// parity test checks against the Python prototype's fixture. Port of ReferencePipeline.swift.

import { CharacteristicCurve } from './curve';
import { type EngineParameters, matrixCurve } from './parameters';
import { type DyeLUT, type DisplaySpace, buildLUT, lookupLUT } from './printModel';
import { type Vec3, mat3 } from './spectral';

export class ReferencePipeline {
  readonly parameters: EngineParameters;
  readonly negative: CharacteristicCurve;
  readonly matrices: CharacteristicCurve[];
  readonly key: CharacteristicCurve;
  readonly lut: DyeLUT;

  constructor(p: EngineParameters, lutDimension = 33, displaySpace: DisplaySpace = 'displayP3') {
    this.parameters = p;
    this.negative = new CharacteristicCurve(p.negative);
    this.matrices = [0, 1, 2].map((i) => new CharacteristicCurve(matrixCurve(p, i)));
    this.key = new CharacteristicCurve(p.key);
    this.lut = buildLUT(p, lutDimension, displaySpace);
  }

  /** Scene-linear sRGB-primaries RGB → normalised dye densities and key density. */
  densities(rgb: Vec3, exposureScale = Math.pow(2, this.parameters.exposureEV)): { dye: Vec3; key: number } {
    const p = this.parameters;
    // The separation applies to the scene as it is: a negative component is a colour outside sRGB (wide-gamut RAW),
    // not an impossible one. The record exposures cannot be negative and are floored before the log.
    const e: Vec3 = [rgb[0] * exposureScale, rgb[1] * exposureScale, rgb[2] * exposureScale];
    const s = mat3.apply(p.separationMatrix, e);
    const logS = s.map((v) => Math.log10(Math.max(v, 1e-6)));
    const dn = logS.map((v) => this.negative.density(v));
    const dye: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const light = p.dyeLightEV[i] * Math.log10(2);
      // Normalised by gain · D max, over which the cube's axis runs: the gain cancels (see ReferencePipeline.swift).
      const d = this.matrices[i].density(-dn[i] + light);
      dye[i] = Math.min(Math.max(d / p.dyeDMax[i], 0), 1);
    }
    const key = this.key.density(-dn[1]) * p.keyStrength;
    return { dye, key };
  }

  /** Full per-pixel develop (no spatial stages): display-linear RGB in the LUT's display space, [0,1]. */
  develop(rgb: Vec3, exposureScale?: number): Vec3 {
    const { dye, key } = this.densities(rgb, exposureScale);
    const kt = Math.pow(10, -key);
    let out = lookupLUT(this.lut, dye).map((v) => v * kt) as Vec3;
    const f = this.parameters.screenFlare;
    if (f > 0) out = out.map((v) => (v + f) / (1 + f)) as Vec3;
    const g = this.parameters.surroundExponent;
    return out.map((v) => Math.pow(Math.min(Math.max(v, 0), 1), g)) as Vec3;
  }
}
