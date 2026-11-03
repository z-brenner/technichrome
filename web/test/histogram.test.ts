import { describe, expect, it } from 'vitest';
import { describeClipping, histogramOf } from '../src/ui/histogram';

describe('histogram readout', () => {
  it('bins every channel and counts clipped and crushed pixels', () => {
    // 4 pixels: black, mid grey, a clipped red, white.
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 255, 255, 10, 10, 255, 254, 254, 254, 255]);
    const h = histogramOf(rgba, 4, 1);
    expect(h.count).toBe(4);
    expect(h.bins[0][0]).toBe(1); expect(h.bins[0][128]).toBe(1); expect(h.bins[0][255]).toBe(1); expect(h.bins[0][254]).toBe(1);
    expect(h.bins[1][10]).toBe(1); expect(h.bins[2][254]).toBe(1);
    expect(h.clippedHigh).toBe(0.5);
    expect(h.crushedLow).toBe(0.25);
    expect(describeClipping(h)).toBe('highlights clipped 50.0% · shadows crushed 25.0%');
  });

  it('samples on a stride', () => {
    const w = 8, ht = 6;
    const rgba = new Uint8ClampedArray(w * ht * 4).fill(100);
    const h = histogramOf(rgba, w, ht, 2);
    expect(h.count).toBe(12);
    expect(h.bins[0][100]).toBe(12);
    expect(describeClipping(h)).toBe('highlights clipped 0.0% · shadows crushed 0.0%');
  });
});
