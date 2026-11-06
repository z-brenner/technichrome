// GLSL ES 3.0 kernels mirroring Technichrome/Engine/Kernels/Technichrome.metal pass for pass:
//   glow      highlight excess above a threshold, box-reduced; blurred by `blur` = halation  [tc_bloom_threshold + CIGaussianBlur]
//   separate  scene-linear (+ glow) → normalised dye densities (c, m, y)   [tc_separate]
//   blur      separable Gaussian on the densities = dye diffusion          [CIGaussianBlur]
//   print     densities (misregistered) → dye cube → × key (sharp, from the source + glow) → flare → surround → display
//                                                                          [misregister + cube + tc_key + tc_print]
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
// The halation glow at a pixel of the whole image, given by its integer position (the source's origin in the
// whole image plus the texel): integers in, so a tile or a crop samples the same float as the whole image would.
// The glow field is small (a reduced, blurred copy of the preview) and sampled bilinearly in the image's own
// normalised coordinates.
vec3 glowAt(sampler2D glow, ivec2 position, vec2 fullSize) {
  return max(texture(glow, (vec2(position) + 0.5) / fullSize).rgb, vec3(0.0));
}
// tc_scene_exposure: the scene plus the glow, times the exposure.
vec3 sceneExposure(sampler2D src, vec2 uv, int encoded, float exposureScale, sampler2D glow, float bloomAmount, ivec2 position, vec2 fullSize) {
  vec3 s = texture(src, uv).rgb;
  if (encoded == 1) s = srgbDecode(s);
  vec3 e = max(s, vec3(0.0));
  if (bloomAmount > 0.0) e += bloomAmount * glowAt(glow, position, fullSize);
  return e * exposureScale;
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
uniform vec3 uMatA;       // a of each dye's matrix curve (it depends on that dye's D max)
uniform vec3 uMat;        // logE0, xHalf, nu, shared by the three matrix curves
uniform vec3 uDyeDMax, uDyeGain, uDyeLight, uDyeMask;
uniform sampler2D uGlow;     // halation: the glow field of the whole image (unused when uBloomAmount is 0)
uniform float uBloomAmount;
uniform ivec2 uGlowOrigin;   // where this source sits in the whole image, in GL texels (x from the left, y from the bottom)
uniform vec2 uGlowFull;      // the whole image's size
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 e = sceneExposure(uSource, vUV, uEncoded, uExposureScale, uGlow, uBloomAmount, ivec2(gl_FragCoord.xy) + uGlowOrigin, uGlowFull);
  vec3 s = vec3(dot(uSepR, e), dot(uSepG, e), dot(uSepB, e));
  vec3 logS = log10v(max(s, vec3(1e-6)));
  vec3 dn;
  dn.x = tcCurve(logS.x, uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  dn.y = tcCurve(logS.y, uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  dn.z = tcCurve(logS.z, uNeg.x, uNeg.y, uNeg.z, uNeg.w, uNegShape.x, uNegShape.y);
  vec3 logPrint = -dn + uDyeLight;
  vec3 dye;
  dye.x = tcCurve(logPrint.x, uMatA.x, uMat.x, 0.0, uDyeDMax.x, uMat.y, uMat.z) * uDyeGain.x / uDyeDMax.x;
  dye.y = tcCurve(logPrint.y, uMatA.y, uMat.x, 0.0, uDyeDMax.y, uMat.y, uMat.z) * uDyeGain.y / uDyeDMax.y;
  dye.z = tcCurve(logPrint.z, uMatA.z, uMat.x, 0.0, uDyeDMax.z, uMat.y, uMat.z) * uDyeGain.z / uDyeDMax.z;
  dye = clamp(dye, 0.0, 1.0) * uDyeMask;
  outColor = vec4(dye, 1.0);
}`;

// Halation, first pass: the highlight excess above the threshold (in the source's own linear units, before
// exposure, as tc_bloom_threshold does), averaged over uFactor × uFactor blocks so the blur that follows runs
// on a small image. Edge texels repeat beyond the image, like CI's clampedToExtent.
export const GLOW_FRAG = `#version 300 es
${COMMON}
uniform sampler2D uSource;
uniform int uEncoded;
uniform float uThreshold;
uniform int uFactor;
out vec4 outColor;
void main() {
  ivec2 last = textureSize(uSource, 0) - 1;
  ivec2 base = ivec2(gl_FragCoord.xy) * uFactor;
  vec3 acc = vec3(0.0);
  for (int y = 0; y < 64; y++) {
    if (y >= uFactor) break;
    for (int x = 0; x < 64; x++) {
      if (x >= uFactor) break;
      vec3 s = texelFetch(uSource, min(base + ivec2(x, y), last), 0).rgb;
      if (uEncoded == 1) s = srgbDecode(s);
      acc += max(s - vec3(uThreshold), vec3(0.0));
    }
  }
  outColor = vec4(acc / float(uFactor * uFactor), 1.0);
}`;

// Densities are fetched by integer texel (texelFetch), never filtered: the sums are then the same floats in
// the same order whatever the texture's size, so a tile with its halo blurs bitwise like the whole image.
export const BLUR_FRAG = `#version 300 es
${COMMON}
uniform sampler2D uImage;
uniform ivec2 uAxis;           // (1, 0) or (0, 1): the blur axis
uniform float uWeights[33];    // symmetric Gaussian, centre first
uniform int uRadius;
out vec4 outColor;
void main() {
  ivec2 last = textureSize(uImage, 0) - 1;
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec3 acc = texelFetch(uImage, c, 0).rgb * uWeights[0];
  for (int i = 1; i <= 32; i++) {
    if (i > uRadius) break;
    ivec2 o = uAxis * i;
    acc += (texelFetch(uImage, clamp(c + o, ivec2(0), last), 0).rgb + texelFetch(uImage, clamp(c - o, ivec2(0), last), 0).rgb) * uWeights[i];
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
uniform vec2 uUVOrigin;     // the part of the source this viewport prints (a tile or crop of a larger image)
uniform vec2 uUVScale;
uniform ivec2 uWindowOrigin; // the same window in density texels
uniform float uShift;        // misregistration in texels (0 = none): the dyes pulled apart at 120°, the key stays put
uniform sampler2D uGlow;     // halation (see SEPARATE_FRAG)
uniform float uBloomAmount;
uniform ivec2 uGlowOrigin;
uniform vec2 uGlowFull;
in vec2 vUV;
out vec4 outColor;
// Bilinear read of the densities at texel + offset, from four integer fetches (edge clamped): the
// integer part of the offset moves the texel, the fractional part weights the neighbours, and neither depends on
// where the texel is, so a tile with its halo reads the same floats as the whole image. The same sampling CI
// applies to a translated image.
vec3 densityAt(ivec2 texel, vec2 offset) {
  ivec2 last = textureSize(uDensities, 0) - 1;
  vec2 whole = floor(offset);
  ivec2 i0 = texel + ivec2(whole);
  vec2 f = offset - whole;
  vec3 a = texelFetch(uDensities, clamp(i0, ivec2(0), last), 0).rgb;
  vec3 b = texelFetch(uDensities, clamp(i0 + ivec2(1, 0), ivec2(0), last), 0).rgb;
  vec3 c = texelFetch(uDensities, clamp(i0 + ivec2(0, 1), ivec2(0), last), 0).rgb;
  vec3 d = texelFetch(uDensities, clamp(i0 + ivec2(1, 1), ivec2(0), last), 0).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec2 uv = uUVOrigin + vUV * uUVScale;
  ivec2 texel = ivec2(gl_FragCoord.xy) + uWindowOrigin;
  vec3 dye;
  if (uShift > 0.0) {
    // The app's misregister(): cyan moved by (+s, 0), magenta by (−s/2, +0.866 s), yellow by (−s/2, −0.866 s);
    // a moved image shows, at a pixel, what lay the shift away in the other direction.
    dye.r = densityAt(texel, -vec2(uShift, 0.0)).r;
    dye.g = densityAt(texel, -vec2(-0.5 * uShift, 0.866 * uShift)).g;
    dye.b = densityAt(texel, -vec2(-0.5 * uShift, -0.866 * uShift)).b;
    dye = clamp(dye, 0.0, 1.0);
  } else {
    dye = clamp(texelFetch(uDensities, texel, 0).rgb, 0.0, 1.0);
  }
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
  // Silver key image from the green record of the unblurred source (with the glow, as tc_key takes it).
  vec3 e = sceneExposure(uSource, uv, uEncoded, uExposureScale, uGlow, uBloomAmount, texel + uGlowOrigin, uGlowFull);
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
uniform vec2 uUVOrigin;
uniform vec2 uUVScale;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3 e = sceneLinear(uSource, uUVOrigin + vUV * uUVScale, uEncoded, uExposureScale);
  if (uOutput == 1) e = uSRGBToP3 * e;
  outColor = vec4(srgbEncode(e), 1.0);
}`;
