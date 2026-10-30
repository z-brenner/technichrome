//
//  PrintModel.swift
//  Technichrome
//
//  The "virtual dye-transfer print": three dyes with spectral absorbances, a neutral base density,
//  a projector lamp, the CIE observer, and chromatic adaptation of the screen white to the display.
//
//  The model is evaluated once per LUT entry on the CPU (LUTBuilder) — never per pixel.
//

import Foundation

public struct PrintModel: Sendable {
    public let absorbances: [[Double]]      // [dye][wavelength], peak-normalised
    public let projector: [Double]          // lamp SPD on the grid, peak-normalised
    public let printDMin: Double
    public let whiteScale: Double           // 1 / Y of the projector seen through the clear base
    public let xyzToDisplay: Matrix3        // XYZ (print white) → display-linear RGB (D65), adaptation included
    public let displaySpace: DisplaySpace

    public enum DisplaySpace: String, Codable, Sendable { case displayP3, sRGB }

    public init(parameters p: EngineParameters, displaySpace: DisplaySpace = .displayP3) {
        absorbances = [p.cyan.absorbance(), p.magenta.absorbance(), p.yellow.absorbance()]
        projector = Spectral.planck(p.projectorCCT)
        printDMin = p.printDMin
        let baseT = pow(10.0, -p.printDMin)
        let whiteXYZ = Spectral.xyz(of: projector.map { $0 * baseT })
        whiteScale = 1.0 / whiteXYZ.y
        let srcWhite = whiteXYZ * whiteScale
        let cat = ColorSpaces.bradfordAdaptation(from: srcWhite, to: ColorSpaces.xyToXYZ(ColorSpaces.d65))
        let toRGB = displaySpace == .displayP3 ? ColorSpaces.xyzToP3 : ColorSpaces.xyzToSRGB
        xyzToDisplay = toRGB * cat
        self.displaySpace = displaySpace
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

    /// Display-linear RGB (unclipped) for absolute dye densities.
    public func displayLinear(dyeDensities d: SIMD3<Double>) -> SIMD3<Double> {
        xyzToDisplay * xyz(dyeDensities: d)
    }

    /// Bring out-of-gamut colours inside [0,1]: negative components are lifted by scaling chroma toward
    /// the pixel's luminance; values above 0.95 are compressed with a soft knee. Mirrors tcengine.soft_clip_gamut.
    public static func softClipGamut(_ rgb: SIMD3<Double>) -> SIMD3<Double> {
        let Y = 0.2290 * rgb.x + 0.6917 * rgb.y + 0.0793 * rgb.z
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
}
