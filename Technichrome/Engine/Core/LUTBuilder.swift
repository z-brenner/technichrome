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
    /// Build the dye LUT for the given parameters. 33³ takes a few ms; 65³ ≈ 50 ms on a phone.
    public static func build(parameters p: EngineParameters, dimension: Int = 33, displaySpace: PrintModel.DisplaySpace = .displayP3) -> DyeLUT {
        let model = PrintModel(parameters: p, displaySpace: displaySpace)
        var data = [Float](repeating: 0, count: dimension * dimension * dimension * 4)
        let n = Double(dimension - 1)
        var idx = 0
        for b in 0..<dimension {          // yellow
            for g in 0..<dimension {      // magenta
                for r in 0..<dimension {  // cyan
                    let d = SIMD3(Double(r) / n * p.dyeDMax[0], Double(g) / n * p.dyeDMax[1], Double(b) / n * p.dyeDMax[2])
                    let rgb = PrintModel.softClipGamut(model.displayLinear(dyeDensities: d))
                    data[idx] = Float(rgb.x); data[idx + 1] = Float(rgb.y); data[idx + 2] = Float(rgb.z); data[idx + 3] = 1
                    idx += 4
                }
            }
        }
        return DyeLUT(dimension: dimension, data: data)
    }
}
