// The Technichrome engine on WebGL2: the same graph as TechnichromeEngine.swift (separate → optional dye
// diffusion → cube → key/flare/surround → display), with the dye cube baked on the CPU by engine/printModel.ts.

import { CharacteristicCurve } from '../engine/curve';
import { type EngineParameters, matrixCurve } from '../engine/parameters';
import { type DyeLUT, buildLUT } from '../engine/printModel';
import { P3_TO_SRGB, SRGB_TO_P3, mat3 } from '../engine/spectral';
import { BLUR_FRAG, PLAIN_FRAG, PRINT_FRAG, SEPARATE_FRAG, VERTEX } from './shaders';

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

export interface RenderOptions {
  exposureScale: number;
  /** Run the spatial stage (dye diffusion). */
  spatial: boolean;
  dyeMask?: DyeMask;
  output: OutputMode;
  /** Render into this framebuffer (null = the canvas). */
  target?: { framebuffer: WebGLFramebuffer; width: number; height: number } | null;
}

interface Program { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }

function cubeKey(p: EngineParameters): string {
  return JSON.stringify([p.cyan, p.magenta, p.yellow, p.dyeDMax, p.printDMin, p.projectorCCT]);
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
    this.separate = this.compile(SEPARATE_FRAG, ['uSource', 'uEncoded', 'uExposureScale', 'uSepR', 'uSepG', 'uSepB', 'uNeg', 'uNegShape', 'uMat', 'uDyeDMax', 'uDyeGain', 'uDyeLight', 'uDyeMask']);
    this.blur = this.compile(BLUR_FRAG, ['uImage', 'uStep', 'uWeights', 'uRadius']);
    this.print = this.compile(PRINT_FRAG, ['uDensities', 'uSource', 'uCube', 'uCubeDim', 'uEncoded', 'uExposureScale', 'uSepG', 'uNeg', 'uNegShape', 'uKey', 'uKeyNu', 'uSurround', 'uFlare', 'uOutput', 'uP3ToSRGB']);
    this.plain = this.compile(PLAIN_FRAG, ['uSource', 'uEncoded', 'uExposureScale', 'uOutput', 'uSRGBToP3']);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('could not create a vertex array');
    this.vao = vao;
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

  /** Uploads scene-linear RGB float data (3 floats per pixel, sRGB primaries). */
  uploadLinear(rgb: Float32Array, width: number, height: number): GLSource {
    const gl = this.gl;
    const tex = gl.createTexture();
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
    const mat = new CharacteristicCurve(matrixCurve(p, 0));
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
    gl.uniform4f(u.uMat, mat.a, mat.logE0, mat.xHalf, mat.nu);
    gl.uniform3fv(u.uDyeDMax, p.dyeDMax);
    gl.uniform3fv(u.uDyeGain, p.dyeGain);
    gl.uniform3f(u.uDyeLight, p.dyeLightEV[0] * l10, p.dyeLightEV[1] * l10, p.dyeLightEV[2] * l10);
    gl.uniform3fv(u.uDyeMask, opts.dyeMask ?? DYE_ALL);
    this.draw('separate');

    // Pass 2 (optional): dye diffusion in the gelatin, a separable Gaussian on the densities. The key stays sharp.
    // σ is specified for a 4000 px long edge and scales with the size actually rendered, as in the app.
    let densities = dens.tex;
    const sigmaPx = opts.spatial ? p.diffusionSigmaAt4K * Math.max(sw, sh) / 4000 : 0;
    if (sigmaPx > 0.15) {
      const radius = Math.min(32, Math.ceil(sigmaPx * 3));
      const weights = new Float32Array(33);
      let sum = 0;
      for (let i = 0; i <= radius; i++) { weights[i] = Math.exp(-0.5 * (i * i) / (sigmaPx * sigmaPx)); sum += i === 0 ? weights[i] : 2 * weights[i]; }
      for (let i = 0; i <= radius; i++) weights[i] /= sum;
      const tmp = this.scratch(1, sw, sh);
      const out = this.scratch(2, sw, sh);
      gl.useProgram(this.blur.program);
      const b = this.blur.uniforms;
      gl.uniform1fv(b.uWeights, weights);
      gl.uniform1i(b.uRadius, radius);
      this.bindTarget(tmp.fb, sw, sh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dens.tex); gl.uniform1i(b.uImage, 0);
      gl.uniform2f(b.uStep, 1 / sw, 0);
      this.draw('blur x');
      this.bindTarget(out.fb, sw, sh);
      gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
      gl.uniform2f(b.uStep, 0, 1 / sh);
      this.draw('blur y');
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
    this.draw('print');
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The plain scene (exposure only), for the hold-to-compare view. */
  renderPlain(source: GLSource, exposureScale: number, output: OutputMode, target?: { framebuffer: WebGLFramebuffer; width: number; height: number } | null) {
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
    this.draw('plain');
  }

  /** Reads a float target back (RGBA32F). */
  readFloat(target: { framebuffer: WebGLFramebuffer; width: number; height: number }): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
