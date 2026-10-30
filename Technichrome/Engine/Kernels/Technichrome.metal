//
//  Technichrome.metal
//  Technichrome
//
//  Core Image kernels of the Technichrome rendering engine ("imbibition model").
//  Compiled with -fcikernel / linked with -cikernel (see project build settings).
//
//  The per-pixel maths here mirrors Technichrome/Engine/Core/ReferencePipeline.swift line for
//  line; the Swift version is the specification and is unit-tested against the Python prototype.
//
//  Pipeline:
//    tc_bloom_threshold  (optional)  scene-linear → highlight excess, blurred by CIGaussianBlur
//    tc_separate                     scene-linear → normalised dye densities (c, m, y) in RGB
//    tc_key                          scene-linear → silver key transmittance (greyscale)
//    [CIGaussianBlur on densities = dye diffusion in the gelatin; misregistration offsets]
//    [CIColorCube: densities → display-linear P3 (the spectral print model, baked by LUTBuilder)]
//    tc_print                        P3 × key → viewing compensation → working space (linear sRGB)
//

#include <metal_stdlib>
#include <CoreImage/CoreImage.h>
using namespace metal;

/// Generalised H&D curve (Richards): density versus log10 exposure (see CharacteristicCurve.swift).
///   a, logE0, xHalf, nu are precomputed on the CPU by CharacteristicCurve.
static inline float tc_curve(float logE, float a, float logE0, float dMin, float span, float xHalf, float nu)
{
    float x = a * (logE - logE0) + xHalf;
    float g = pow(1.0f + nu * exp(-x), -1.0f / nu);
    return dMin + span * g;
}

static inline float3 tc_scene_exposure(float3 src, float3 glow, float bloomAmount, float exposureScale)
{
    float3 e = max(src, 0.0f) + bloomAmount * max(glow, 0.0f);
    return e * exposureScale;
}

extern "C" {
namespace coreimage {

    /// Highlight excess above `threshold` (scene-linear), to be blurred into a glow.
    float4 tc_bloom_threshold(sample_t src, float threshold)
    {
        float3 e = max(src.rgb - threshold, 0.0f);
        return float4(e, 1.0f);
    }

    /// Scene-linear RGB (+ glow) → normalised dye densities. RGB = (cyan, magenta, yellow) in [0,1].
    ///   sepR/sepG/sepB : rows of the separation matrix (red, green, blue record)
    ///   neg            : (a, logE0, dMin, span) of the negative curve;  negShape: (xHalf, nu)
    ///   mat            : (a, logE0, xHalf, nu) of the matrix curve;  dyeDMax, dyeGain per dye
    ///   dyeMask        : 1 = dye transferred, 0 = matrix withheld (used by the develop reveal)
    float4 tc_separate(sample_t src, sample_t glow, float bloomAmount, float exposureScale,
                       float3 sepR, float3 sepG, float3 sepB,
                       float4 neg, float2 negShape,
                       float4 mat, float3 dyeDMax, float3 dyeGain, float3 dyeMask)
    {
        float3 e = tc_scene_exposure(src.rgb, glow.rgb, bloomAmount, exposureScale);
        float3 s = float3(dot(sepR, e), dot(sepG, e), dot(sepB, e));
        float3 logS = log10(max(s, float3(1e-6f)));
        float3 dn;
        dn.x = tc_curve(logS.x, neg.x, neg.y, neg.z, neg.w, negShape.x, negShape.y);
        dn.y = tc_curve(logS.y, neg.x, neg.y, neg.z, neg.w, negShape.x, negShape.y);
        dn.z = tc_curve(logS.z, neg.x, neg.y, neg.z, neg.w, negShape.x, negShape.y);
        float3 logPrint = -dn;
        float3 dye;
        dye.x = tc_curve(logPrint.x, mat.x, mat.y, 0.0f, dyeDMax.x, mat.z, mat.w) * dyeGain.x / dyeDMax.x;
        dye.y = tc_curve(logPrint.y, mat.x, mat.y, 0.0f, dyeDMax.y, mat.z, mat.w) * dyeGain.y / dyeDMax.y;
        dye.z = tc_curve(logPrint.z, mat.x, mat.y, 0.0f, dyeDMax.z, mat.z, mat.w) * dyeGain.z / dyeDMax.z;
        dye = saturate(dye) * dyeMask;
        return float4(dye, 1.0f);
    }

    /// Scene-linear RGB (+ glow) → transmittance of the silver key image (printed from the green record).
    ///   key : (a, logE0, dMax·strength, xHalf); keyNu: ν of the key curve.
    float4 tc_key(sample_t src, sample_t glow, float bloomAmount, float exposureScale,
                  float3 sepG, float4 neg, float2 negShape, float4 key, float keyNu)
    {
        float3 e = tc_scene_exposure(src.rgb, glow.rgb, bloomAmount, exposureScale);
        float g = dot(sepG, e);
        float dn = tc_curve(log10(max(g, 1e-6f)), neg.x, neg.y, neg.z, neg.w, negShape.x, negShape.y);
        float k = tc_curve(-dn, key.x, key.y, 0.0f, key.z, key.w, keyNu);
        float t = pow(10.0f, -k);
        return float4(t, t, t, 1.0f);
    }

    /// Final print: display-linear P3 from the dye cube × key transmittance, viewing-condition
    /// compensation, then conversion into the Core Image working space (linear sRGB, extended range).
    ///   m0/m1/m2 : rows of the P3 → working-space matrix
    float4 tc_print(sample_t printed, sample_t keyT, float surroundExponent, float3 m0, float3 m1, float3 m2)
    {
        float3 c = saturate(printed.rgb) * keyT.r;
        c = pow(max(c, float3(0.0f)), float3(surroundExponent));
        float3 w = float3(dot(m0, c), dot(m1, c), dot(m2, c));
        return float4(w, 1.0f);
    }

    /// Debug/compare view: scene-linear → working space with a plain exposure (no look).
    float4 tc_linear_view(sample_t src, float exposureScale)
    {
        return float4(max(src.rgb, 0.0f) * exposureScale, 1.0f);
    }
}
}
