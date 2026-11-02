// Technichrome in the browser. One screen: open a photograph or use the camera, see the print, hold to compare,
// adjust in the Laboratory, save a JPEG. Everything happens in this tab.

import { type EngineParameters, parametersFromJSON } from './engine/parameters';
import { geometricMeanLuminance, timingExposureEV } from './engine/timing';
import { GLEngine, type GLSource } from './gl/engine';
import { type DecodedSource, decodeFile, downsample, linearFromBitmap } from './raw/decoder';
import { startCamera, type CameraSession } from './ui/camera';
import { buildLab, defaultLabState, type LabState } from './ui/lab';
import { installParityHook } from './parity';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = $<HTMLCanvasElement>('view');
const drop = $<HTMLDivElement>('drop');
const badge = $<HTMLDivElement>('badge');
const hint = $<HTMLDivElement>('hint');
const busy = $<HTMLDivElement>('busy');
const info = $<HTMLDivElement>('info');
const video = $<HTMLVideoElement>('video');
const lab = $<HTMLElement>('lab');
const labBody = $<HTMLDivElement>('labBody');
const captureButton = $<HTMLButtonElement>('captureButton');
const saveButton = $<HTMLButtonElement>('saveButton');
const stopCameraButton = $<HTMLButtonElement>('stopCameraButton');
const fileInput = $<HTMLInputElement>('fileInput');
const importInput = $<HTMLInputElement>('importInput');

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

buildLab(labBody, state, () => scheduleRender());
installParityHook(engine);

// MARK: helpers

function setBusy(on: boolean) { busy.hidden = !on; }

function exposureScaleFor(p: EngineParameters, baselineEV: number, extraEV: number): number {
  return Math.pow(2, p.exposureEV + baselineEV + extraEV);
}

function describe(): string {
  if (camera && !source) return `<b>Camera</b> · ${camera.width}×${camera.height} · not RAW: the browser's own processed stream, linearised from sRGB · timed ${fmtEV(cameraTimingEV)}`;
  if (!source) return 'Open a photograph to begin.';
  const parts = [`<b>${source.label}</b>`];
  if (source.cameraModel) parts.push(source.cameraModel);
  parts.push(`${source.full.width}×${source.full.height}`);
  if (source.iso) parts.push(`ISO ${source.iso.toFixed(0)}`);
  if (source.shutter) parts.push(source.shutter >= 1 ? `${source.shutter.toFixed(1)} s` : `1/${(1 / source.shutter).toFixed(0)} s`);
  if (source.baselineEV) parts.push(`baseline ${fmtEV(source.baselineEV)}`);
  parts.push(`timed ${fmtEV(timingEV)}`);
  parts.push(`print ${fmtEV(state.printExposureEV)}`);
  parts.push(`decoded in ${(source.decodeMs / 1000).toFixed(1)} s`);
  if (source.kind === 'display') parts.push('developed as display-referred data');
  return parts.join(' · ');
}

function fmtEV(v: number): string { return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`; }

function fitCanvas(width: number, height: number) {
  view.width = width;
  view.height = height;
  view.hidden = false;
  drop.hidden = true;
}

// MARK: rendering

function renderStill() {
  if (!source || !previewTexture) return;
  const p = state.parameters;
  const scale = exposureScaleFor(p, source.baselineEV, state.printExposureEV + timingEV);
  if (comparing) engine.renderPlain(previewTexture, scale, output);
  else engine.render(previewTexture, p, { exposureScale: scale, spatial: true, output });
  info.innerHTML = describe();
}

let renderQueued = false;
function scheduleRender() {
  if (camera) return;   // the camera loop renders every frame
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderStill(); });
}

function measureTiming(src: DecodedSource): number {
  const p = state.parameters;
  const gm = geometricMeanLuminance(src.preview.rgb, src.preview.width, src.preview.height, exposureScaleFor(p, src.baselineEV, 0), 2);
  return timingExposureEV(gm, p.timingTarget, p.timingStrength, p.timingLimit, 0);
}

async function showSource(s: DecodedSource) {
  stopCamera();
  engine.deleteSource(previewTexture);
  source = s;
  timingEV = measureTiming(s);
  previewTexture = engine.uploadLinear(s.preview.rgb, s.preview.width, s.preview.height);
  fitCanvas(s.preview.width, s.preview.height);
  badge.hidden = false;
  badge.textContent = s.kind === 'display' ? 'not raw · display-referred' : s.label;
  badge.classList.toggle('warn', s.kind === 'display');
  hint.hidden = false;
  saveButton.hidden = false;
  captureButton.hidden = true;
  stopCameraButton.hidden = true;
  renderStill();
}

async function openFile(file: File) {
  setBusy(true);
  try {
    const decoded = await decodeFile(file);
    await showSource(decoded);
  } catch (e) {
    info.innerHTML = `<b>Could not open ${file.name}.</b> ${(e as Error).message}`;
  } finally {
    setBusy(false);
  }
}

// MARK: camera

async function openCamera() {
  try {
    setBusy(true);
    camera = await startCamera(video);
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
      const p = state.parameters;
      if (p.timingStrength > 0 && frameCounter % 12 === 1) {
        // Print timing from a small linearised copy of the frame, smoothed like the app's preview.
        const small = linearFromBitmap(video, 'frame');
        const gm = geometricMeanLuminance(small.preview.rgb, small.preview.width, small.preview.height, exposureScaleFor(p, 0, 0), 4);
        const measured = timingExposureEV(gm, p.timingTarget, p.timingStrength, p.timingLimit, 0);
        cameraTimingEV += 0.35 * (measured - cameraTimingEV);
      } else if (p.timingStrength <= 0) {
        cameraTimingEV = 0;
      }
      const scale = exposureScaleFor(p, 0, state.printExposureEV + cameraTimingEV);
      if (comparing) engine.renderPlain(cameraTexture, scale, output);
      else engine.render(cameraTexture, p, { exposureScale: scale, spatial: false, output });
      if (frameCounter % 15 === 0) info.innerHTML = describe();
    };
    loop();
  } catch (e) {
    info.innerHTML = `<b>The camera could not be started.</b> ${(e as Error).message}`;
  } finally {
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

async function saveJPEG() {
  if (!source) return;
  setBusy(true);
  try {
    const p = state.parameters;
    const full = source.full;
    const maxEdge = engine.maxTextureSize;
    let img = full;
    let note = '';
    if (Math.max(full.width, full.height) > maxEdge) {
      img = downsample(full, maxEdge);
      note = ` (reduced to ${img.width}×${img.height}: this GPU's texture limit)`;
    }
    const tex = engine.uploadLinear(img.rgb, img.width, img.height);
    const target = engine.createByteTarget(img.width, img.height);
    const scale = exposureScaleFor(p, source.baselineEV, state.printExposureEV + timingEV);
    engine.render(tex, p, { exposureScale: scale, spatial: true, output, target });
    const pixels = engine.readBytes(target);
    engine.deleteTarget(target);
    engine.deleteSource(tex);
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d', output === 'displayP3' ? ({ colorSpace: 'display-p3' } as CanvasRenderingContext2DSettings) : undefined);
    if (!ctx) throw new Error('could not create a canvas for the JPEG');
    const imageData = output === 'displayP3' ? new ImageData(pixels, img.width, img.height, { colorSpace: 'display-p3' } as ImageDataSettings) : new ImageData(pixels, img.width, img.height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new Error('JPEG encoding failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Technichrome-${source.fileName.replace(/\.[^.]+$/, '')}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    info.innerHTML = `${describe()} · <b>saved ${img.width}×${img.height}${note}</b>`;
  } catch (e) {
    info.innerHTML = `<b>Could not save.</b> ${(e as Error).message}`;
  } finally {
    setBusy(false);
  }
}

// MARK: wiring

$<HTMLButtonElement>('openButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) void openFile(f); fileInput.value = ''; });
$<HTMLButtonElement>('cameraButton').addEventListener('click', () => void openCamera());
stopCameraButton.addEventListener('click', () => { stopCamera(); if (!source) { view.hidden = true; drop.hidden = false; badge.hidden = true; } info.innerHTML = describe(); });
captureButton.addEventListener('click', () => void photograph());
saveButton.addEventListener('click', () => void saveJPEG());
$<HTMLButtonElement>('labButton').addEventListener('click', () => { lab.hidden = !lab.hidden; });
$<HTMLButtonElement>('labClose').addEventListener('click', () => { lab.hidden = true; });
$<HTMLButtonElement>('resetButton').addEventListener('click', () => {
  const fresh = defaultLabState();
  state.parameters = fresh.parameters; state.printExposureEV = 0;
  buildLab(labBody, state, () => scheduleRender());
  if (source) timingEV = measureTiming(source);
  scheduleRender();
});
$<HTMLButtonElement>('exportButton').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.parameters, null, 2)], { type: 'application/json' });
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
    state.parameters = parametersFromJSON(JSON.parse(await f.text()));
    buildLab(labBody, state, () => scheduleRender());
    if (source) timingEV = measureTiming(source);
    scheduleRender();
  } catch (e) {
    info.innerHTML = `<b>Could not import ${f.name}.</b> ${(e as Error).message}`;
  }
});

// Hold to compare with the plain decode.
const startCompare = (e: Event) => { e.preventDefault(); comparing = true; scheduleRender(); };
const endCompare = () => { if (!comparing) return; comparing = false; scheduleRender(); };
view.addEventListener('pointerdown', startCompare);
view.addEventListener('pointerup', endCompare);
view.addEventListener('pointercancel', endCompare);
view.addEventListener('pointerleave', endCompare);
view.addEventListener('contextmenu', (e) => e.preventDefault());

// Drag and drop anywhere.
const stage = $<HTMLElement>('stage');
for (const ev of ['dragenter', 'dragover']) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('active'); });
for (const ev of ['dragleave', 'drop']) stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('active'); });
stage.addEventListener('drop', (e) => { const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void openFile(f); });

// Timing depends on the parameters, so re-measure when the Laboratory changes them.
labBody.addEventListener('input', () => { if (source) timingEV = measureTiming(source); });

info.innerHTML = describe();
