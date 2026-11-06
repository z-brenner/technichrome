// The Technichrome engine on WebGL2: the same graph as TechnichromeEngine.swift (optional halation glow →
// separate → optional dye diffusion and misregistration → cube → key/flare/surround → display), with the dye
// cube baked on the CPU by engine/printModel.ts.

import { CharacteristicCurve } from '../engine/curve';
import { type EngineParameters, matrixCurve } from '../engine/parameters';
import { type DyeLUT, buildLUT } from '../engine/printModel';
import { P3_TO_SRGB, SRGB_TO_P3, mat3 } from '../engine/spectral';
import { BLUR_FRAG, GLOW_FRAG, PLAIN_FRAG, PRINT_FRAG, SEPARATE_FRAG, VERTEX } from './shaders';

export type OutputMode = 'sRGB' | 'displayP3' | 'linearP3';
export type DyeMask = [number, number, number];
export const DYE_ALL: DyeMask = [1, 1, 1];

/** An image on the GPU: float linear sRGB-primaries data, or an sRGB-encoded 8-bit frame (camera, JPEG). */
export interface GLSource {
  texture: WebGLTexture;
  width: number;
  height: number;
  encoded: boolean;
}

/** A rectangle of a source texture in its pixels, from the top left. */
export interface SourceWindow { x: number; y: number; width: number; height: number }

/** The halation glow of a whole image: a small blurred copy of its highlight excess, owned by whoever built it. */
export interface GlowField { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number }

/** How a render samples a glow field: the field, the size of the whole image it describes, and where the source
 *  being rendered sits in that image (its top-left corner, in pixels from the top left). */
export interface GlowSample { field: GlowField; full: { width: number; height: number }; origin: { x: number; y: number } }

export interface RenderOptions {
  exposureScale: number;
  /** Run the spatial stage (dye diffusion). */
  spatial: boolean;
  dyeMask?: DyeMask;
  output: OutputMode;
  /** Render into this framebuffer (null = the canvas). */
  target?: { framebuffer: WebGLFramebuffer; width: number; height: number } | null;
  /** Long edge of the whole image this source is part of, which sets the spatial scale (default: the source's own). */
  longEdge?: number;
  /** The part of the source to print (default: all of it). The target should have the window's size. */
  window?: SourceWindow;
  /** The halation glow (built by `buildGlow` from the whole image's preview); without it no glow is added even
   *  when the parameters ask for one. Ignored when `spatial` is false, as the app ignores bloom there. */
  glow?: GlowSample;
}

/** The dye-diffusion kernel for an image of this long edge: σ in pixels and the radius the blur actually runs
 *  (0 when the blur is skipped). σ is specified for a 4000 px long edge and scales with the size rendered, as in
 *  the app; the radius is what a tile needs as a halo to print exactly like the whole image. */
export function diffusionKernel(p: EngineParameters, longEdge: number, spatial: boolean): { sigmaPx: number; radius: number } {
  const sigmaPx = spatial ? p.diffusionSigmaAt4K * longEdge / 4000 : 0;
  if (!(sigmaPx > 0.15)) return { sigmaPx: 0, radius: 0 };
  return { sigmaPx, radius: Math.min(32, Math.ceil(sigmaPx * 3)) };
}

/** The misregistration shift in pixels for an image of this long edge (0 when skipped: the app skips below 0.05 px). */
export function misregistrationShift(p: EngineParameters, longEdge: number, spatial: boolean): number {
  const shift = spatial ? p.misregistrationAt4K * longEdge / 4000 : 0;
  return shift > 0.05 ? shift : 0;
}

/** What a tile or crop needs around it, on each side, to print exactly like the whole image: the diffusion radius
 *  plus the reach of the misregistration (the shift, its bilinear neighbour, rounded up). */
export function spatialHalo(p: EngineParameters, longEdge: number, spatial: boolean): number {
  const shift = misregistrationShift(p, longEdge, spatial);
  return diffusionKernel(p, longEdge, spatial).radius + (shift > 0 ? Math.ceil(shift) + 1 : 0);
}

/** The halation glow's geometry for a preview of this long edge: σ in preview pixels (as the app: at least 1 px,
 *  else the radius percentage of the long edge), the reduction factor the glow is computed at, and the blur that
 *  then runs on the reduced image. */
export function glowKernel(p: EngineParameters, longEdge: number): { sigmaPx: number; factor: number; sigma: number; radius: number } {
  const sigmaPx = Math.max(1, p.bloomRadiusPercent / 100 * longEdge);
  const factor = Math.min(64, Math.max(1, Math.ceil(sigmaPx / 8)));
  const sigma = sigmaPx / factor;
  return { sigmaPx, factor, sigma, radius: Math.min(32, Math.ceil(sigma * 3)) };
}

interface Program { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }

function cubeKey(p: EngineParameters): string {
  return JSON.stringify([p.cyan, p.magenta, p.yellow, p.dyeDMax, p.dyeGain, p.printDMin, p.projectorCCT]);   // the cube spans gain · D max
}

export class GLEngine {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly maxTextureSize: number;
  readonly supportsP3Canvas: boolean;
  private readonly separate: Program;
  private readonly blur: Program;
  private readonly print: Program;
  private readonly plain: Program;
  private readonly glowProgram: Program;
  /** A 1×1 black field bound where a glow sampler must have a texture but no glow is wanted. */
  private readonly noGlow: GlowField;
  private readonly vao: WebGLVertexArrayObject;
  private cubeTexture: WebGLTexture | null = null;
  private cubeDimension = 0;
  private cubeFor = '';
  private lut: DyeLUT | null = null;
  private ping: { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }[] = [];
  readonly lutDimension: number;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, lutDimension = 33) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser cannot render to floating-point textures (EXT_color_buffer_float), which the engine needs.');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.canvas = canvas;
    this.lutDimension = lutDimension;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    let p3 = false;
    try {
      if ('drawingBufferColorSpace' in gl) {
        (gl as any).drawingBufferColorSpace = 'display-p3';
        p3 = (gl as any).drawingBufferColorSpace === 'display-p3';
      }
    } catch { p3 = false; }
    this.supportsP3Canvas = p3;
    this.separate = this.compile(SEPARATE_FRAG, ['uSource', 'uEncoded', 'uExposureScale', 'uSepR', 'uSepG', 'uSepB', 'uNeg', 'uNegShape', 'uMatA', 'uMat', 'uDyeDMax', 'uDyeLight', 'uDyeMask', 'uGlow', 'uBloomAmount', 'uGlowOrigin', 'uGlowFull']);
    this.blur = this.compile(BLUR_FRAG, ['uImage', 'uAxis', 'uWeights', 'uRadius']);
    this.print = this.compile(PRINT_FRAG, ['uDensities', 'uSource', 'uCube', 'uCubeDim', 'uEncoded', 'uExposureScale', 'uSepG', 'uNeg', 'uNegShape', 'uKey', 'uKeyNu', 'uSurround', 'uFlare', 'uOutput', 'uP3ToSRGB', 'uUVOrigin', 'uUVScale', 'uWindowOrigin', 'uShift', 'uGlow', 'uBloomAmount', 'uGlowOrigin', 'uGlowFull']);
    this.plain = this.compile(PLAIN_FRAG, ['uSource', 'uEncoded', 'uExposureScale', 'uOutput', 'uSRGBToP3', 'uUVOrigin', 'uUVScale']);
    this.glowProgram = this.compile(GLOW_FRAG, ['uSource', 'uEncoded', 'uThreshold', 'uFactor']);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('could not create a vertex array');
    this.vao = vao;
    this.noGlow = this.createHalfTarget(1, 1);   // a fresh texture is zero: black, no glow
  }

  private compile(fragment: string, uniformNames: string[]): Program {
    const gl = this.gl;
    const make = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error('could not create a shader');
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    if (!program) throw new Error('could not create a program');
    gl.attachShader(program, make(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, make(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(program));
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const n of uniformNames) uniforms[n] = gl.getUniformLocation(program, n);
    return { program, uniforms };
  }

  // MARK: sources

  /** Uploads scene-linear RGB float data (3 floats per pixel, sRGB primaries), into `existing`'s texture when given. */
  uploadLinear(rgb: Float32Array, width: number, height: number, existing?: GLSource): GLSource {
    const gl = this.gl;
    const tex = existing?.texture ?? gl.createTexture();
    if (!tex) throw new Error('could not create a texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // row 0 of the data is the top of the image
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, rgb);
    this.texParams(gl.NEAREST);
    return { texture: tex, width, height, encoded: false };
  }

  /** Uploads (or refreshes) an sRGB-encoded 8-bit frame: a video element, canvas or image bitmap. */
  uploadFrame(image: TexImageSource, width: number, height: number, existing?: GLSource): GLSource {
    const gl = this.gl;
    const tex = existing?.texture ?? gl.createTexture();
    if (!tex) throw new Error('could not create a texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.texParams(gl.LINEAR);
    return { texture: tex, width, height, encoded: true };
  }

  deleteSource(s: GLSource | null | undefined) { if (s) this.gl.deleteTexture(s.texture); }

  private texParams(filter: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // MARK: cube

  /** Bakes the dye cube for the print-model inputs (cached by their values, like PrintModelKey in the app). */
  prepare(p: EngineParameters) {
    const key = cubeKey(p);
    if (key === this.cubeFor && this.cubeTexture) return;
    const gl = this.gl;
    const lut = buildLUT(p, this.lutDimension, 'displayP3');
    const tex = this.cubeTexture ?? gl.createTexture();
    if (!tex) throw new Error('could not create the cube texture');
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 3D uploads refuse FLIP_Y, which the 2D uploads set
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, lut.dimension, lut.dimension, lut.dimension, 0, gl.RGBA, gl.FLOAT, lut.data);
    // Read with texelFetch (manual trilinear in the shader); NEAREST keeps the float texture complete everywhere.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.cubeTexture = tex;
    this.cubeDimension = lut.dimension;
    this.cubeFor = key;
    this.lut = lut;
  }

  get currentLUT(): DyeLUT | null { return this.lut; }

  // MARK: targets

  /** A float render target (RGBA32F) of the given size, for readback of linear values. */
  createFloatTarget(width: number, height: number): { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('could not create a render target');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    this.texParams(gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture, width, height };
  }

  /** An 8-bit render target, for JPEG export at full resolution. */
  createByteTarget(width: number, height: number): { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('could not create a render target');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture, width, height };
  }

  deleteTarget(t: { framebuffer: WebGLFramebuffer; texture: WebGLTexture }) {
    this.gl.deleteFramebuffer(t.framebuffer);
    this.gl.deleteTexture(t.texture);
  }

  /** A half-float target that can be sampled bilinearly (RGBA16F filtering is core WebGL2; RGBA32F's is not). */
  private createHalfTarget(width: number, height: number): GlowField {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('could not create a render target');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    this.texParams(gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  // MARK: halation

  /** The halation glow of an image from its preview (`source`, a few thousand pixels across at most): the highlight
   *  excess above the threshold, reduced so that the blur's σ is at most 8 texels, then blurred. The result is in
   *  the image's normalised coordinates, so the preview, a 1:1 crop and an export tile all sample the same field,
   *  with σ following the long edge as the app's does. The field is reused when `existing` has the right size. */
  buildGlow(source: GLSource, p: EngineParameters, existing?: GlowField | null): GlowField {
    const gl = this.gl;
    const { factor, sigma, radius } = glowKernel(p, Math.max(source.width, source.height));
    const w = Math.ceil(source.width / factor), h = Math.ceil(source.height / factor);
    let field = existing ?? null;
    if (field && (field.width !== w || field.height !== h)) { this.deleteGlow(field); field = null; }
    if (!field) field = this.createHalfTarget(w, h);
    const excess = this.scratch(3, w, h);
    this.bindTarget(excess.fb, w, h);
    gl.useProgram(this.glowProgram.program);
    const u = this.glowProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.texture); gl.uniform1i(u.uSource, 0);
    gl.uniform1i(u.uEncoded, source.encoded ? 1 : 0);
    gl.uniform1f(u.uThreshold, p.bloomThreshold);
    gl.uniform1i(u.uFactor, factor);
    this.draw('glow');
    this.gaussianBlur(excess.tex, w, h, sigma, radius, 4, field.framebuffer);
    return field;
  }

  deleteGlow(field: GlowField | null | undefined) { if (field) this.deleteTarget(field); }

  /** A separable Gaussian of `input` (w × h texels) with the given σ and radius (≤ 32), through scratch target
   *  `tmpIndex`, into `out`, a framebuffer of the same size. Edges repeat, like CI's clampedToExtent. */
  private gaussianBlur(input: WebGLTexture, w: number, h: number, sigma: number, radius: number, tmpIndex: number, out: WebGLFramebuffer) {
    const gl = this.gl;
    const weights = new Float32Array(33);
    let sum = 0;
    for (let i = 0; i <= radius; i++) { weights[i] = Math.exp(-0.5 * (i * i) / (sigma * sigma)); sum += i === 0 ? weights[i] : 2 * weights[i]; }
    for (let i = 0; i <= radius; i++) weights[i] /= sum;
    const tmp = this.scratch(tmpIndex, w, h);
    gl.useProgram(this.blur.program);
    const b = this.blur.uniforms;
    gl.uniform1fv(b.uWeights, weights);
    gl.uniform1i(b.uRadius, radius);
    this.bindTarget(tmp.fb, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input); gl.uniform1i(b.uImage, 0);
    gl.uniform2i(b.uAxis, 1, 0);
    this.draw('blur x');
    this.bindTarget(out, w, h);
    gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
    gl.uniform2i(b.uAxis, 0, 1);
    this.draw('blur y');
  }

  /** Frees the scratch targets (after a tiled export, so the GPU memory is not kept at the tile size). */
  releaseScratch() {
    for (const s of this.ping) { if (s) { this.gl.deleteTexture(s.tex); this.gl.deleteFramebuffer(s.fb); } }
    this.ping = [];
  }

  private scratch(index: number, w: number, h: number) {
    const gl = this.gl;
    const existing = this.ping[index];
    if (existing && existing.w === w && existing.h === h) return existing;
    if (existing) { gl.deleteTexture(existing.tex); gl.deleteFramebuffer(existing.fb); }
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!tex || !fb) throw new Error('could not create a scratch target');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    this.texParams(gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const entry = { tex, fb, w, h };
    this.ping[index] = entry;
    return entry;
  }

  // MARK: rendering

  /** When true, every pass checks `getError` and reports to the console (slow; tests only). */
  debug = false;

  private draw(stage = '') {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.debug) {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) console.warn(`GL error ${err} after ${stage}`);
    }
  }

  private bindTarget(fb: WebGLFramebuffer | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
  }

  /** UV origin and scale that map the viewport onto `window` of a source (GL's V runs upward; row 0 is the top). */
  private windowUV(sw: number, sh: number, window: SourceWindow | undefined): [number, number, number, number] {
    if (!window) return [0, 0, 1, 1];
    return [window.x / sw, (sh - window.y - window.height) / sh, window.width / sw, window.height / sh];
  }

  /** The Technichrome print of `source`, into the canvas or `opts.target`. */
  render(source: GLSource, p: EngineParameters, opts: RenderOptions) {
    this.prepare(p);
    const gl = this.gl;
    const target = opts.target ?? null;
    const tw = target ? target.width : this.canvas.width;
    const th = target ? target.height : this.canvas.height;
    const sw = source.width, sh = source.height;

    // Pass 1: densities at the source's resolution.
    const neg = new CharacteristicCurve(p.negative);
    const mats = [0, 1, 2].map((i) => new CharacteristicCurve(matrixCurve(p, i)));   // a depends on each dye's D max
    const key = new CharacteristicCurve(p.key);
    const l10 = Math.log10(2);
    const dens = this.scratch(0, sw, sh);
    this.bindTarget(dens.fb, sw, sh);
    gl.useProgram(this.separate.program);
    const u = this.separate.uniforms;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.texture); gl.uniform1i(u.uSource, 0);
    gl.uniform1i(u.uEncoded, source.encoded ? 1 : 0);
    gl.uniform1f(u.uExposureScale, opts.exposureScale);
    gl.uniform3fv(u.uSepR, mat3.row(p.separationMatrix, 0));
    gl.uniform3fv(u.uSepG, mat3.row(p.separationMatrix, 1));
    gl.uniform3fv(u.uSepB, mat3.row(p.separationMatrix, 2));
    gl.uniform4f(u.uNeg, neg.a, neg.logE0, neg.dMin, neg.span);
    gl.uniform2f(u.uNegShape, neg.xHalf, neg.nu);
    gl.uniform3f(u.uMatA, mats[0].a, mats[1].a, mats[2].a);
    gl.uniform3f(u.uMat, mats[0].logE0, mats[0].xHalf, mats[0].nu);
    gl.uniform3fv(u.uDyeDMax, p.dyeDMax);
    gl.uniform3f(u.uDyeLight, p.dyeLightEV[0] * l10, p.dyeLightEV[1] * l10, p.dyeLightEV[2] * l10);
    gl.uniform3fv(u.uDyeMask, opts.dyeMask ?? DYE_ALL);
    // Halation: the glow field, where this source sits in the whole image (GL texels: y from the bottom), the image's size.
    const glow = opts.spatial && opts.glow && p.bloomAmount > 0 ? opts.glow : null;
    const bloomAmount = glow ? p.bloomAmount : 0;
    const glowOrigin: [number, number] = glow ? [glow.origin.x, glow.full.height - glow.origin.y - sh] : [0, 0];
    const glowFull: [number, number] = glow ? [glow.full.width, glow.full.height] : [sw, sh];
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (glow ?? { field: this.noGlow }).field.texture); gl.uniform1i(u.uGlow, 1);
    gl.uniform1f(u.uBloomAmount, bloomAmount);
    gl.uniform2i(u.uGlowOrigin, glowOrigin[0], glowOrigin[1]);
    gl.uniform2f(u.uGlowFull, glowFull[0], glowFull[1]);
    this.draw('separate');

    // Pass 2 (optional): dye diffusion in the gelatin, a separable Gaussian on the densities. The key stays sharp.
    // σ follows the whole image's long edge (a tile or a crop of a larger image blurs like the whole).
    let densities = dens.tex;
    const longEdge = opts.longEdge ?? Math.max(sw, sh);
    const { sigmaPx, radius } = diffusionKernel(p, longEdge, opts.spatial);
    if (radius > 0) {
      const out = this.scratch(2, sw, sh);
      this.gaussianBlur(dens.tex, sw, sh, sigmaPx, radius, 1, out.fb);
      densities = out.tex;
    }

    // Pass 3: cube, key, flare, surround, display.
    this.bindTarget(target ? target.framebuffer : null, tw, th);
    gl.useProgram(this.print.program);
    const q = this.print.uniforms;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, densities); gl.uniform1i(q.uDensities, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, source.texture); gl.uniform1i(q.uSource, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, this.cubeTexture); gl.uniform1i(q.uCube, 2);
    gl.uniform1f(q.uCubeDim, this.cubeDimension);
    gl.uniform1i(q.uEncoded, source.encoded ? 1 : 0);
    gl.uniform1f(q.uExposureScale, opts.exposureScale);
    gl.uniform3fv(q.uSepG, mat3.row(p.separationMatrix, 1));
    gl.uniform4f(q.uNeg, neg.a, neg.logE0, neg.dMin, neg.span);
    gl.uniform2f(q.uNegShape, neg.xHalf, neg.nu);
    gl.uniform4f(q.uKey, key.a, key.logE0, key.span * p.keyStrength, key.xHalf);
    gl.uniform1f(q.uKeyNu, key.nu);
    gl.uniform1f(q.uSurround, p.surroundExponent);
    gl.uniform1f(q.uFlare, p.screenFlare);
    gl.uniform1i(q.uOutput, opts.output === 'linearP3' ? 2 : opts.output === 'displayP3' ? 1 : 0);
    gl.uniformMatrix3fv(q.uP3ToSRGB, true, P3_TO_SRGB);
    const [ox, oy, sx, sy] = this.windowUV(sw, sh, opts.window);
    gl.uniform2f(q.uUVOrigin, ox, oy);
    gl.uniform2f(q.uUVScale, sx, sy);
    gl.uniform2i(q.uWindowOrigin, opts.window ? opts.window.x : 0, opts.window ? sh - opts.window.y - opts.window.height : 0);
    // Misregistration (the dyes pulled apart in the print pass; the key stays registered) and the glow for the key.
    gl.uniform1f(q.uShift, misregistrationShift(p, longEdge, opts.spatial));
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, (glow ?? { field: this.noGlow }).field.texture); gl.uniform1i(q.uGlow, 3);
    gl.uniform1f(q.uBloomAmount, bloomAmount);
    gl.uniform2i(q.uGlowOrigin, glowOrigin[0], glowOrigin[1]);
    gl.uniform2f(q.uGlowFull, glowFull[0], glowFull[1]);
    this.draw('print');
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The plain scene (exposure only), for the hold-to-compare view. */
  renderPlain(source: GLSource, exposureScale: number, output: OutputMode, target?: { framebuffer: WebGLFramebuffer; width: number; height: number } | null, window?: SourceWindow) {
    const gl = this.gl;
    const tw = target ? target.width : this.canvas.width;
    const th = target ? target.height : this.canvas.height;
    this.bindTarget(target ? target.framebuffer : null, tw, th);
    gl.useProgram(this.plain.program);
    const u = this.plain.uniforms;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.texture); gl.uniform1i(u.uSource, 0);
    gl.uniform1i(u.uEncoded, source.encoded ? 1 : 0);
    gl.uniform1f(u.uExposureScale, exposureScale);
    gl.uniform1i(u.uOutput, output === 'displayP3' ? 1 : 0);
    gl.uniformMatrix3fv(u.uSRGBToP3, true, SRGB_TO_P3);
    const [ox, oy, sx, sy] = this.windowUV(source.width, source.height, window);
    gl.uniform2f(u.uUVOrigin, ox, oy);
    gl.uniform2f(u.uUVScale, sx, sy);
    this.draw('plain');
  }

  /** Reads a float target back (RGBA32F), in GL order (bottom row first) or flipped to rows top to bottom. */
  readFloat(target: { framebuffer: WebGLFramebuffer; width: number; height: number }, topDown = false): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!topDown) return out;
    const w = target.width * 4, h = target.height;
    const flipped = new Float32Array(out.length);
    for (let y = 0; y < h; y++) flipped.set(out.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
    return flipped;
  }

  /** Reads the canvas itself back (RGBA8, GL row order, which a histogram does not mind). */
  readCanvas(): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  /** Reads an 8-bit target back (RGBA8), rows top to bottom. */
  readBytes(target: { framebuffer: WebGLFramebuffer; width: number; height: number }): Uint8ClampedArray<ArrayBuffer> {
    const gl = this.gl;
    const out = new Uint8Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL rows run bottom to top; flip for ImageData.
    const w = target.width * 4, h = target.height;
    const flipped = new Uint8ClampedArray(out.length);
    for (let y = 0; y < h; y++) flipped.set(out.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
    return flipped;
  }
}
