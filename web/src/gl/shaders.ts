// GLSL ES 3.0 kernels mirroring Technichrome/Engine/Kernels/Technichrome.metal pass for pass:
//   separate  scene-linear → normalised dye densities (c, m, y)           [tc_separate]
//   blur      separable Gaussian on the densities = dye diffusion          [CIGaussianBlur]
//   print     densities → dye cube → × key (sharp, from the source) → flare → surround → display  [tc_key + cube + tc_print]
//   plain     scene-linear × exposure → display (the hold-to-compare view) [tc_linear_view]
// The CPU reference (engine/reference.ts) is the specification; test/gl-parity.cjs checks these against it.

export const VERTEX = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  // One triangle covering the clip space; UV 0..1 over the viewport.
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUV = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const COMMON = `
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

float tcCurve(float logE, float a, float logE0, float dMin, float span, float xHalf, float nu) {
  float x = a * (logE - logE0) + xHalf;
  float g = pow(1.0 + nu * exp(-x), -1.0 / nu);
  return dMin + span * g;
}
vec3 log10v(vec3 v) { return log(v) * 0.43429448190325182; }
float log10f(float v) { return log(v) * 0.43429448190325182; }
vec3 srgbDecode(vec3 v) {
  vec3 lo = v / 12.92;
  vec3 hi = pow((v + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), v));
}
vec3 srgbEncode(vec3 v) {
  v = clamp(v, 0.0, 1.0);
  vec3 lo = v * 12.92;
  vec3 hi = 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), v));
}
// Scene exposure from the source texture: float linear data, or an sRGB-encoded 8-bit frame (camera / JPEG).
vec3 sceneLinear(sampler2D src, vec2 uv, int encoded, float exposureScale) {
  vec3 s = texture(src, uv).rgb;
  if (encoded == 1) s = srgbDecode(s);
  return max(s, vec3(0.0)) * exposureScale;
}
// Out-of-gamut handling for the sRGB display path: chroma scaled toward luminance, soft knee above 0.95
// (the same operation the LUT builder applies to P3).
vec3 softClipGamut(vec3 rgb) {
  float Y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  vec3 c = rgb;
  if (mn < 0.0) {
    float t = Y / max(Y - mn, 1e-9);
    c = vec3(Y) + (rgb - vec3(Y)) * t;
  }
  float k = 0.95;
  vec3 over = step(vec3(k), c);
  vec3 knee = k + (1.0 - k) * tanh((c - k) / (1.0 - k));
  c = mix(c, knee, over);
  return clamp(c, 0.0, 1.0);
}
`;

export const SEPARATE_FRAG = `#version 300 es
${COMMON}
uniform sampler2D uSource;
uniform int uEncoded;
uniform float uExposureScale;
uniform vec3 uSepR, uSepG, uSepB;
uniform vec4 uNeg;        // a, logE0, dMin, span
uniform vec2 uNegShape;   // xHalf, nu
uniform vec4 uMat;        // a, logE0, xHalf, nu
uniform vec3 uDyeDMax, uDyeGain, uDyeLight, uDyeMask;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 e = sceneLinear(uSource, vUV, uEncoded, uExposureScale);
  vec3 s = vec3(dot(uSepR, e), dot(uSepG, e), dot(uSepB, e));
  vec3 logS = log10v(max(s, vec3(1e-6)));
  vec3 dn;
  dn.x = tcCurve(logS.x, uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  dn.y = tcCurve(logS.y, uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  dn.z = tcCurve(logS.z, uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  vec3 logPrint = -dn + uDyeLight;
  vec3 dye;
  dye.x = tcCurve(logPrint.x, uMat.x, uMat.y, 0.0, uDyeDMax.x, uMat.z, uMat.w) * uDyeGain.x / uDyeDMax.x;
  dye.y = tcCurve(logPrint.y, uMat.x, uMat.y, 0.0, uDyeDMax.y, uMat.z, uMat.w) * uDyeGain.y / uDyeDMax.y;
  dye.z = tcCurve(logPrint.z, uMat.x, uMat.y, 0.0, uDyeDMax.z, uMat.z, uMat.w) * uDyeGain.z / uDyeDMax.z;
  dye = clamp(dye, 0.0, 1.0) * uDyeMask;
  outColor = vec4(dye, 1.0);
}`;

export const BLUR_FRAG = `#version 300 es
${COMMON}
uniform sampler2D uImage;
uniform vec2 uStep;            // one texel along the blur axis
uniform float uWeights[33];    // symmetric Gaussian, centre first
uniform int uRadius;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 acc = texture(uImage, vUV).rgb * uWeights[0];
  for (int i = 1; i <= 32; i++) {
    if (i > uRadius) break;
    vec2 o = uStep * float(i);
    acc += (texture(uImage, vUV + o).rgb + texture(uImage, vUV - o).rgb) * uWeights[i];
  }
  outColor = vec4(acc, 1.0);
}`;

export const PRINT_FRAG = `#version 300 es
${COMMON}
uniform sampler2D uDensities;
uniform sampler2D uSource;
uniform sampler3D uCube;
uniform float uCubeDim;
uniform int uEncoded;
uniform float uExposureScale;
uniform vec3 uSepG;
uniform vec4 uNeg;
uniform vec2 uNegShape;
uniform vec4 uKey;          // a, logE0, span·strength, xHalf
uniform float uKeyNu;
uniform float uSurround;
uniform float uFlare;
uniform int uOutput;        // 0 = sRGB display (encoded), 1 = Display P3 canvas (encoded), 2 = linear P3 floats
uniform mat3 uP3ToSRGB;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 dye = clamp(texture(uDensities, vUV).rgb, 0.0, 1.0);
  // The same trilinear interpolation as the CIColorCube and the CPU reference, done by hand with texelFetch so
  // the float cube needs no filtering extension (sampling a float texture with LINEAR is not core WebGL2).
  float n = uCubeDim - 1.0;
  vec3 pos = dye * n;
  ivec3 i0 = min(ivec3(floor(pos)), ivec3(int(uCubeDim) - 2));
  vec3 f = pos - vec3(i0);
  vec3 c = vec3(0.0);
  for (int dz = 0; dz <= 1; dz++) {
    for (int dy = 0; dy <= 1; dy++) {
      for (int dx = 0; dx <= 1; dx++) {
        float w = (dx == 1 ? f.x : 1.0 - f.x) * (dy == 1 ? f.y : 1.0 - f.y) * (dz == 1 ? f.z : 1.0 - f.z);
        c += texelFetch(uCube, i0 + ivec3(dx, dy, dz), 0).rgb * w;
      }
    }
  }
  c = clamp(c, 0.0, 1.0);
  // Silver key image from the green record of the unblurred source.
  vec3 e = sceneLinear(uSource, vUV, uEncoded, uExposureScale);
  float g = dot(uSepG, e);
  float dn = tcCurve(log10f(max(g, 1e-6)), uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  float k = tcCurve(-dn, uKey.x, uKey.y, 0.0, uKey.z, uKey.w, uKeyNu);
  c *= pow(10.0, -k);
  c = (c + uFlare) / (1.0 + uFlare);
  c = pow(max(c, vec3(0.0)), vec3(uSurround));
  if (uOutput == 2) { outColor = vec4(c, 1.0); return; }
  if (uOutput == 1) { outColor = vec4(srgbEncode(c), 1.0); return; }
  outColor = vec4(srgbEncode(softClipGamut(uP3ToSRGB * c)), 1.0);
}`;

export const PLAIN_FRAG = `#version 300 es
${COMMON}
uniform sampler2D uSource;
uniform int uEncoded;
uniform float uExposureScale;
uniform int uOutput;        // 0 = sRGB display, 1 = P3 canvas (source is sRGB-primaries linear, so convert)
uniform mat3 uSRGBToP3;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 e = sceneLinear(uSource, vUV, uEncoded, uExposureScale);
  if (uOutput == 1) e = uSRGBToP3 * e;
  outColor = vec4(srgbEncode(e), 1.0);
}`;
