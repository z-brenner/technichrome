import { describe, expect, it } from 'vitest';
import { LOUPE_HALO, LOUPE_MARGIN, place, planCrop, regionFor, regionServes } from '../src/ui/loupe';

const full = { width: 4032, height: 3024 };
const preview = { width: 1344, height: 1008 };

describe('loupe geometry', () => {
  it('centres a crop of the stage size in device pixels on the tapped preview point, inside the image', () => {
    const crop = planCrop(full, preview, { x: 672, y: 504 }, { width: 900, height: 600 }, 2, 4096);
    expect(crop).toEqual({ x: 2016 - 900, y: 1512 - 600, width: 1800, height: 1200 });
    const corner = planCrop(full, preview, { x: 0, y: 0 }, { width: 900, height: 600 }, 2, 4096);
    expect(corner).toEqual({ x: 0, y: 0, width: 1800, height: 1200 });
    const far = planCrop(full, preview, { x: 1344, y: 1008 }, { width: 900, height: 600 }, 2, 4096);
    expect(far).toEqual({ x: 4032 - 1800, y: 3024 - 1200, width: 1800, height: 1200 });
  });

  it('never exceeds the image, the GPU limit or the maximum edge', () => {
    const small = planCrop({ width: 500, height: 300 }, { width: 500, height: 300 }, { x: 250, y: 150 }, { width: 900, height: 600 }, 2, 4096);
    expect(small).toEqual({ x: 0, y: 0, width: 500, height: 300 });
    const limited = planCrop(full, preview, { x: 672, y: 504 }, { width: 3000, height: 3000 }, 2, 2048);
    expect([limited.width, limited.height]).toEqual([2048, 2048]);
  });

  it('uploads the crop with halo and margin, clamped to the image, and knows when a crop has left it', () => {
    const crop = { x: 1000, y: 800, width: 600, height: 400 };
    const region = regionFor(crop, full);
    const m = LOUPE_HALO + LOUPE_MARGIN;
    expect(region).toEqual({ x: 1000 - m, y: 800 - m, width: 600 + 2 * m, height: 400 + 2 * m });
    expect(regionServes(crop, region, full)).toBe(true);
    expect(regionServes(place({ ...crop, x: 1000 + LOUPE_MARGIN }, full), region, full)).toBe(true);     // margin used up exactly
    expect(regionServes(place({ ...crop, x: 1000 + LOUPE_MARGIN + 1 }, full), region, full)).toBe(false); // the halo would be short
    expect(regionServes(place({ ...crop, y: 800 - LOUPE_MARGIN - 1 }, full), region, full)).toBe(false);
    // At the image's own edge the halo is not required: the engine's edge clamp is what the whole image does there.
    const edgeCrop = { x: 0, y: 0, width: 600, height: 400 };
    const edgeRegion = regionFor(edgeCrop, full);
    expect(edgeRegion).toEqual({ x: 0, y: 0, width: 600 + m, height: 400 + m });
    expect(regionServes(edgeCrop, edgeRegion, full)).toBe(true);
    expect(regionServes({ ...edgeCrop, x: LOUPE_MARGIN + 1 }, edgeRegion, full)).toBe(false);
  });
});
