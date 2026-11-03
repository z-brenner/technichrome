// Geometry of the loupe: where a 1:1 crop of the full decode goes, how much of the image is uploaded around
// it so that dragging mostly moves the window without a new upload, and when a new upload is due.

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/** The widest halo the dye-diffusion blur can need (the engine caps its radius at 32 texels). */
export const LOUPE_HALO = 32;
/** Extra image uploaded around the crop so that a drag mostly moves the window inside the same texture. */
export const LOUPE_MARGIN = 128;
/** What a region adds to the crop on each side; the crop must leave this much of the GPU's texture limit. */
export const LOUPE_RESERVE = LOUPE_HALO + LOUPE_MARGIN;
export const LOUPE_MAX_EDGE = 4096;

/** The crop (in full-image pixels) to show 1:1 around `point` (a preview pixel), as large as the stage allows. */
export function planCrop(full: Size, preview: Size, point: { x: number; y: number }, stage: Size, dpr: number, maxEdge: number): Rect {
  const fx = point.x * full.width / preview.width, fy = point.y * full.height / preview.height;
  const width = Math.max(32, Math.min(full.width, maxEdge, Math.round(stage.width * dpr)));
  const height = Math.max(32, Math.min(full.height, maxEdge, Math.round(stage.height * dpr)));
  return place({ x: Math.round(fx - width / 2), y: Math.round(fy - height / 2), width, height }, full);
}

/** `crop` moved to lie inside the image. */
export function place(crop: Rect, full: Size): Rect {
  return {
    x: Math.max(0, Math.min(full.width - crop.width, crop.x)),
    y: Math.max(0, Math.min(full.height - crop.height, crop.y)),
    width: crop.width, height: crop.height,
  };
}

/** The rectangle to upload for `crop`: the crop, its blur halo and a margin for dragging, clamped to the image. */
export function regionFor(crop: Rect, full: Size, margin = LOUPE_HALO + LOUPE_MARGIN): Rect {
  const x = Math.max(0, crop.x - margin), y = Math.max(0, crop.y - margin);
  return { x, y, width: Math.min(full.width, crop.x + crop.width + margin) - x, height: Math.min(full.height, crop.y + crop.height + margin) - y };
}

/** Whether `region` still serves `crop` exactly: the crop is inside it with the blur halo on every side that
 *  is not the image's own edge (where the engine's edge clamp is the right answer anyway). */
export function regionServes(crop: Rect, region: Rect, full: Size, halo = LOUPE_HALO): boolean {
  const left = region.x === 0 ? 0 : halo, top = region.y === 0 ? 0 : halo;
  const right = region.x + region.width === full.width ? 0 : halo, bottom = region.y + region.height === full.height ? 0 : halo;
  return crop.x - region.x >= left && crop.y - region.y >= top
    && region.x + region.width - (crop.x + crop.width) >= right && region.y + region.height - (crop.y + crop.height) >= bottom;
}
