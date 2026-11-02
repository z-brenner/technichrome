// Generalised H&D curve: density as a function of log10 exposure, as a Richards curve
//     g(x) = (1 + ν·exp(−x))^(−1/ν),   x = a·(logE − logE0) + xHalf
// Port of Technichrome/Engine/Core/CharacteristicCurve.swift; the GLSL in gl/shaders.ts implements the same.

export interface CurveParameters {
  dMin: number;
  dMax: number;
  /** Slope at the half-density point (density per log10 exposure). */
  gamma: number;
  /** log10 exposure at half density. */
  logE0: number;
  /** Asymmetry: 1 = logistic; → 0 = abrupt toe, long shoulder; > 1 = long toe. */
  nu: number;
}

export class CharacteristicCurve {
  readonly dMin: number;
  readonly span: number;
  /** Steepness in x per log10 exposure, derived so that the slope at half density equals gamma. */
  readonly a: number;
  readonly logE0: number;
  readonly nu: number;
  /** x at which g = 0.5. */
  readonly xHalf: number;

  constructor(p: CurveParameters) {
    this.dMin = p.dMin;
    this.span = p.dMax - p.dMin;
    this.nu = Math.max(p.nu, 1e-4);
    this.logE0 = p.logE0;
    this.xHalf = -Math.log((Math.pow(2, this.nu) - 1) / this.nu);
    const slopeHalf = 0.5 * (Math.pow(2, this.nu) - 1) / (this.nu * Math.pow(2, this.nu));
    this.a = this.span > 0 ? p.gamma / (this.span * slopeHalf) : 0;
  }

  density(logExposure: number): number {
    const x = this.a * (logExposure - this.logE0) + this.xHalf;
    const g = Math.pow(1 + this.nu * Math.exp(-x), -1 / this.nu);
    return this.dMin + this.span * g;
  }
}
