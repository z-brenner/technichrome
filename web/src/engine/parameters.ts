// Every adjustable quantity of the Technichrome engine, in the same JSON schema the iPhone app and the Python
// tools use (EngineParameters.swift / export_fixtures.py). technichromeV1.json is the shipped look and dyeSets.json the
// dye sets the Laboratory offers, both exported from the parity fixture; CI checks they still equal the fixture's.

import type { CurveParameters } from './curve';
import defaults from './technichromeV1.json';
import dyeSets from './dyeSets.json';

export interface DyeLobe { mu: number; sigmaLeft: number; sigmaRight: number; amplitude: number; shape: number }
export interface DyeSpectrum { lobes: DyeLobe[] }

export interface EngineParameters {
  exposureEV: number;
  separationMatrix: number[];
  negative: CurveParameters;
  dyeDMax: number[];
  dyeGain: number[];
  dyeLightEV: number[];
  matrixGamma: number;
  matrixLogE0: number;
  matrixNu: number;
  keyStrength: number;
  key: CurveParameters;
  printDMin: number;
  projectorCCT: number;
  cyan: DyeSpectrum;
  magenta: DyeSpectrum;
  yellow: DyeSpectrum;
  surroundExponent: number;
  screenFlare: number;
  timingStrength: number;
  timingTarget: number;
  timingLimit: number;
  diffusionSigmaAt4K: number;
  misregistrationAt4K: number;
  bloomAmount: number;
  bloomThreshold: number;
  bloomRadiusPercent: number;
  name: string;
}

export const TECHNICHROME_V1: EngineParameters = defaults as EngineParameters;

/** A dye set: three dyes, the gains that print greys neutral with them and the rest of the shipped look, a short
 *  label and where the spectra come from (tcengine.DYE_SETS; EngineParameters.dyeSets in the app). */
export interface DyeSetPreset { name: string; label: string; cyan: DyeSpectrum; magenta: DyeSpectrum; yellow: DyeSpectrum; dyeGain: number[]; source: string }

/** Technichrome v1's own dyes, then the sets fitted to measured Technicolor dyes (docs/COLOR_SCIENCE.md). */
export const DYE_SETS: DyeSetPreset[] = dyeSets as DyeSetPreset[];

/** Takes a dye set's dyes and gains into `p`; everything else stays. */
export function useDyeSet(p: EngineParameters, set: DyeSetPreset) {
  p.cyan = JSON.parse(JSON.stringify(set.cyan)) as DyeSpectrum;
  p.magenta = JSON.parse(JSON.stringify(set.magenta)) as DyeSpectrum;
  p.yellow = JSON.parse(JSON.stringify(set.yellow)) as DyeSpectrum;
  p.dyeGain = set.dyeGain.slice();
}

/** The dye set whose dyes and gains `p` carries, if any (none once a dye or a gain is edited). */
export function dyeSetOf(p: EngineParameters): DyeSetPreset | undefined {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return DYE_SETS.find((d) => same(d.cyan, p.cyan) && same(d.magenta, p.magenta) && same(d.yellow, p.yellow) && same(d.dyeGain, p.dyeGain));
}

export function cloneParameters(p: EngineParameters): EngineParameters {
  return JSON.parse(JSON.stringify(p)) as EngineParameters;
}

/** Tolerant decoding, like the app's: anything missing takes the shipped value; lobes without `shape` are Gaussian. */
export function parametersFromJSON(json: unknown): EngineParameters {
  if (typeof json !== 'object' || json === null) throw new Error('parameters JSON must be an object');
  const src = json as Record<string, unknown>;
  const out = cloneParameters(TECHNICHROME_V1);
  const num = (k: keyof EngineParameters) => { const v = src[k]; if (typeof v === 'number' && Number.isFinite(v)) (out as any)[k] = v; };
  const arr = (k: keyof EngineParameters, n: number) => {
    const v = src[k];
    if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number')) (out as any)[k] = v.slice();
    else if (Array.isArray(v)) throw new Error(`${k} must have ${n} values`);
  };
  const curve = (k: 'negative' | 'key') => {
    const v = src[k] as Partial<CurveParameters> | undefined;
    if (v && typeof v === 'object') out[k] = { ...out[k], ...Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number')) } as CurveParameters;
  };
  const dye = (k: 'cyan' | 'magenta' | 'yellow') => {
    const v = src[k] as { lobes?: Partial<DyeLobe>[] } | undefined;
    if (v && Array.isArray(v.lobes)) {
      out[k] = { lobes: v.lobes.map((l) => ({ mu: l.mu ?? 0, sigmaLeft: l.sigmaLeft ?? 1, sigmaRight: l.sigmaRight ?? 1, amplitude: l.amplitude ?? 0, shape: l.shape ?? 2 })) };
    }
  };
  (['exposureEV', 'matrixGamma', 'matrixLogE0', 'matrixNu', 'keyStrength', 'printDMin', 'projectorCCT', 'surroundExponent', 'screenFlare',
    'timingStrength', 'timingTarget', 'timingLimit', 'diffusionSigmaAt4K', 'misregistrationAt4K', 'bloomAmount', 'bloomThreshold', 'bloomRadiusPercent'] as const).forEach(num);
  arr('separationMatrix', 9); arr('dyeDMax', 3); arr('dyeGain', 3); arr('dyeLightEV', 3);
  curve('negative'); curve('key');
  dye('cyan'); dye('magenta'); dye('yellow');
  if (typeof src.name === 'string') out.name = src.name;
  return out;
}

/** The matrix-film characteristic for dye i: dMin 0, dMax = dyeDMax[i], shared gamma / logE0 / ν. */
export function matrixCurve(p: EngineParameters, i: number): CurveParameters {
  return { dMin: 0, dMax: p.dyeDMax[i], gamma: p.matrixGamma, logE0: p.matrixLogE0, nu: p.matrixNu };
}

/** Normalised absorbance of a dye on the spectral grid (peak = 1). */
export function absorbance(d: DyeSpectrum, grid: (mu: number, sl: number, sr: number, shape: number) => number[]): number[] {
  const n = grid(0, 1, 1, 2).length;
  const a = new Array<number>(n).fill(0);
  for (const lobe of d.lobes) {
    const g = grid(lobe.mu, lobe.sigmaLeft, lobe.sigmaRight, lobe.shape);
    for (let i = 0; i < n; i++) a[i] += lobe.amplitude * g[i];
  }
  const peak = Math.max(...a);
  return peak > 0 ? a.map((v) => v / peak) : a;
}
