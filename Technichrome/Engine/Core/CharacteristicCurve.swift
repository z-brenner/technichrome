//
//  CharacteristicCurve.swift
//  Technichrome
//
//  Generalised H&D curve: density as a function of log10 exposure, as a Richards curve
//
//      g(x) = (1 + ν·exp(−x))^(−1/ν),   x = a·(logE − logE0) + xHalf
//
//  ν = 1 is the plain logistic; ν → 0 approaches a Gompertz curve, whose toe starts abruptly and
//  whose shoulder approaches D_max slowly — the behaviour of print materials (short toe above
//  diffuse white, steep straight line, long roll-off into maximum density). `logE0` is the log
//  exposure at half density and `gamma` the slope there.
//
//  The Metal kernel (Technichrome.metal, `tc_curve`) implements exactly this function; keep both in sync.
//

import Foundation

public struct CharacteristicCurve: Sendable {
    public let dMin: Double
    public let span: Double
    /// Steepness in x per log10 exposure, derived so that the slope at half density equals gamma.
    public let a: Double
    public let logE0: Double
    public let nu: Double
    /// x at which g = 0.5.
    public let xHalf: Double

    public init(_ p: CurveParameters) {
        dMin = p.dMin
        span = p.dMax - p.dMin
        nu = max(p.nu, 1e-4)
        logE0 = p.logE0
        xHalf = -log((pow(2.0, nu) - 1.0) / nu)
        let slopeHalf = 0.5 * (pow(2.0, nu) - 1.0) / (nu * pow(2.0, nu))
        a = span > 0 ? p.gamma / (span * slopeHalf) : 0
    }

    @inline(__always)
    public func density(logExposure: Double) -> Double {
        let x = a * (logExposure - logE0) + xHalf
        let g = pow(1.0 + nu * exp(-x), -1.0 / nu)
        return dMin + span * g
    }
}
