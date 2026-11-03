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
const showAButton = $<HTMLButtonElement>('showAButton');

let engine: GLEngine;
try {
  engine = new GLEngine(view, 33);
} catch (e) {
  info.innerHTML = `<b>This browser cannot run the engine.</b> ${(e as Error).message}`;
  throw e;
}
const output = engine.supportsP3Canvas ? 'displayP3' : 'sRGB';
$<HTMLDivElement>('engineLabel').textContent = `web · the same engine as the iPhone app · ${engine.supportsP3Canvas ? 'display p3' : 'srgb'} · nothing leaves this device`;

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
  if (camera && !source) return `<b>Camera</b> · ${camera.width}×${camera.height} · not RAW: the browser's own processed stream, linearised from sRGB · timed ${fmtEV(cameraTimingEV)}`;
  if (!source) return 'Open a photograph to begin.';
  const L = look();
  const parts: string[] = [];
  if (queueIndex >= 0 && queue[queueIndex]?.source === source && queue.length > 1) parts.push(`<b>${queueIndex + 1} / ${queue.length}</b>`);
  parts.push(`<b>${source.label}</b>`);
  if (source.cameraModel) parts.push(source.cameraModel);
  parts.push(`${source.full.width}×${source.full.height}`);
  if (source.iso) parts.push(`ISO ${source.iso.toFixed(0)}`);
  if (source.shutter) parts.push(source.shutter >= 1 ? `${source.shutter.toFixed(1)} s` : `1/${(1 / source.shutter).toFixed(0)} s`);
  if (source.baselineEV) parts.push(`baseline ${fmtEV(source.baselineEV)}`);
  parts.push(`timed ${fmtEV(L.timingEV)}`);
  parts.push(`print ${fmtEV(L.printExposureEV)}`);
  parts.push(`decoded in ${(source.decodeMs / 1000).toFixed(1)} s`);
  if (source.kind === 'display') parts.push('developed as display-referred data');
  if (loupe) parts.push(`1:1 crop at ${loupe.crop.x},${loupe.crop.y}`);
  if (batch) parts.push(`<b>saving the set · ${batch.done} / ${batch.total}</b>`);
  if (showingA && pinned) parts.push(`<b>showing A · ${pinned.parameters.name}</b>`);
  return parts.join(' · ');
}

function updateHint() {
  const bits = ['hold to compare with the plain decode', loupe ? 'drag to move · double-tap to leave 1:1' : 'double-tap for 1:1'];
  if (queue.length > 1) bits.push('← → for the next photograph');
  if (pinned) bits.push('hold A for the pinned look');
  hint.textContent = bits.join(' · ');
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

function renderStill() {
  if (!source) return;
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
  info.innerHTML = describe();
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
  renderStill();
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
      // One decode per entry, shared by whoever asks for it while it runs.
      entry.pending ??= decodeFile(entry.file).finally(() => { delete entry.pending; });
      entry.source = await entry.pending;
    } catch (e) {
      if (serial === openSerial) info.innerHTML = `<b>Could not open ${entry.file.name}.</b> ${(e as Error).message}`;
      return;
    } finally {
      if (serial === openSerial) setBusy(false);
    }
    if (serial !== openSerial) { evictCache(); return; }   // the user has moved on; keep the decode for later
  }
  entry.lastUsed = ++useClock;
  evictCache();
  await showSource(entry.source);
}

/** Opens a set of files as the new queue (sorted by name) and shows the first. A single file is always tried. */
async function openFiles(files: File[]) {
  const list = files.length === 1 ? files : files.filter((f) => isOpenable(f.name));
  if (!list.length) { info.innerHTML = '<b>Nothing to open.</b> Drop DNGs (or any RAW LibRaw reads), JPEGs or PNGs.'; return; }
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
  const crop = planCrop(source.full, source.preview, point, { width: stage.clientWidth - 32, height: stage.clientHeight - 32 }, dpr, maxEdge);
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
    source = null;
    engine.deleteSource(previewTexture); previewTexture = null;
    fitCanvas(camera.width, camera.height);
    badge.hidden = false; badge.textContent = 'camera · not raw'; badge.classList.add('warn');
    hint.hidden = true;
    saveButton.hidden = true;
    captureButton.hidden = false;
    stopCameraButton.hidden = false;
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
      if (frameCounter % 15 === 0) info.innerHTML = describe();
    };
    loop();
  } catch (e) {
    info.innerHTML = `<b>The camera could not be started.</b> ${(e as Error).message}`;
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
    const print = await developPrint(source, L, (done, total) => { if (total > 1) info.innerHTML = `${describe()} · <b>developing ${done} / ${total}</b>`; });
    download(print.blob, printName(source, L));
    info.innerHTML = `${describe()} · <b>saved ${print.width}×${print.height}${print.note}</b>`;
  } catch (e) {
    info.innerHTML = `<b>Could not save.</b> ${(e as Error).message}`;
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
      let src = entry.source;
      if (!src) {
        try { src = await decodeFile(entry.file); } catch (e) { skipped.push(`${entry.file.name}: ${(e as Error).message}`); batch.done++; continue; }
        entry.source = src;
        entry.lastUsed = ++useClock;
        evictCache();
      }
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
      info.innerHTML = describe();
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
    if (skipped.length) summary.push(`skipped ${skipped.length}: ${skipped.join('; ')}`);
    info.innerHTML = `${describe()} · ${summary.join(' · ')}`;
  } catch (e) {
    batch = null;
    info.innerHTML = `<b>Could not save the set.</b> ${(e as Error).message}`;
  } finally {
    batch = null;
    setBusy(false);
  }
}

// MARK: looks A and B

function pinLook() {
  pinned = { parameters: cloneParameters(state.parameters), printExposureEV: state.printExposureEV, timingEV };
  pinButton.textContent = 'Re-pin as A';
  showAButton.hidden = false;
  updateHint();
  info.innerHTML = `${describe()} · <b>pinned the current look as A</b>`;
}

function setShowingA(on: boolean) {
  if (!pinned || showingA === on) return;
  showingA = on;
  scheduleRender();
  if (camera) info.innerHTML = describe();
}

// MARK: wiring

$<HTMLButtonElement>('openButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const files = Array.from(fileInput.files ?? []); fileInput.value = ''; if (files.length) void openFiles(files); });
$<HTMLButtonElement>('cameraButton').addEventListener('click', () => void openCamera());
stopCameraButton.addEventListener('click', () => { stopCamera(); if (!source) { view.hidden = true; drop.hidden = false; badge.hidden = true; } info.innerHTML = describe(); });
captureButton.addEventListener('click', () => void photograph());
saveButton.addEventListener('click', () => void saveJPEG());
saveAllButton.addEventListener('click', () => void saveSet());
prevButton.addEventListener('click', () => void showEntry(queueIndex - 1));
nextButton.addEventListener('click', () => void showEntry(queueIndex + 1));
$<HTMLButtonElement>('labButton').addEventListener('click', () => { lab.hidden = !lab.hidden; });
$<HTMLButtonElement>('labClose').addEventListener('click', () => { lab.hidden = true; });
$<HTMLButtonElement>('resetButton').addEventListener('click', () => {
  const fresh = defaultLabState();
  state.parameters = fresh.parameters; state.printExposureEV = 0;
  buildLab(labBody, state, () => scheduleRender());
  remeasure();
  scheduleRender();
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
    remeasure();
    scheduleRender();
  } catch (e) {
    info.innerHTML = `<b>Could not import ${f.name}.</b> ${(e as Error).message}`;
  }
});
pinButton.addEventListener('click', pinLook);
showAButton.addEventListener('pointerdown', (e) => { e.preventDefault(); setShowingA(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) showAButton.addEventListener(ev, () => setShowingA(false));

// On the image: hold still to compare with the plain decode (after a short delay, so a tap does not flash),
// double-tap (or double-click) for the loupe, drag inside the loupe to move it.
let compareTimer = 0;
let lastTap = { time: 0, x: 0, y: 0 };
let drag: { pointerId: number; x: number; y: number; cropX: number; cropY: number; moved: boolean } | null = null;
const endCompare = () => { window.clearTimeout(compareTimer); if (!comparing) return; comparing = false; scheduleRender(); };
view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const now = performance.now();
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
  compareTimer = window.setTimeout(() => { comparing = true; scheduleRender(); }, 180);
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
  else if (e.key === 'Escape') { if (batch) batch.cancelled = true; else if (loupe) closeLoupe(); else lab.hidden = true; }
  else if ((e.key === 'a' || e.key === 'A') && !e.repeat) setShowingA(true);
});
window.addEventListener('keyup', (e) => { if (e.key === 'a' || e.key === 'A') setShowingA(false); });
window.addEventListener('blur', () => { setShowingA(false); endPointer(); });

// Drag and drop anywhere: files, a selection of files, or a folder.
for (const ev of ['dragenter', 'dragover']) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('active'); });
for (const ev of ['dragleave', 'drop']) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('active'); });
stage.addEventListener('drop', (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  void filesFromDrop(dt).then((files) => { if (files.length) return openFiles(files); });
});

// Timing depends on the parameters, so re-measure when the Laboratory changes them.
labBody.addEventListener('input', remeasure);

info.innerHTML = describe();
