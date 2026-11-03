import { describe, expect, it } from 'vitest';
import { decodeLook, encodeLook } from '../src/ui/looklink';
import { TECHNICHROME_V1, cloneParameters } from '../src/engine/parameters';

describe('look links', () => {
  it('round-trips a look through the hash, compactly', () => {
    const parameters = cloneParameters(TECHNICHROME_V1);
    parameters.keyStrength = 0.5; parameters.name = 'Dusk test';
    const hash = encodeLook({ parameters, printExposureEV: -0.35 });
    expect(hash.startsWith('look=')).toBe(true);
    expect(hash.length).toBeLessThan(1600);
    expect(/^look=[A-Za-z0-9_-]+$/.test(hash)).toBe(true);
    const back = decodeLook(`#${hash}`);
    expect(back?.parameters).toEqual(parameters);
    expect(back?.printExposureEV).toBe(-0.35);
    expect(decodeLook(hash)).toEqual(back);
  });

  it('ignores hashes without a look and rejects damaged ones', () => {
    expect(decodeLook('')).toBeNull();
    expect(decodeLook('#other=1')).toBeNull();
    expect(() => decodeLook('#look=not-a-look')).toThrow(/readable look/);
  });

  it('tolerates an older or partial look in the link and clamps the print exposure', () => {
    const hash = encodeLook({ parameters: TECHNICHROME_V1, printExposureEV: 7 });
    expect(decodeLook(hash)?.printExposureEV).toBe(2);
  });
});
