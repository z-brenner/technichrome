// Tiling and stored images: tiles cover an image exactly once, regions linearise and clamp correctly, and the
// preview from stored 16-bit samples equals the preview from the same data as floats.
import { describe, expect, it } from 'vitest';
import { planTiles, tileSize } from '../src/gl/tiled';
import { LIBRAW16_TO_LINEAR, SRGB8_TO_LINEAR, type StoredImage, downsample, linearRegion, isOpenable } from '../src/raw/decoder';
import { diffusionKernel, glowKernel, misregistrationShift, spatialHalo } from '../src/gl/engine';
import { TECHNICHROME_V1 } from '../src/engine/parameters';
import { LOUPE_HALO } from '../src/ui/loupe';

function stored(width: number, height: number): StoredImage {
  const samples = new Uint16Array(width * height * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = (i * 7919) % 65536;
  return { width, height, samples, toLinear: LIBRAW16_TO_LINEAR };
}

describe('tile planning', () => {
  it('covers every pixel exactly once, row by row', () => {
    const tiles = planTiles(2500, 1700, 1024);
    expect(tiles.length).toBe(3 * 2);
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 1024, height: 1024 });
    expect(tiles[2]).toEqual({ x: 2048, y: 0, width: 452, height: 1024 });
    expect(tiles[5]).toEqual({ x: 2048, y: 1024, width: 452, height: 676 });
    const area = tiles.reduce((s, t) => s + t.width * t.height, 0);
    expect(area).toBe(2500 * 1700);
    const cover = new Uint8Array(2500 * 1700);
    for (const t of tiles) for (let y = t.y; y < t.y + t.height; y++) for (let x = t.x; x < t.x + t.width; x++) cover[y * 2500 + x]++;
    expect(cover.every((c) => c === 1)).toBe(true);
  });

  it('fits a tile and its halo into the GPU texture limit', () => {
    expect(tileSize(16384, 32)).toBe(1024);
    expect(tileSize(1024, 32)).toBe(960);
    expect(tileSize(100, 32)).toBe(64);
    expect(() => planTiles(10, 10, 0)).toThrow();
  });

  it('derives the halo from the diffusion radius the engine uses', () => {
    expect(diffusionKernel(TECHNICHROME_V1, 4000, true)).toEqual({ sigmaPx: TECHNICHROME_V1.diffusionSigmaAt4K, radius: Math.ceil(TECHNICHROME_V1.diffusionSigmaAt4K * 3) });
    expect(diffusionKernel(TECHNICHROME_V1, 4000, false)).toEqual({ sigmaPx: 0, radius: 0 });
    expect(diffusionKernel({ ...TECHNICHROME_V1, diffusionSigmaAt4K: 0.1 }, 4000, true).radius).toBe(0);   // below the 0.15 px threshold
    expect(diffusionKernel({ ...TECHNICHROME_V1, diffusionSigmaAt4K: 40 }, 4000, true).radius).toBe(32);   // capped like the shader loop
  });

  it('adds the misregistration reach to the halo and skips the shifts the app skips', () => {
    expect(misregistrationShift({ ...TECHNICHROME_V1, misregistrationAt4K: 1 }, 8000, true)).toBe(2);
    expect(misregistrationShift({ ...TECHNICHROME_V1, misregistrationAt4K: 0.04 }, 4000, true)).toBe(0);   // below the app's 0.05 px
    expect(misregistrationShift({ ...TECHNICHROME_V1, misregistrationAt4K: 1 }, 4000, false)).toBe(0);    // no spatial stages
    const blurRadius = Math.ceil(TECHNICHROME_V1.diffusionSigmaAt4K * 3);
    expect(spatialHalo(TECHNICHROME_V1, 4000, true)).toBe(blurRadius);
    expect(spatialHalo({ ...TECHNICHROME_V1, misregistrationAt4K: 1.5 }, 4000, true)).toBe(blurRadius + 3);   // 1.5 px: its neighbour, rounded up
    // The loupe's fixed halo covers every slider position up to a 16,000 px long edge.
    expect(spatialHalo({ ...TECHNICHROME_V1, diffusionSigmaAt4K: 4, misregistrationAt4K: 3 }, 16000, true)).toBeLessThanOrEqual(LOUPE_HALO);
  });

  it('reduces the glow so that its blur stays small, and never blurs below a pixel', () => {
    expect(glowKernel({ ...TECHNICHROME_V1, bloomRadiusPercent: 1.5 }, 1600)).toEqual({ sigmaPx: 24, factor: 3, sigma: 8, radius: 24 });
    expect(glowKernel({ ...TECHNICHROME_V1, bloomRadiusPercent: 0.2 }, 320)).toEqual({ sigmaPx: 1, factor: 1, sigma: 1, radius: 3 });
    expect(glowKernel({ ...TECHNICHROME_V1, bloomRadiusPercent: 5 }, 1600).factor).toBe(10);
  });
});

describe('stored images', () => {
  it('linearises a region through the table and clamps requests to the image', () => {
    const img = stored(13, 9);
    const r = linearRegion(img, 3, 2, 5, 4);
    expect([r.x, r.y, r.width, r.height]).toEqual([3, 2, 5, 4]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) for (let c = 0; c < 3; c++) {
      expect(r.rgb[(y * 5 + x) * 3 + c]).toBe(LIBRAW16_TO_LINEAR[img.samples[((y + 2) * 13 + x + 3) * 3 + c]]);
    }
    const edge = linearRegion(img, -4, -4, 20, 20);
    expect([edge.x, edge.y, edge.width, edge.height]).toEqual([0, 0, 13, 9]);
    const corner = linearRegion(img, 10, 7, 8, 8);
    expect([corner.x, corner.y, corner.width, corner.height]).toEqual([10, 7, 3, 2]);
    const empty = linearRegion(img, 30, 30, 4, 4);
    expect(empty.width).toBe(0);
  });

  it('downsamples 16-bit and float data identically', () => {
    const img = stored(40, 31);
    const floats = linearRegion(img, 0, 0, 40, 31);
    const a = downsample(img, 13);          // factor 4 → 10 × 7
    const b = downsample({ width: 40, height: 31, rgb: floats.rgb }, 13);
    expect([a.width, a.height]).toEqual([10, 7]);
    expect(a.rgb.length).toBe(b.rgb.length);
    for (let i = 0; i < a.rgb.length; i++) expect(a.rgb[i]).toBeCloseTo(b.rgb[i], 7);
    // The first output pixel is the mean of the 4 × 4 block at the top left.
    let sum = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += floats.rgb[(y * 40 + x) * 3];
    expect(a.rgb[0]).toBeCloseTo(sum / 16, 7);
    expect(downsample(img, 64)).toEqual({ width: 40, height: 31, rgb: floats.rgb });   // factor 1: the whole image as floats
  });

  it('maps 8-bit sRGB through its own table', () => {
    const samples = new Uint8ClampedArray([0, 128, 255]);
    const r = linearRegion({ width: 1, height: 1, samples, toLinear: SRGB8_TO_LINEAR }, 0, 0, 1, 1);
    expect(r.rgb[0]).toBe(0);
    expect(r.rgb[1]).toBeCloseTo(0.2158605, 5);
    expect(r.rgb[2]).toBe(1);
  });

  it('knows which file names it can try', () => {
    expect(isOpenable('IMG_0001.DNG')).toBe(true);
    expect(isOpenable('scan.tif')).toBe(true);
    expect(isOpenable('photo.jpeg')).toBe(true);
    expect(isOpenable('notes.txt')).toBe(false);
    expect(isOpenable('.DS_Store')).toBe(false);
  });
});
