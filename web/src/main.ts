// Technichrome in the browser. One screen: open photographs (one, several, a folder) or use the camera, see the
// print, hold to compare with the plain decode, double-tap for a 1:1 crop and drag it around, step through the
// set with ← →, pin a look as A and hold to compare looks, adjust in the Laboratory, save a JPEG at full
// resolution or the whole set as a zip. Everything happens in this tab.

import { type EngineParameters, cloneParameters, parametersFromJSON } from './engine/parameters';
import { geometricMeanLuminance, timingExposureEV } from './engine/timing';
import { GLEngine, type GLSource, type SourceWindow } from './gl/engine';
import { renderTiled } from './gl/tiled';
import { type DecodedSource, type LinearImage, type StoredImage, decodeFile, downsample, isOpenable, linearFromBitmap, linearRegion, sourceBytes } from './raw/decoder';
import { startCamera, type CameraSession } from './ui/camera';
import { buildLab, defaultLabState, type LabState } from './ui/lab';
import { installParityHook } from './parity';
import { LOUPE_MAX_EDGE, LOUPE_RESERVE, type Rect, place, planCrop, regionFor, regionServes } from './ui/loupe';
import { uniqueName } from './ui/names';
import { decodeLook, encodeLook } from './ui/looklink';
import { escapeHTML as esc } from './ui/html';
import { describeClipping, drawHistogram, histogramOf } from './ui/histogram';
import { strToU8, zipSync } from 'fflate';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = $<HTMLCanvasElement>('view');
const stage = $<HTMLElement>('stage');
const drop = $<HTMLDivElement>('drop');
const badge = $<HTMLDivElement>('badge');
const hint = $<HTMLDivElement>('hint');
const busy = $<HTMLDivElement>('busy');
const busyText = $<HTMLDivElement>('busyText');
const info = $<HTMLDivElement>('info');
const video = $<HTMLVideoElement>('video');
const lab = $<HTMLElement>('lab');
const labBody = $<HTMLDivElement>('labBody');
const captureButton = $<HTMLButtonElement>('captureButton');
const saveButton = $<HTMLButtonElement>('saveButton');
const saveAllButton = $<HTMLButtonElement>('saveAllButton');
const stopCameraButton = $<HTMLButtonElement>('stopCameraButton');
const fileInput = $<HTMLInputElement>('fileInput');
const importInput = $<HTMLInputElement>('importInput');
const queueNav = $<HTMLDivElement>('queueNav');
const prevButton = $<HTMLButtonElement>('prevButton');
const nextButton = $<HTMLButtonElement>('nextButton');
const counter = $<HTMLSpanElement>('counter');
const pinButton = $<HTMLButtonElement>('pinButton');
const histogramCanvas = $<HTMLCanvasElement>('histogram');
const readoutText = $<HTMLDivElement>('readoutText');
const help = $<HTMLDivElement>('help');
const linkButton = $<HTMLButtonElement>('linkButton');
const status = $<HTMLDivElement>('status');
const details = $<HTMLDivElement>('details');
const detailsButton = $<HTMLButtonElement>('detailsButton');
const compare = $<HTMLDivElement>('compare');
const comparePlain = $<HTMLButtonElement>('comparePlain');
const compareA = $<HTMLButtonElement>('compareA');
const compareCamera = $<HTMLButtonElement>('compareCamera');
const lookName = $<HTMLDivElement>('lookName');

let engine: GLEngine;
try {
  engine = new GLEngine(view, 33);
} catch (e) {
  info.innerHTML = `<b>This browser cannot run the engine.</b> ${esc((e as Error).message)}`;
  throw e;
}
const output = engine.supportsP3Canvas ? 'displayP3' : 'sRGB';
for (const id of ['renderingNote', 'helpNote']) $<HTMLSpanElement>(id).textContent = `The same engine as the iPhone app, rendering in ${engine.supportsP3Canvas ? 'Display P3' : 'sRGB'}.`;

const state: LabState = defaultLabState();
let source: DecodedSource | null = null;
let previewTexture: GLSource | null = null;
let timingEV = 0;
let comparing = false;
let camera: CameraSession | null = null;
let cameraTexture: GLSource | null = null;
let cameraTimingEV = 0;
let frameCounter = 0;
let rafHandle = 0;

/** A look pinned as "A": the parameters and print exposure to hold against the current ones. */
interface Look { parameters: EngineParameters; printExposureEV: number; timingEV: number }
let pinned: Look | null = null;
let showingA = false;

/** The photographs opened together, decoded on demand and kept up to a memory budget. */
interface Entry { file: File; source?: DecodedSource; pending?: Promise<DecodedSource>; lastUsed: number }
let queue: Entry[] = [];
let queueIndex = -1;
let openSerial = 0;
let useClock = 0;
const CACHE_BUDGET_BYTES = 700e6;

/** The camera's own rendering (the JPEG embedded in the file), decoded on first use and kept for the current source. */
let cameraBitmap: { source: DecodedSource; bitmap: ImageBitmap } | null = null;
let cameraFrameTexture: GLSource | null = null;
let cameraHeld = false;       // what the user asks for
let showingCamera = false;    // what is on screen (follows cameraHeld once the JPEG is decoded)
const cameraScratch = document.createElement('canvas');
// On a P3 canvas the scratch context is P3 too, so a Display P3 JPEG (an iPhone's) keeps its colours; the frame is then
// shown as it is, with no sRGB→P3 conversion, because its encoding already matches the drawing buffer.
let cameraScratchContext: CanvasRenderingContext2D | null = null;

/** The loupe: a crop of the full decode shown 1:1 in device pixels, from a region uploaded with halo and margin. */
let loupe: { crop: Rect; region: Rect; texture: GLSource } | null = null;

/** A running "save all": progress for the overlay, and a flag Escape sets. */
let batch: { done: number; total: number; cancelled: boolean } | null = null;

buildLab(labBody, state, () => scheduleRender());
installParityHook(engine);

// MARK: helpers

function setBusy(on: boolean, text = '') { busy.hidden = !on; busyText.textContent = text; busyText.hidden = !text; }

function exposureScaleFor(p: EngineParameters, baselineEV: number, extraEV: number): number {
  return Math.pow(2, p.exposureEV + baselineEV + extraEV);
}

/** The look being shown: A while it is held, otherwise the Laboratory's. */
function look(): Look {
  if (showingA && pinned) return pinned;
  return { parameters: state.parameters, printExposureEV: state.printExposureEV, timingEV };
}

function fmtEV(v: number): string { return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`; }

function describe(): string {
  if (camera && !source) return `<b>Camera</b> · ${camera.width}×${camera.height} · not RAW · timed ${fmtEV(cameraTimingEV)}`;
  if (!source) return 'Open a photograph to begin.';
  const L = look();
  // Everything here that came from a file, a camera or a link is escaped: the info line is HTML.
  const parts: string[] = [];
  if (queueIndex >= 0 && queue[queueIndex]?.source === source && queue.length > 1) parts.push(`<b>${queueIndex + 1} / ${queue.length}</b>`);
  parts.push(`<b>${esc(source.label)}</b>`);
  parts.push(`${source.full.width}×${source.full.height}`);
  parts.push(`timed ${fmtEV(L.timingEV)}`);
  if (L.printExposureEV !== 0) parts.push(`print ${fmtEV(L.printExposureEV)}`);
  if (loupe) parts.push(`1:1 crop at ${loupe.crop.x},${loupe.crop.y}`);
  if (batch) parts.push(`<b>saving the set · ${batch.done} / ${batch.total}</b>`);
  if (showingCamera && cameraBitmap?.source === source) {
    // The bitmap's size is after the browser applied the JPEG's orientation, which is how it is compared to the decode.
    const b = cameraBitmap.bitmap;
    const scaled = b.width < source.full.width || b.height < source.full.height;
    parts.push(`<b>the camera's own rendering · ${b.width}×${b.height}${scaled ? ' preview, scaled' : ''}</b>`);
  } else if (showingA && pinned) parts.push(`<b>showing A · ${esc(pinned.parameters.name)}</b>`);
  else if (comparing) parts.push('<b>the plain decode</b>');
  return parts.join(' · ');
}

/** The second line, shown on request: where the photograph came from and how it was read. */
function describeDetails(): string {
  if (!source) return '';
  const L = look();
  const parts: string[] = [];
  if (source.cameraModel) parts.push(esc(source.cameraModel));
  if (source.iso) parts.push(`ISO ${source.iso.toFixed(0)}`);
  if (source.shutter) parts.push(source.shutter >= 1 ? `${source.shutter.toFixed(1)} s` : `1/${(1 / source.shutter).toFixed(0)} s`);
  if (source.baselineEV) parts.push(`baseline ${fmtEV(source.baselineEV)}`);
  parts.push(`print ${fmtEV(L.printExposureEV)}`);
  parts.push(`decoded in ${(source.decodeMs / 1000).toFixed(1)} s`);
  if (source.kind === 'display') parts.push('developed as display-referred data');
  if (source.cameraJPEG) parts.push(`embedded JPEG ${source.cameraJPEG.width}×${source.cameraJPEG.height}`);
  return parts.join(' · ');
}

/** Writes the info line and, when open, the details line. */
function refreshInfo() {
  info.innerHTML = describe();
  detailsButton.hidden = !source || !!camera;
  const open = detailsButton.getAttribute('aria-expanded') === 'true';
  details.hidden = !(open && source && !camera);
  if (!details.hidden) details.innerHTML = describeDetails();
}

/** A message of its own under the facts: cleared after a few seconds unless it is progress or an error. */
let statusTimer = 0;
function setStatus(html: string, options: { sticky?: boolean; error?: boolean } = {}) {
  window.clearTimeout(statusTimer);
  status.innerHTML = html;
  status.hidden = !html;
  status.classList.toggle('error', !!options.error);
  if (html && !options.sticky && !options.error) statusTimer = window.setTimeout(() => { status.hidden = true; }, 6000);
}
function clearStatus() { window.clearTimeout(statusTimer); status.hidden = true; status.innerHTML = ''; }

/** Touch devices get shorter hints and none about keys. */
const touchOnly = () => window.matchMedia('(hover: none)').matches;

let hintTimer = 0;
function updateHint() {
  const touch = touchOnly();
  const bits = loupe ? ['drag to move', 'double-tap to leave 1:1'] : ['hold to compare', 'double-tap for 1:1'];
  if (!touch && !loupe) bits.push('? for the keys');
  hint.textContent = bits.join(' · ');
  hint.hidden = false;
  hint.classList.remove('faded');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hint.classList.add('faded'), 5000);
}

/** Shows or hides the Laboratory. On phones it is a sheet over the lower screen: the stage then pads its bottom by
 *  exactly the overlap, so a picture of any shape fits above the sheet. */
function setLabOpen(open: boolean) {
  lab.hidden = !open;
  makeRoomForSheet();
  if (open) updateReadout();
}

function setHelpOpen(open: boolean) { help.hidden = !open; }

function makeRoomForSheet() {
  let padding = '';
  if (!lab.hidden && getComputedStyle(lab).position === 'fixed') {
    const overlap = stage.getBoundingClientRect().bottom - lab.getBoundingClientRect().top;
    if (overlap > 0) padding = `${Math.ceil(overlap) + 12}px`;
  }
  if (stage.style.paddingBottom !== padding) stage.style.paddingBottom = padding;
}
window.addEventListener('resize', makeRoomForSheet);

/** The stage's content box: what a picture may occupy (the padding, and on phones the open sheet, excluded). */
function stageArea(): { width: number; height: number } {
  const cs = getComputedStyle(stage);
  return {
    width: stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  };
}

function fitCanvas(width: number, height: number, oneToOne = false) {
  view.width = width;
  view.height = height;
  view.hidden = false;
  drop.hidden = true;
  view.classList.toggle('loupe', oneToOne);
  if (oneToOne) {
    const dpr = window.devicePixelRatio || 1;
    view.style.width = `${width / dpr}px`;
    view.style.height = `${height / dpr}px`;
  } else {
    view.style.width = '';
    view.style.height = '';
  }
}

// MARK: rendering

/** Draws the camera's JPEG (whole, scaled to the preview, or the loupe's crop at 1:1) into the canvas, colour-managed. */
function renderCameraRendering(bitmap: ImageBitmap) {
  if (!source) return;
  cameraScratchContext ??= cameraScratch.getContext('2d', output === 'displayP3' ? ({ colorSpace: 'display-p3' } as CanvasRenderingContext2DSettings) : undefined);
  const ctx = cameraScratchContext;
  if (!ctx) return;
  if (loupe) {
    const sx = bitmap.width / source.full.width, sy = bitmap.height / source.full.height;
    cameraScratch.width = loupe.crop.width; cameraScratch.height = loupe.crop.height;
    ctx.drawImage(bitmap, loupe.crop.x * sx, loupe.crop.y * sy, loupe.crop.width * sx, loupe.crop.height * sy, 0, 0, loupe.crop.width, loupe.crop.height);
  } else {
    cameraScratch.width = view.width; cameraScratch.height = view.height;
    ctx.drawImage(bitmap, 0, 0, view.width, view.height);
  }
  cameraFrameTexture = engine.uploadFrame(cameraScratch, cameraScratch.width, cameraScratch.height, cameraFrameTexture ?? undefined);
  engine.renderPlain(cameraFrameTexture, 1, 'sRGB');   // pass-through: the scratch canvas already matches the drawing buffer's colour space
}

/** The Laboratory's readout: a histogram of what is on screen and how much of it is clipped. Read after a render. */
let readoutQueued = false;
function updateReadout() {
  if (lab.hidden || readoutQueued) return;
  readoutQueued = true;
  requestAnimationFrame(() => {
    readoutQueued = false;
    if (lab.hidden || view.hidden || view.width === 0) return;
    const step = Math.max(1, Math.round(Math.sqrt((view.width * view.height) / 400_000)));   // about 400k pixels sampled
    const h = histogramOf(engine.readCanvas(), view.width, view.height, step);
    drawHistogram(histogramCanvas, h);
    const what = showingCamera ? "the camera's rendering" : comparing ? 'the plain decode' : showingA && pinned ? 'look A' : loupe ? 'the print, this crop' : camera ? 'the camera preview' : 'the print';
    readoutText.textContent = `${what} · ${describeClipping(h)}`;
  });
}

function renderStill() {
  if (!source) return;
  if (showingCamera && cameraBitmap?.source === source) { renderCameraRendering(cameraBitmap.bitmap); refreshInfo(); updateReadout(); return; }
  const L = look();
  const scale = exposureScaleFor(L.parameters, source.baselineEV, L.printExposureEV + L.timingEV);
  if (loupe) {
    const window: SourceWindow = { x: loupe.crop.x - loupe.region.x, y: loupe.crop.y - loupe.region.y, width: loupe.crop.width, height: loupe.crop.height };
    if (comparing) engine.renderPlain(loupe.texture, scale, output, null, window);
    else engine.render(loupe.texture, L.parameters, { exposureScale: scale, spatial: true, output, longEdge: Math.max(source.full.width, source.full.height), window });
  } else if (previewTexture) {
    if (comparing) engine.renderPlain(previewTexture, scale, output);
    else engine.render(previewTexture, L.parameters, { exposureScale: scale, spatial: true, output });
  }
  refreshInfo();
  updateReadout();
}

let renderQueued = false;
function scheduleRender() {
  if (camera) return;   // the camera loop renders every frame
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderStill(); });
}

function measureTiming(src: DecodedSource, p: EngineParameters): number {
  const gm = geometricMeanLuminance(src.preview.rgb, src.preview.width, src.preview.height, exposureScaleFor(p, src.baselineEV, 0), 2);
  return timingExposureEV(gm, p.timingTarget, p.timingStrength, p.timingLimit, 0);
}

function remeasure() {
  if (!source) return;
  timingEV = measureTiming(source, state.parameters);
  if (pinned) pinned.timingEV = measureTiming(source, pinned.parameters);
}

async function showSource(s: DecodedSource) {
  stopCamera();
  closeLoupe(false);
  if (cameraBitmap && cameraBitmap.source !== s) releaseCameraBitmap();   // never keep another photograph's decode alive
  engine.deleteSource(previewTexture);
  source = s;
  remeasure();
  previewTexture = engine.uploadLinear(s.preview.rgb, s.preview.width, s.preview.height);
  fitCanvas(s.preview.width, s.preview.height);
  badge.hidden = false;
  badge.textContent = s.kind === 'display' ? 'not raw · display-referred' : s.label;
  badge.classList.toggle('warn', s.kind === 'display');
  hint.hidden = false;
  updateHint();
  saveButton.hidden = false;
  captureButton.hidden = true;
  stopCameraButton.hidden = true;
  compare.hidden = false;
  compareCamera.hidden = !s.cameraJPEG;
  compareA.hidden = !pinned;
  showingCamera = false;
  clearStatus();
  renderStill();
}

/** Drops the decoded camera rendering (it belongs to one photograph; it is decoded again in a moment if asked for). */
function releaseCameraBitmap() {
  if (!cameraBitmap) return;
  cameraBitmap.bitmap.close();
  cameraBitmap = null;
  showingCamera = false;
}

/** The camera's rendering for `src`, decoded once (the browser applies the JPEG's colour profile) and kept only while
 *  `src` is the photograph shown; a decode that finishes after the photograph changed is discarded. */
async function cameraRendering(src: DecodedSource): Promise<ImageBitmap | null> {
  if (!src.cameraJPEG) return null;
  if (cameraBitmap?.source === src) return cameraBitmap.bitmap;
  // The browser decodes it, applies its colour profile and its EXIF orientation (a ProRAW's JPEG is stored in sensor orientation).
  const bitmap = await createImageBitmap(new Blob([src.cameraJPEG.bytes as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'from-image' } as ImageBitmapOptions);
  if (source !== src) { bitmap.close(); return null; }                                    // stale: the photograph changed meanwhile
  if (cameraBitmap?.source === src) { bitmap.close(); return cameraBitmap.bitmap; }       // another decode of the same one finished first
  cameraBitmap?.bitmap.close();
  cameraBitmap = { source: src, bitmap };
  return bitmap;
}

/** Hold to see the camera's own rendering; the first hold decodes the JPEG, and the screen follows the hold's state after. */
async function setCameraHeld(on: boolean) {
  cameraHeld = on;
  if (!source?.cameraJPEG || camera) return;
  if (on && cameraBitmap?.source !== source) {
    const src = source;
    let bitmap: ImageBitmap | null = null;
    try { bitmap = await cameraRendering(src); } catch (e) { setStatus(`<b>The camera's rendering could not be decoded.</b> ${esc((e as Error).message)}`, { error: true }); return; }
    if (!bitmap || source !== src) return;
  }
  if (showingCamera !== cameraHeld) { showingCamera = cameraHeld; compareCamera.classList.toggle('held', showingCamera); scheduleRender(); }
}

// MARK: the set of photographs

function updateQueueNav() {
  queueNav.hidden = queue.length < 2;
  saveAllButton.hidden = queue.length < 2;
  prevButton.disabled = queueIndex <= 0;
  nextButton.disabled = queueIndex >= queue.length - 1;
  counter.textContent = queue.length ? `${queueIndex + 1} / ${queue.length}` : '';
}

/** Drops decoded sources least recently shown until the cache fits the budget (the current one always stays). */
function evictCache() {
  const cached = queue.filter((e, i) => e.source && i !== queueIndex).sort((a, b) => a.lastUsed - b.lastUsed);
  let total = queue.reduce((sum, e) => sum + (e.source ? sourceBytes(e.source) : 0), 0);
  for (const e of cached) {
    if (total <= CACHE_BUDGET_BYTES) break;
    total -= sourceBytes(e.source!);
    delete e.source;
  }
}

/** The entry's decode: cached, or one decode per entry shared by whoever asks for it while it runs. */
async function decodeEntry(entry: Entry): Promise<DecodedSource> {
  if (entry.source) return entry.source;
  entry.pending ??= decodeFile(entry.file).finally(() => { delete entry.pending; });
  const decoded = await entry.pending;
  entry.source = decoded;
  return decoded;
}

async function showEntry(index: number) {
  if (index < 0 || index >= queue.length) return;
  const serial = ++openSerial;
  queueIndex = index;
  updateQueueNav();
  const entry = queue[index];
  if (entry.source) {
    setBusy(false);   // a decode still running for another entry no longer owns the overlay
  } else {
    setBusy(true);
    try {
      await decodeEntry(entry);
    } catch (e) {
      if (serial === openSerial) setStatus(`<b>Could not open ${esc(entry.file.name)}.</b> ${esc((e as Error).message)}`, { error: true });
      return;
    } finally {
      if (serial === openSerial) setBusy(false);
    }
    if (serial !== openSerial) { evictCache(); return; }   // the user has moved on; keep the decode for later
  }
  entry.lastUsed = ++useClock;
  evictCache();
  await showSource(entry.source!);
}

/** Opens a set of files as the new queue (sorted by name) and shows the first. A single file is always tried. */
async function openFiles(files: File[]) {
  const list = files.length === 1 ? files : files.filter((f) => isOpenable(f.name));
  if (!list.length) { setStatus('<b>Nothing to open.</b> Drop DNGs (or any RAW LibRaw reads), JPEGs or PNGs.', { error: true }); return; }
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  queue = list.map((file) => ({ file, lastUsed: 0 }));
  queueIndex = -1;
  await showEntry(0);
}

/** Files from a drop, descending into dropped folders (up to a few hundred files). */
function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? []).map((it) => (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null).filter((e): e is FileSystemEntry => !!e);
  if (!entries.some((e) => e.isDirectory)) return Promise.resolve(Array.from(dt.files));
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (out.length >= 500) return;
    if (entry.isFile) {
      const f = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      if (isOpenable(f.name)) out.push(f);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  return (async () => { for (const e of entries) await walk(e); return out; })();
}

// MARK: the loupe

/** Uploads the part of the full decode that serves `crop` (halo and drag margin included). */
function uploadLoupeRegion(crop: Rect): { region: Rect; texture: GLSource } {
  const full = source!.full;
  const want = regionFor(crop, full);
  const region = linearRegion(full, want.x, want.y, want.width, want.height);
  const texture = engine.uploadLinear(region.rgb, region.width, region.height, loupe?.texture);
  return { region: { x: region.x, y: region.y, width: region.width, height: region.height }, texture };
}

/** Opens a 1:1 crop of the full decode around a point of the canvas (CSS pixels relative to it). */
function openLoupe(cssX: number, cssY: number) {
  if (!source || camera) return;
  const point = { x: cssX * view.width / Math.max(1, view.clientWidth), y: cssY * view.height / Math.max(1, view.clientHeight) };
  const dpr = window.devicePixelRatio || 1;
  const maxEdge = Math.min(LOUPE_MAX_EDGE, engine.maxTextureSize - 2 * LOUPE_RESERVE);   // the region adds halo and margin
  const crop = planCrop(source.full, source.preview, point, stageArea(), dpr, maxEdge);
  loupe = { crop, ...uploadLoupeRegion(crop) };
  fitCanvas(crop.width, crop.height, true);
  badge.textContent = `${source.kind === 'display' ? 'not raw · display-referred' : source.label} · 1:1`;
  updateHint();
  renderStill();
}

/** Moves the crop (dragging); the texture is re-uploaded only when the crop leaves what was uploaded. */
function moveLoupe(x: number, y: number) {
  if (!loupe || !source) return;
  const crop = place({ ...loupe.crop, x: Math.round(x), y: Math.round(y) }, source.full);
  if (crop.x === loupe.crop.x && crop.y === loupe.crop.y) return;
  loupe.crop = crop;
  if (!regionServes(crop, loupe.region, source.full)) Object.assign(loupe, uploadLoupeRegion(crop));
  scheduleRender();
}

function closeLoupe(rerender = true) {
  if (!loupe) return;
  engine.deleteSource(loupe.texture);
  loupe = null;
  if (!source || !rerender) return;
  fitCanvas(source.preview.width, source.preview.height);
  badge.textContent = source.kind === 'display' ? 'not raw · display-referred' : source.label;
  updateHint();
  renderStill();
}

// MARK: camera

let cameraStarting = false;

async function openCamera() {
  if (cameraStarting) return;          // a start is already in flight
  stopCamera();                        // never run two sessions: stop the stream and its loop first
  cameraStarting = true;
  try {
    setBusy(true);
    camera = await startCamera(video);
    closeLoupe(false);
    releaseCameraBitmap();
    source = null;
    engine.deleteSource(previewTexture); previewTexture = null;
    fitCanvas(camera.width, camera.height);
    badge.hidden = false; badge.textContent = 'camera · not raw'; badge.classList.add('warn');
    hint.hidden = true;
    saveButton.hidden = true;
    captureButton.hidden = false;
    stopCameraButton.hidden = false;
    compare.hidden = true;
    clearStatus();
    cameraTimingEV = 0; frameCounter = 0;
    const loop = () => {
      if (!camera) return;
      rafHandle = requestAnimationFrame(loop);
      if (video.readyState < 2) return;
      cameraTexture = engine.uploadFrame(video, camera.width, camera.height, cameraTexture ?? undefined);
      frameCounter++;
      const L = look();
      const p = L.parameters;
      if (p.timingStrength > 0 && frameCounter % 12 === 1) {
        // Print timing from a small linearised copy of the frame, smoothed like the app's preview.
        const small = linearFromBitmap(video, 'frame');
        const gm = geometricMeanLuminance(small.preview.rgb, small.preview.width, small.preview.height, exposureScaleFor(p, 0, 0), 4);
        const measured = timingExposureEV(gm, p.timingTarget, p.timingStrength, p.timingLimit, 0);
        cameraTimingEV += 0.35 * (measured - cameraTimingEV);
      } else if (p.timingStrength <= 0) {
        cameraTimingEV = 0;
      }
      const scale = exposureScaleFor(p, 0, L.printExposureEV + cameraTimingEV);
      if (comparing) engine.renderPlain(cameraTexture, scale, output);
      else engine.render(cameraTexture, p, { exposureScale: scale, spatial: false, output });
      if (frameCounter % 15 === 0) refreshInfo();
      if (frameCounter % 30 === 0) updateReadout();
    };
    loop();
  } catch (e) {
    setStatus(`<b>The camera could not be started.</b> ${esc((e as Error).message)}`, { error: true });
  } finally {
    cameraStarting = false;
    setBusy(false);
  }
}

function stopCamera() {
  if (!camera) return;
  cancelAnimationFrame(rafHandle);
  camera.stop();
  camera = null;
  engine.deleteSource(cameraTexture); cameraTexture = null;
  captureButton.hidden = true;
  stopCameraButton.hidden = true;
}

async function photograph() {
  if (!camera) return;
  // The frame of the browser's processed stream, linearised: labelled "not RAW" everywhere it is shown.
  const frame = linearFromBitmap(video, `camera-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
  await showSource(frame);
}

// MARK: saving

/** Develops `image` tile by tile into a canvas of its size and encodes a JPEG. Throws when the browser refuses the size. */
async function developToBlob(image: StoredImage | LinearImage, p: EngineParameters, exposureScale: number, progress: (done: number, total: number) => void): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d', output === 'displayP3' ? ({ colorSpace: 'display-p3' } as CanvasRenderingContext2DSettings) : undefined);
  if (!ctx) throw new Error(`could not create a ${image.width}×${image.height} canvas`);
  await renderTiled(engine, image, {
    parameters: p, exposureScale, output, spatial: true,
    onTile: (pixels, t) => {
      const px = pixels as Uint8ClampedArray<ArrayBuffer>;
      const data = output === 'displayP3' ? new ImageData(px, t.width, t.height, { colorSpace: 'display-p3' } as ImageDataSettings) : new ImageData(px, t.width, t.height);
      ctx.putImageData(data, t.x, t.y);
    },
    onProgress: progress,
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  if (!blob) throw new Error('JPEG encoding failed');
  return blob;
}

/** The print of a source with a look, at full size, or halved when the browser cannot produce the full size
 *  (phones cap 2D canvases at around 16 megapixels). */
async function developPrint(src: DecodedSource, L: Look, progress: (done: number, total: number) => void): Promise<{ blob: Blob; width: number; height: number; note: string }> {
  // A snapshot of the look: the Laboratory stays usable while the tiles render, and every tile must print the same.
  const parameters = cloneParameters(L.parameters);
  const scale = exposureScaleFor(parameters, src.baselineEV, L.printExposureEV + L.timingEV);
  let image: StoredImage | LinearImage = src.full;
  let note = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const blob = await developToBlob(image, parameters, scale, progress);
      return { blob, width: image.width, height: image.height, note };
    } catch (e) {
      if (attempt >= 3 || Math.max(image.width, image.height) <= 2048) throw e;
      image = downsample(src.full, Math.ceil(Math.max(image.width, image.height) / 2));
      note = ` (reduced to ${image.width}×${image.height}: this browser could not produce the full size)`;
    }
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function printName(src: DecodedSource, L: Look): string {
  return `Technichrome-${src.fileName.replace(/\.[^.]+$/, '')}${L === pinned ? '-A' : ''}.jpg`;
}

async function saveJPEG() {
  if (!source || batch) return;
  setBusy(true);
  try {
    const L = look();
    const print = await developPrint(source, L, (done, total) => { if (total > 1) setStatus(`developing ${done} / ${total}`, { sticky: true }); });
    download(print.blob, printName(source, L));
    setStatus(`<b>saved ${print.width}×${print.height}</b>${esc(print.note)}`);
  } catch (e) {
    setStatus(`<b>Could not save.</b> ${esc((e as Error).message)}`, { error: true });
  } finally {
    setBusy(false);
  }
}

/** Develops every photograph of the set with the look being shown and downloads one zip: the prints and the look's JSON. */
async function saveSet() {
  if (queue.length < 2 || batch || camera) return;
  const L = look();
  const parameters = cloneParameters(L.parameters);
  const printEV = L.printExposureEV;
  const entries = queue.slice();   // the set as it is now: opening another set meanwhile does not change this batch
  batch = { done: 0, total: entries.length, cancelled: false };
  const files: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  const progress = (name: string, tiles?: string) => setBusy(true, `saving the set · ${batch!.done + 1} / ${batch!.total} · ${name}${tiles ? ` · ${tiles}` : ''} · Esc stops`);
  try {
    for (let i = 0; i < entries.length && !batch.cancelled; i++) {
      const entry = entries[i];
      progress(entry.file.name, 'decoding');
      let src: DecodedSource;
      try { src = await decodeEntry(entry); } catch (e) { skipped.push(`${entry.file.name}: ${(e as Error).message}`); batch.done++; continue; }
      entry.lastUsed = ++useClock;
      evictCache();
      if (batch.cancelled) break;
      const lookFor: Look = { parameters, printExposureEV: printEV, timingEV: measureTiming(src, parameters) };
      try {
        const print = await developPrint(src, lookFor, (done, total) => progress(entry.file.name, `${done} / ${total}`));
        // A RAW/JPEG pair or two folders can share a name: every print keeps its own entry.
        const name = uniqueName(printName(src, lookFor).replace(/\.jpg$/, ''), '.jpg', (n) => n in files);
        files[name] = new Uint8Array(await print.blob.arrayBuffer());
      } catch (e) {
        skipped.push(`${entry.file.name}: ${(e as Error).message}`);
      }
      if (!queue.includes(entry) && entry.source !== source) delete entry.source;   // no longer in the set shown: do not keep its decode
      batch.done++;
      refreshInfo();
    }
    const saved = Object.keys(files).length;
    if (saved) {
      files[`${parameters.name.replace(/\s+/g, '-') || 'technichrome'}.json`] = strToU8(JSON.stringify({ ...parameters, printExposureEV: printEV }, null, 2));
      // JPEGs do not compress: store them (level 0), which also keeps this fast on a phone.
      const zip = zipSync(files, { level: 0 });
      download(new Blob([zip as BlobPart], { type: 'application/zip' }), `Technichrome-${saved}-prints.zip`);
    }
    const cancelled = batch.cancelled;
    batch = null;
    const summary = [`<b>${cancelled ? 'stopped after' : 'saved'} ${saved} print${saved === 1 ? '' : 's'}${saved ? ' as a zip, with the look as JSON' : ''}</b>`];
    if (skipped.length) summary.push(`skipped ${skipped.length}: ${esc(skipped.join('; '))}`);
    refreshInfo();
    setStatus(summary.join(' · '), { sticky: skipped.length > 0 });
  } catch (e) {
    batch = null;
    setStatus(`<b>Could not save the set.</b> ${esc((e as Error).message)}`, { error: true });
  } finally {
    batch = null;
    setBusy(false);
  }
}

// MARK: looks A and B

function pinLook() {
  pinned = { parameters: cloneParameters(state.parameters), printExposureEV: state.printExposureEV, timingEV };
  pinButton.textContent = 'Re-pin as A';
  compareA.hidden = !source || !!camera;
  updateHint();
  setStatus('<b>pinned the current look as A</b> · hold A to see it');
}

function setShowingA(on: boolean) {
  if (!pinned || showingA === on) return;
  showingA = on;
  scheduleRender();
  compareA.classList.toggle('held', on);
  if (camera) refreshInfo();
}

// MARK: wiring

$<HTMLButtonElement>('openButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const files = Array.from(fileInput.files ?? []); fileInput.value = ''; if (files.length) void openFiles(files); });
$<HTMLButtonElement>('cameraButton').addEventListener('click', () => void openCamera());
stopCameraButton.addEventListener('click', () => { stopCamera(); if (!source) { view.hidden = true; drop.hidden = false; badge.hidden = true; } refreshInfo(); });
captureButton.addEventListener('click', () => void photograph());
saveButton.addEventListener('click', () => void saveJPEG());
saveAllButton.addEventListener('click', () => void saveSet());
prevButton.addEventListener('click', () => void showEntry(queueIndex - 1));
nextButton.addEventListener('click', () => void showEntry(queueIndex + 1));
$<HTMLButtonElement>('labButton').addEventListener('click', () => setLabOpen(lab.hidden));
$<HTMLButtonElement>('helpButton').addEventListener('click', () => setHelpOpen(help.hidden));
$<HTMLButtonElement>('helpClose').addEventListener('click', () => setHelpOpen(false));
help.addEventListener('click', (e) => { if (e.target === help) setHelpOpen(false); });
$<HTMLButtonElement>('labClose').addEventListener('click', () => setLabOpen(false));
$<HTMLButtonElement>('resetButton').addEventListener('click', () => {
  const fresh = defaultLabState();
  state.parameters = fresh.parameters; state.printExposureEV = 0;
  buildLab(labBody, state, () => scheduleRender());
  syncLookName();
  remeasure();
  scheduleRender();
  setStatus('<b>reset to Technichrome v1</b>');
});
// The look as JSON: the engine parameters (what the app and the Python tools read) plus the print exposure,
// which import restores and the app ignores.
$<HTMLButtonElement>('exportButton').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ ...state.parameters, printExposureEV: state.printExposureEV }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.parameters.name.replace(/\s+/g, '-') || 'technichrome'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});
$<HTMLButtonElement>('importButton').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async () => {
  const f = importInput.files?.[0]; importInput.value = '';
  if (!f) return;
  try {
    const json = JSON.parse(await f.text()) as { printExposureEV?: unknown };
    state.parameters = parametersFromJSON(json);
    if (typeof json.printExposureEV === 'number' && Number.isFinite(json.printExposureEV)) state.printExposureEV = Math.max(-2, Math.min(2, json.printExposureEV));
    buildLab(labBody, state, () => scheduleRender());
    syncLookName();
    remeasure();
    scheduleRender();
    setStatus(`<b>imported ${esc(f.name)}</b>`);
  } catch (e) {
    setStatus(`<b>Could not import ${esc(f.name)}.</b> ${esc((e as Error).message)}`, { error: true });
  }
});
pinButton.addEventListener('click', pinLook);

// A look as a link: put it in the address bar and on the clipboard; opening such a link applies it.
linkButton.addEventListener('click', async () => {
  const hash = encodeLook({ parameters: state.parameters, printExposureEV: state.printExposureEV });
  history.replaceState(null, '', `#${hash}`);
  let copied = false;
  try { await navigator.clipboard.writeText(location.href); copied = true; } catch { /* no clipboard access: the address bar has it */ }
  setStatus(`<b>${copied ? 'link copied' : 'the address bar now carries this look'}</b> (${(location.href.length / 1024).toFixed(1)} KB)`);
});
function applyLinkedLook() {
  if (!location.hash) return;
  try {
    const shared = decodeLook(location.hash);
    if (!shared) return;
    state.parameters = shared.parameters;
    state.printExposureEV = shared.printExposureEV;
    buildLab(labBody, state, () => scheduleRender());
    remeasure();
    scheduleRender();
    syncLookName();
    setStatus(`<b>look from the link: ${esc(shared.parameters.name)}</b>`);
  } catch (e) {
    setStatus(`<b>Could not read the look in this link.</b> ${esc((e as Error).message)}`, { error: true });
  }
}
window.addEventListener('hashchange', applyLinkedLook);
// Hold to compare: the plain decode, the look pinned as A, the camera's own JPEG. Each button is lit while held.
const holdButton = (button: HTMLButtonElement, set: (on: boolean) => void) => {
  button.addEventListener('pointerdown', (e) => { e.preventDefault(); try { button.setPointerCapture(e.pointerId); } catch { /* fine */ } set(true); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) button.addEventListener(ev, () => set(false));
};
holdButton(comparePlain, (on) => { if (comparing === on) return; comparing = on; comparePlain.classList.toggle('held', on); scheduleRender(); });
holdButton(compareA, setShowingA);
holdButton(compareCamera, (on) => void setCameraHeld(on));
detailsButton.addEventListener('click', () => {
  const open = detailsButton.getAttribute('aria-expanded') !== 'true';
  detailsButton.setAttribute('aria-expanded', String(open));
  detailsButton.textContent = open ? 'Less' : 'Details';
  refreshInfo();
});

/** The Laboratory's heading names the look in use. */
function syncLookName() { lookName.textContent = state.parameters.name || 'Untitled look'; }

// On the image: hold still to compare with the plain decode (after a short delay, so a tap does not flash),
// double-tap (or double-click) for the loupe, drag inside the loupe to move it.
let compareTimer = 0;
let lastTap = { time: 0, x: 0, y: 0 };
let drag: { pointerId: number; x: number; y: number; cropX: number; cropY: number; moved: boolean } | null = null;
const endCompare = () => { window.clearTimeout(compareTimer); if (!comparing) return; comparing = false; comparePlain.classList.remove('held'); scheduleRender(); };
view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // When the finger landed, not when a main thread busy with a render got round to the event: two quick taps
  // either side of a long frame are still one double-tap.
  const now = e.timeStamp;
  const double = now - lastTap.time < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
  lastTap = { time: double ? 0 : now, x: e.clientX, y: e.clientY };
  if (double) {
    endCompare();
    if (loupe) closeLoupe();
    else { const r = view.getBoundingClientRect(); openLoupe(e.clientX - r.left, e.clientY - r.top); }
    return;
  }
  if (loupe) {
    drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, cropX: loupe.crop.x, cropY: loupe.crop.y, moved: false };
    try { view.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
  }
  window.clearTimeout(compareTimer);
  compareTimer = window.setTimeout(() => { comparing = true; comparePlain.classList.add('held'); scheduleRender(); }, 180);
});
view.addEventListener('pointermove', (e) => {
  if (!drag || !loupe || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) { drag.moved = true; lastTap.time = 0; endCompare(); }
  const dpr = window.devicePixelRatio || 1;   // the loupe is 1:1 in device pixels, so a CSS pixel of drag is dpr image pixels
  moveLoupe(drag.cropX - dx * dpr, drag.cropY - dy * dpr);
});
const endPointer = () => { drag = null; endCompare(); };
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) view.addEventListener(ev, endPointer);
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('dblclick', (e) => e.preventDefault());

// Keys: ← → through the set, Escape leaves the loupe (then closes the Laboratory), A held shows the pinned look.
// A focused slider keeps its arrow keys; A and Escape work there too, so a look can be compared mid-adjustment.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== 'range')) return;
  const onSlider = t instanceof HTMLInputElement;
  if (e.key === 'ArrowRight' && !onSlider) { e.preventDefault(); void showEntry(queueIndex + 1); }
  else if (e.key === 'ArrowLeft' && !onSlider) { e.preventDefault(); void showEntry(queueIndex - 1); }
  else if (e.key === 'Escape') { if (!help.hidden) setHelpOpen(false); else if (batch) batch.cancelled = true; else if (loupe) closeLoupe(); else setLabOpen(false); }
  else if (e.key === '?') setHelpOpen(help.hidden);
  else if ((e.key === 'a' || e.key === 'A') && !e.repeat) setShowingA(true);
  else if ((e.key === 'c' || e.key === 'C') && !e.repeat) void setCameraHeld(true);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'a' || e.key === 'A') setShowingA(false);
  if (e.key === 'c' || e.key === 'C') void setCameraHeld(false);
});
window.addEventListener('blur', () => { setShowingA(false); void setCameraHeld(false); endPointer(); });

// Drag and drop anywhere: files, a selection of files, or a folder.
for (const ev of ['dragenter', 'dragover']) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('active'); });
for (const ev of ['dragleave', 'drop']) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('active'); });
stage.addEventListener('drop', (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  void filesFromDrop(dt).then((files) => { if (files.length) return openFiles(files); });
});

// Timing depends on the parameters, so re-measure when the Laboratory changes them.
labBody.addEventListener('input', () => { remeasure(); refreshInfo(); });

refreshInfo();
syncLookName();
applyLinkedLook();
