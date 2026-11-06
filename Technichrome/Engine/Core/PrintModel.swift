//
//  PrintModel.swift
//  Technichrome
//
//  The "virtual dye-transfer print": three dyes with spectral absorbances, a neutral base density,
//  a projector lamp, the CIE observer, and chromatic adaptation of the screen white to the display.
//  The print is Display P3; an sRGB print is that P3 print, finished, converted (`sRGBPrint`).
//
//  The model is baked into the dye cube on the CPU (LUTBuilder, factorised per dye) — never evaluated per
//  pixel. `xyz(dyeDensities:)` is the direct evaluation the bake is tested against.
//

import Foundation

/// Everything the print model (and therefore the baked dye cube) depends on. Keep this in step with
/// `PrintModel.init` and `LUTBuilder.build`: a parameter read there but missing here would serve a stale cube.
public struct PrintModelKey: Equatable, Sendable {
    public let cyan: DyeSpectrum
    public let magenta: DyeSpectrum
    public let yellow: DyeSpectrum
    public let dyeDMax: [Double]
    /// The cube's axes span gain · D max of each dye, so the gains select the cube too.
    public let dyeGain: [Double]
    public let printDMin: Double
    public let projectorCCT: Double

    public init(_ p: EngineParameters) {
        cyan = p.cyan; magenta = p.magenta; yellow = p.yellow
        dyeDMax = p.dyeDMax; dyeGain = p.dyeGain; printDMin = p.printDMin; projectorCCT = p.projectorCCT
    }
}

public struct PrintModel: Sendable {
    public let absorbances: [[Double]]      // [dye][wavelength], peak-normalised
    public let projector: [Double]          // lamp SPD on the grid, peak-normalised
    public let printDMin: Double
    public let whiteScale: Double           // 1 / Y of the projector seen through the clear base
    public let xyzToDisplay: Matrix3        // XYZ (print white) → display-linear Display P3 (D65), adaptation included

    /// The space a finished print is delivered in. The print model and its cube are always Display P3; `.sRGB` is the
    /// P3 print after the key, flare and viewing exponent, converted by `sRGBPrint` (ReferencePipeline.develop), the
    /// one definition the web's sRGB canvas and the documentation figures use too.
    public enum DisplaySpace: String, Codable, Sendable { case displayP3, sRGB }

    public init(parameters p: EngineParameters) {
        absorbances = [p.cyan.absorbance(), p.magenta.absorbance(), p.yellow.absorbance()]
        projector = Spectral.planck(p.projectorCCT)
        printDMin = p.printDMin
        let baseT = pow(10.0, -p.printDMin)
        let whiteXYZ = Spectral.xyz(of: projector.map { $0 * baseT })
        whiteScale = 1.0 / whiteXYZ.y
        let srcWhite = whiteXYZ * whiteScale
        let cat = ColorSpaces.bradfordAdaptation(from: srcWhite, to: ColorSpaces.xyToXYZ(ColorSpaces.d65))
        xyzToDisplay = ColorSpaces.xyzToP3 * cat
    }

    /// XYZ of the print, relative to the print white (Y_white = 1), for absolute dye densities.
    public func xyz(dyeDensities d: SIMD3<Double>) -> SIMD3<Double> {
        var acc = SIMD3<Double>(repeating: 0)
        let n = Spectral.sampleCount
        for i in 0..<n {
            let density = d.x * absorbances[0][i] + d.y * absorbances[1][i] + d.z * absorbances[2][i] + printDMin
            let t = pow(10.0, -density) * projector[i]
            acc += Spectral.cmfTable[i] * t
        }
        return acc * whiteScale
    }

    /// Display-linear Display P3 (unclipped) for absolute dye densities.
    public func displayLinear(dyeDensities d: SIMD3<Double>) -> SIMD3<Double> {
        xyzToDisplay * xyz(dyeDensities: d)
    }

    /// Luminance weights of the soft clip: the Y rows of Display P3 → XYZ and of sRGB (Rec. 709) → XYZ, rounded as
    /// tcengine.P3_LUMA / REC709_LUMA and the shaders write them.
    public static let p3Luma = SIMD3(0.2290, 0.6917, 0.0793)
    public static let rec709Luma = SIMD3(0.2126, 0.7152, 0.0722)

    /// Bring out-of-gamut colours inside [0,1]: negative components are lifted by scaling chroma toward
    /// the pixel's luminance; values above 0.95 are compressed with a soft knee. Mirrors tcengine.soft_clip_gamut.
    /// `luma`: the luminance weights of the space `rgb` is in (P3 for the cube, Rec. 709 for the sRGB print).
    public static func softClipGamut(_ rgb: SIMD3<Double>, luma: SIMD3<Double> = p3Luma) -> SIMD3<Double> {
        let Y = luma.x * rgb.x + luma.y * rgb.y + luma.z * rgb.z
        let mn = min(rgb.x, min(rgb.y, rgb.z))
        var c = rgb
        if mn < 0 {
            let t = Y / max(Y - mn, 1e-9)
            c = SIMD3(repeating: Y) + (rgb - SIMD3(repeating: Y)) * t
        }
        let k = 0.95
        func knee(_ v: Double) -> Double { v > k ? k + (1 - k) * tanh((v - k) / (1 - k)) : v }
        c = SIMD3(knee(c.x), knee(c.y), knee(c.z))
        return SIMD3(min(max(c.x, 0), 1), min(max(c.y, 0), 1), min(max(c.z, 0), 1))
    }

    /// The sRGB print, one definition everywhere (tcengine.srgb_print, the web's sRGB canvas): the finished
    /// display-linear Display P3 print, after key, flare and the viewing exponent, converted to linear sRGB and
    /// brought into sRGB by the same soft clip with Rec. 709 luminance weights.
    public static func sRGBPrint(_ p3: SIMD3<Double>) -> SIMD3<Double> {
        softClipGamut(ColorSpaces.p3ToSRGB * p3, luma: rec709Luma)
    }
}
