//
//  LUTBuilder.swift
//  Technichrome
//
//  Bakes the spectral print model into a 3D lookup table indexed by normalised dye densities
//  (cyan → R axis, magenta → G axis, yellow → B axis) and returning gamut-clipped display-linear RGB.
//  Layout matches CIColorCube: RGBA Float32, red (cyan) varying fastest, then green, then blue.
//

import Foundation

public struct DyeLUT: Sendable {
    public let dimension: Int
    /// dimension³ × 4 floats, CIColorCube order.
    public let data: [Float]

    public init(dimension: Int, data: [Float]) {
        self.dimension = dimension
        self.data = data
    }

    @inline(__always)
    func entry(_ r: Int, _ g: Int, _ b: Int) -> SIMD3<Double> {
        let i = ((b * dimension + g) * dimension + r) * 4
        return SIMD3(Double(data[i]), Double(data[i + 1]), Double(data[i + 2]))
    }

    /// Trilinear lookup with normalised densities in [0,1]³ (same arithmetic as the GPU cube).
    public func lookup(_ v: SIMD3<Double>) -> SIMD3<Double> {
        let n = Double(dimension - 1)
        let c = SIMD3(min(max(v.x, 0), 1), min(max(v.y, 0), 1), min(max(v.z, 0), 1)) * n
        var i0 = SIMD3<Int>(Int(c.x), Int(c.y), Int(c.z))
        i0 = SIMD3(min(i0.x, dimension - 2), min(i0.y, dimension - 2), min(i0.z, dimension - 2))
        let f = c - SIMD3(Double(i0.x), Double(i0.y), Double(i0.z))
        var out = SIMD3<Double>(repeating: 0)
        for dr in 0...1 {
            for dg in 0...1 {
                for db in 0...1 {
                    let w = (dr == 1 ? f.x : 1 - f.x) * (dg == 1 ? f.y : 1 - f.y) * (db == 1 ? f.z : 1 - f.z)
                    out += entry(i0.x + dr, i0.y + dg, i0.z + db) * w
                }
            }
        }
        return out
    }
}

public enum LUTBuilder {
    /// Build the dye LUT for the given parameters.
    ///
    /// The print's transmittance factorises per dye, 10^−(d_c·a_c(λ) + d_m·a_m(λ) + d_y·a_y(λ) + Dmin) =
    /// T_c(λ)·T_m(λ)·T_y(λ)·10^−Dmin, so three tables of `dimension` × wavelengths transmittances are computed
    /// once and every entry is a sum of products: 3·dimension·71 `pow` calls instead of 71·dimension³. The
    /// result equals `PrintModel.displayLinear` + `softClipGamut` evaluated at every node (the core tests check
    /// it to 1e-6). Measured in a release build on a shared x86 Linux machine, not on a phone: 33³ in about 3 ms
    /// and 65³ in about 23 ms, where evaluating every node directly took about 29 ms and 250 ms.
    public static func build(parameters p: EngineParameters, dimension: Int = 33, displaySpace: PrintModel.DisplaySpace = .displayP3) -> DyeLUT {
        let model = PrintModel(parameters: p, displaySpace: displaySpace)
        let samples = Spectral.sampleCount
        let n = Double(dimension - 1)
        /// 10^−(j/n · Dmax · a(λᵢ)) for dye `k`, node j major.
        func transmittances(_ k: Int) -> [Double] {
            var t = [Double](repeating: 0, count: dimension * samples)
            for j in 0..<dimension {
                let d = Double(j) / n * p.dyeDMax[k]
                for i in 0..<samples { t[j * samples + i] = pow(10.0, -d * model.absorbances[k][i]) }
            }
            return t
        }
        let tc = transmittances(0), tm = transmittances(1), ty = transmittances(2)
        // The lamp through the clear base, seen by the observer, relative to the print white.
        let base = pow(10.0, -model.printDMin) * model.whiteScale
        let light = (0..<samples).map { Spectral.cmfTable[$0] * (model.projector[$0] * base) }
        var data = [Float](repeating: 0, count: dimension * dimension * dimension * 4)
        var throughMY = [SIMD3<Double>](repeating: .zero, count: samples)   // the light through magenta and yellow
        var idx = 0
        for b in 0..<dimension {          // yellow
            for g in 0..<dimension {      // magenta
                for i in 0..<samples { throughMY[i] = light[i] * (tm[g * samples + i] * ty[b * samples + i]) }
                for r in 0..<dimension {  // cyan
                    var xyz = SIMD3<Double>(repeating: 0)
                    for i in 0..<samples { xyz += throughMY[i] * tc[r * samples + i] }
                    let rgb = PrintModel.softClipGamut(model.xyzToDisplay * xyz)
                    data[idx] = Float(rgb.x); data[idx + 1] = Float(rgb.y); data[idx + 2] = Float(rgb.z); data[idx + 3] = 1
                    idx += 4
                }
            }
        }
        return DyeLUT(dimension: dimension, data: data)
    }
}
