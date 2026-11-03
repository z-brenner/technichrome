// Full-resolution rendering in tiles, so an image of any size prints with a bounded amount of GPU memory
// (one tile's source, three scratch targets and one output target at a time) and exactly like a whole-image
// render would: every tile is uploaded with a halo as wide as the spatial stages reach (the dye-diffusion radius
// plus the misregistration), printed through a window that leaves the halo out, and the image's own long edge sets
// the spatial scale. The halation glow, a whole-image quantity, is built once from the preview and shared by every tile.

import { type EngineParameters } from '../engine/parameters';
import { type LinearImage, type StoredImage, linearRegion } from '../raw/decoder';
import { GLEngine, type GLSource, type GlowField, type OutputMode, spatialHalo } from './engine';

export interface Tile { x: number; y: number; width: number; height: number }

/** Tiles of at most `tile` px covering a `width` × `height` image, row by row from the top left. */
export function planTiles(width: number, height: number, tile: number): Tile[] {
  if (!(tile >= 1)) throw new Error('tile size must be at least 1 px');
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) tiles.push({ x, y, width: Math.min(tile, width - x), height: Math.min(tile, height - y) });
  }
  return tiles;
}

/** The tile edge to use: `preferred` px unless the GPU's texture limit cannot hold a tile and its halo. */
export function tileSize(maxTextureSize: number, halo: number, preferred = 1024): number {
  return Math.max(64, Math.min(preferred, maxTextureSize - 2 * halo));
}

export interface TiledRenderOptions {
  parameters: EngineParameters;
  exposureScale: number;
  output: OutputMode;
  spatial: boolean;
  /** Render the plain scene (exposure only) instead of the print. */
  plain?: boolean;
  /** Tile edge in pixels (default: `tileSize` for this GPU). */
  tile?: number;
  /** Read tiles back as floats (RGBA32F, for tests) instead of 8-bit (RGBA8, for JPEGs). */
  float?: boolean;
  /** The halation glow of the whole image (see `GLEngine.buildGlow`); without it no glow is printed. */
  glow?: GlowField;
  /** Receives every tile's pixels, rows top to bottom, 4 channels. */
  onTile: (pixels: Uint8ClampedArray<ArrayBuffer> | Float32Array, tile: Tile) => void;
  onProgress?: (done: number, total: number) => void;
  /** Let the page breathe between tiles (default true). */
  yieldBetweenTiles?: boolean;
}

/** Renders `image` at full resolution, tile by tile, through `onTile`. Resolves when every tile has been delivered. */
export async function renderTiled(engine: GLEngine, image: StoredImage | LinearImage, opts: TiledRenderOptions): Promise<{ tiles: number; tile: number; halo: number }> {
  const longEdge = Math.max(image.width, image.height);
  const halo = opts.plain ? 0 : spatialHalo(opts.parameters, longEdge, opts.spatial);
  const tile = opts.tile ?? tileSize(engine.maxTextureSize, halo);
  if (tile + 2 * halo > engine.maxTextureSize) throw new Error(`a ${tile} px tile with its ${halo} px halo exceeds this GPU's texture size (${engine.maxTextureSize})`);
  const tiles = planTiles(image.width, image.height, tile);
  let source: GLSource | undefined;
  let target: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  try {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const region = linearRegion(image, t.x - halo, t.y - halo, t.width + 2 * halo, t.height + 2 * halo);
      source = engine.uploadLinear(region.rgb, region.width, region.height, source);
      if (!target || target.width !== t.width || target.height !== t.height) {
        if (target) engine.deleteTarget(target);
        target = opts.float ? engine.createFloatTarget(t.width, t.height) : engine.createByteTarget(t.width, t.height);
      }
      const window = { x: t.x - region.x, y: t.y - region.y, width: t.width, height: t.height };
      if (opts.plain) engine.renderPlain(source, opts.exposureScale, opts.output, target, window);
      else {
        const glow = opts.glow ? { field: opts.glow, full: { width: image.width, height: image.height }, origin: { x: region.x, y: region.y } } : undefined;
        engine.render(source, opts.parameters, { exposureScale: opts.exposureScale, spatial: opts.spatial, output: opts.output, target, longEdge, window, glow });
      }
      opts.onTile(opts.float ? engine.readFloat(target, true) : engine.readBytes(target), t);
      opts.onProgress?.(i + 1, tiles.length);
      if (opts.yieldBetweenTiles !== false && i + 1 < tiles.length) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    engine.deleteSource(source);
    if (target) engine.deleteTarget(target);
    engine.releaseScratch();
  }
  return { tiles: tiles.length, tile, halo };
}
