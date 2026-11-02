// Scene-linear sources for the engine, all produced on this device:
//   • a DNG (or any RAW LibRaw reads) through libraw-wasm with the settings the look was tuned on in
//     tools/colorscience/develop_dng.py — camera white balance, no auto-brightening, AHD demosaic, sRGB primaries,
//     16 bit — then LibRaw's output curve inverted exactly (see spectral.ts), which recovers the linear decode
//     to 0.02 % on the sample DNGs;
//   • any other image the browser can decode (JPEG, PNG, HEIC on Safari), linearised from its sRGB encoding:
//     display-referred data, like the HEIF fallback of a capture, and labelled as such.

import { librawGammaDecode, srgbDecode } from '../engine/spectral';

export type SourceKind = 'bayer' | 'linearDNG' | 'display';

export interface LinearImage {
  width: number;
  height: number;
  /** 3 floats per pixel, row 0 at the top, scene-linear with sRGB primaries. */
  rgb: Float32Array;
}

export interface DecodedSource {
  kind: SourceKind;
  /** What to call it: "Bayer RAW", "Linear DNG", "Not RAW". */
  label: string;
  fileName: string;
  cameraModel?: string;
  iso?: number;
  shutter?: number;
  /** DNG BaselineExposure in stops (0 when absent), applied by the engine like the app does. */
  baselineEV: number;
  full: LinearImage;
  /** A box-downsampled copy for interactive work (long edge ≤ previewLongEdge). */
  preview: LinearImage;
  decodeMs: number;
}

const ENCODED_TO_LINEAR = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) t[i] = librawGammaDecode(i / 65535);
  return t;
})();

const SRGB8_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbDecode(i / 255);
  return t;
})();

export const PREVIEW_LONG_EDGE = 1600;

/** Box-filter downsample in linear light to a long edge of at most `maxEdge` (integer factor). */
export function downsample(img: LinearImage, maxEdge = PREVIEW_LONG_EDGE): LinearImage {
  const factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxEdge));
  if (factor === 1) return img;
  const w = Math.floor(img.width / factor), h = Math.floor(img.height / factor);
  const out = new Float32Array(w * h * 3);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < factor; dy++) {
        let i = ((y * factor + dy) * img.width + x * factor) * 3;
        for (let dx = 0; dx < factor; dx++) { r += img.rgb[i]; g += img.rgb[i + 1]; b += img.rgb[i + 2]; i += 3; }
      }
      const o = (y * w + x) * 3;
      out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv;
    }
  }
  return { width: w, height: h, rgb: out };
}

type Bytes = Uint8Array<ArrayBuffer>;

function isTIFF(bytes: Bytes): boolean {
  return bytes.length > 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a));
}

const RAW_EXTENSIONS = /\.(dng|cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|raw|dcr|kdc|erf|mef|mos|mrw|3fr|fff|iiq|x3f|srw)$/i;

export function looksLikeRAW(file: File, bytes: Bytes): boolean {
  return RAW_EXTENSIONS.test(file.name) || (isTIFF(bytes) && /\.(tif|tiff)$/i.test(file.name) === false);
}

/** Decodes a RAW file with libraw-wasm into scene-linear data. Rejects with a readable message when LibRaw cannot read it. */
export async function decodeRAW(file: File, bytes: Bytes): Promise<DecodedSource> {
  const { default: LibRaw } = await import('libraw-wasm');
  const t0 = performance.now();
  const raw = new LibRaw();
  try {
    await raw.open(bytes, { useCameraWb: true, noAutoBright: true, outputBps: 16, outputColor: 1, userQual: 3, highlight: 0, gamm: [1, 1] });
    const meta = await raw.metadata(true);
    const img = await raw.imageData();
    if (!img || !(img.data instanceof Uint16Array) || img.colors !== 3) throw new Error('LibRaw returned no 16-bit RGB image for this file.');
    const n = img.width * img.height;
    const rgb = new Float32Array(n * 3);
    const src = img.data;
    for (let i = 0; i < n * 3; i++) rgb[i] = ENCODED_TO_LINEAR[src[i]];
    const full: LinearImage = { width: img.width, height: img.height, rgb };
    const filters = typeof meta?.filters === 'number' ? meta.filters : 0;
    const kind: SourceKind = filters === 0 ? 'linearDNG' : 'bayer';
    const make = String(meta?.camera_make ?? '').trim();
    const model = String(meta?.camera_model ?? '').trim();
    const baseline = meta?.color_data?.dng_levels?.baseline_exposure;
    const baselineEV = typeof baseline === 'number' && baseline > -900 && Number.isFinite(baseline) ? baseline : 0;
    const label = kind === 'bayer' ? 'Bayer RAW' : (make.toLowerCase().includes('apple') ? 'Apple ProRAW' : 'Linear DNG');
    return {
      kind, label, fileName: file.name,
      cameraModel: [make, model].filter(Boolean).join(' ') || undefined,
      iso: typeof meta?.iso_speed === 'number' && meta.iso_speed > 0 ? meta.iso_speed : undefined,
      shutter: typeof meta?.shutter === 'number' && meta.shutter > 0 ? meta.shutter : undefined,
      baselineEV, full, preview: downsample(full), decodeMs: performance.now() - t0,
    };
  } finally {
    raw.dispose();
  }
}

/** Decodes a browser-readable image (JPEG, PNG, …) and linearises it: display-referred data, not RAW. */
export async function decodeImage(file: File | Blob, name: string): Promise<DecodedSource> {
  const t0 = performance.now();
  const bitmap = await createImageBitmap(file);
  const source = linearFromBitmap(bitmap, name, t0);
  bitmap.close();
  return source;
}

export function linearFromBitmap(bitmap: ImageBitmap | HTMLVideoElement | HTMLCanvasElement, name: string, t0 = performance.now()): DecodedSource {
  const width = 'videoWidth' in bitmap ? bitmap.videoWidth : bitmap.width;
  const height = 'videoHeight' in bitmap ? bitmap.videoHeight : bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('could not create a 2D canvas');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    rgb[o] = SRGB8_TO_LINEAR[data[i]]; rgb[o + 1] = SRGB8_TO_LINEAR[data[i + 1]]; rgb[o + 2] = SRGB8_TO_LINEAR[data[i + 2]];
  }
  const full: LinearImage = { width, height, rgb };
  return { kind: 'display', label: 'Not RAW', fileName: name, baselineEV: 0, full, preview: downsample(full), decodeMs: performance.now() - t0 };
}

/** Opens any supported file: RAW through LibRaw, anything else through the browser's image decoder. */
export async function decodeFile(file: File): Promise<DecodedSource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (looksLikeRAW(file, bytes)) {
    try {
      return await decodeRAW(file, bytes);
    } catch (e) {
      if (/\.dng$/i.test(file.name)) throw new Error(`LibRaw could not decode this DNG (${(e as Error).message}). Lossy or floating-point DNGs are not supported by this build.`);
      // Fall through: maybe the browser can decode it (a TIFF, a HEIC on Safari).
    }
  }
  try {
    return await decodeImage(file, file.name);
  } catch {
    throw new Error(`This browser cannot decode ${file.name}. Open a DNG, JPEG or PNG; HEIC works in Safari only.`);
  }
}
