//
//  ReferencePipeline.swift
//  Technichrome
//
//  Scalar CPU implementation of the per-pixel engine maths. It is the specification that the
//  Metal kernels follow, the fallback renderer, and what the unit tests exercise against the
//  Python prototype (tools/colorscience/tcengine.py).
//

import Foundation

public struct ReferencePipeline: Sendable {
    public let parameters: EngineParameters
    public let separation: Matrix3
    public let negative: CharacteristicCurve
    public let matrices: [CharacteristicCurve]
    public let key: CharacteristicCurve
    public let lut: DyeLUT
    public let displaySpace: PrintModel.DisplaySpace

    public init(parameters p: EngineParameters, lutDimension: Int = 33, displaySpace: PrintModel.DisplaySpace = .displayP3) {
        parameters = p
        separation = p.separation
        negative = CharacteristicCurve(p.negative)
        matrices = (0..<3).map { CharacteristicCurve(p.matrixCurve($0)) }
        key = CharacteristicCurve(p.key)
        lut = LUTBuilder.build(parameters: p, dimension: lutDimension, displaySpace: displaySpace)
        self.displaySpace = displaySpace
    }

    /// Scene-linear sRGB-primaries RGB → (normalised dye densities, key density).
    public func densities(sceneLinear rgb: SIMD3<Double>) -> (dye: SIMD3<Double>, key: Double) {
        let p = parameters
        let scale = pow(2.0, p.exposureEV)
        let e = SIMD3(max(rgb.x, 0), max(rgb.y, 0), max(rgb.z, 0)) * scale
        let s = separation * e
        let logS = SIMD3(log10(max(s.x, 1e-6)), log10(max(s.y, 1e-6)), log10(max(s.z, 1e-6)))
        let dn = SIMD3(negative.density(logExposure: logS.x), negative.density(logExposure: logS.y), negative.density(logExposure: logS.z))
        let logPrint = -dn
        var dye = SIMD3<Double>(repeating: 0)
        for i in 0..<3 {
            let light = p.dyeLightEV[i] * log10(2.0)   // printer light for this matrix, log10 units
            let d = matrices[i].density(logExposure: logPrint[i] + light) * p.dyeGain[i]
            dye[i] = min(max(d / p.dyeDMax[i], 0), 1)
        }
        let k = key.density(logExposure: logPrint.y) * p.keyStrength
        return (dye, k)
    }

    /// Full per-pixel develop (no spatial stages). Returns display-linear RGB in `displaySpace`, [0,1].
    public func develop(sceneLinear rgb: SIMD3<Double>) -> SIMD3<Double> {
        let (dye, k) = densities(sceneLinear: rgb)
        var out = lut.lookup(dye) * pow(10.0, -k)
        let g = parameters.surroundExponent
        out = SIMD3(pow(min(max(out.x, 0), 1), g), pow(min(max(out.y, 0), 1), g), pow(min(max(out.z, 0), 1), g))
        return out
    }
}
