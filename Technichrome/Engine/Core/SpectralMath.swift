//
//  SpectralMath.swift
//  Technichrome
//
//  Minimal spectral colour toolkit: CIE 1931 2° observer, black-body illuminants, RGB colour
//  spaces and chromatic adaptation. Mirrors tools/colorscience/tcspectral.py exactly; the unit
//  tests compare the two.
//

import Foundation

/// A 3×3 row-major matrix of doubles (kept dependency-free so the core builds on Linux).
public struct Matrix3: Equatable, Sendable {
    public var m: [Double]  // 9 values, row-major

    public init(rows r0: [Double], _ r1: [Double], _ r2: [Double]) {
        precondition(r0.count == 3 && r1.count == 3 && r2.count == 3)
        m = r0 + r1 + r2
    }

    public init(rowMajor values: [Double]) {
        precondition(values.count == 9)
        m = values
    }

    public static let identity = Matrix3(rowMajor: [1, 0, 0, 0, 1, 0, 0, 0, 1])

    public subscript(_ row: Int, _ col: Int) -> Double {
        get { m[row * 3 + col] }
        set { m[row * 3 + col] = newValue }
    }

    public func row(_ i: Int) -> SIMD3<Double> {
        SIMD3(m[i * 3], m[i * 3 + 1], m[i * 3 + 2])
    }

    public static func * (a: Matrix3, v: SIMD3<Double>) -> SIMD3<Double> {
        SIMD3(
            a.m[0] * v.x + a.m[1] * v.y + a.m[2] * v.z,
            a.m[3] * v.x + a.m[4] * v.y + a.m[5] * v.z,
            a.m[6] * v.x + a.m[7] * v.y + a.m[8] * v.z
        )
    }

    public static func * (a: Matrix3, b: Matrix3) -> Matrix3 {
        var r = [Double](repeating: 0, count: 9)
        for i in 0..<3 {
            for j in 0..<3 {
                var s = 0.0
                for k in 0..<3 { s += a[i, k] * b[k, j] }
                r[i * 3 + j] = s
            }
        }
        return Matrix3(rowMajor: r)
    }

    public var transposed: Matrix3 {
        Matrix3(rowMajor: [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
    }

    public var inverse: Matrix3 {
        let a = m
        let det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
        precondition(abs(det) > 1e-14, "singular matrix")
        let inv = 1.0 / det
        return Matrix3(rowMajor: [
            (a[4] * a[8] - a[5] * a[7]) * inv, (a[2] * a[7] - a[1] * a[8]) * inv, (a[1] * a[5] - a[2] * a[4]) * inv,
            (a[5] * a[6] - a[3] * a[8]) * inv, (a[0] * a[8] - a[2] * a[6]) * inv, (a[2] * a[3] - a[0] * a[5]) * inv,
            (a[3] * a[7] - a[4] * a[6]) * inv, (a[1] * a[6] - a[0] * a[7]) * inv, (a[0] * a[4] - a[1] * a[3]) * inv,
        ])
    }

    public static func diagonal(_ d: SIMD3<Double>) -> Matrix3 {
        Matrix3(rowMajor: [d.x, 0, 0, 0, d.y, 0, 0, 0, d.z])
    }

    /// Row-major Float array for passing to Metal / Core Image.
    public var floats: [Float] { m.map { Float($0) } }
}

public enum Spectral {
    /// Wavelength grid: 380–730 nm in 5 nm steps (71 samples).
    public static let wavelengths: [Double] = stride(from: 380.0, through: 730.0, by: 5.0).map { $0 }
    public static var sampleCount: Int { wavelengths.count }

    @inline(__always)
    static func lobe(_ l: Double, _ mu: Double, _ s1: Double, _ s2: Double) -> Double {
        let s = l < mu ? s1 : s2
        let t = (l - mu) / s
        return exp(-0.5 * t * t)
    }

    /// CIE 1931 2° colour-matching functions, multi-lobe Gaussian fit of
    /// Wyman, Sloan & Shirley (2013), JCGT 2(2). Returns (x̄, ȳ, z̄) at wavelength `l` (nm).
    public static func cmf(_ l: Double) -> SIMD3<Double> {
        let x = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2)
        let y = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1)
        let z = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8)
        return SIMD3(x, y, z)
    }

    /// Colour-matching functions sampled on the wavelength grid.
    public static let cmfTable: [SIMD3<Double>] = wavelengths.map(cmf)

    /// Relative spectral radiance of a Planckian radiator at temperature `kelvin`, peak-normalised,
    /// on the wavelength grid.
    public static func planck(_ kelvin: Double) -> [Double] {
        let c1 = 3.741771e-16
        let c2 = 1.438776e-2
        var out = wavelengths.map { nm -> Double in
            let l = nm * 1e-9
            return c1 / pow(l, 5) / (exp(c2 / (l * kelvin)) - 1.0)
        }
        let peak = out.max() ?? 1
        for i in out.indices { out[i] /= peak }
        return out
    }

    /// Asymmetric generalised Gaussian exp(−½·|(λ−μ)/σ|^shape) on the wavelength grid
    /// (used for dye absorbances and taking-filter sensitivities; shape 2 = Gaussian).
    public static func asymmetricGaussian(mu: Double, sigmaLeft: Double, sigmaRight: Double, shape: Double = 2.0) -> [Double] {
        wavelengths.map { l in
            let s = l < mu ? sigmaLeft : sigmaRight
            return exp(-0.5 * pow(abs((l - mu) / s), shape))
        }
    }

    /// ∫ spd · cmf dλ (un-normalised).
    public static func xyz(of spd: [Double]) -> SIMD3<Double> {
        var acc = SIMD3<Double>(repeating: 0)
        for i in 0..<spd.count { acc += cmfTable[i] * spd[i] }
        return acc
    }
}

public enum ColorSpaces {
    public static let d65 = SIMD2<Double>(0.3127, 0.3290)
    public static let sRGBPrimaries: [SIMD2<Double>] = [SIMD2(0.64, 0.33), SIMD2(0.30, 0.60), SIMD2(0.15, 0.06)]
    public static let p3Primaries: [SIMD2<Double>] = [SIMD2(0.680, 0.320), SIMD2(0.265, 0.690), SIMD2(0.150, 0.060)]

    public static func xyToXYZ(_ xy: SIMD2<Double>, Y: Double = 1.0) -> SIMD3<Double> {
        SIMD3(xy.x * Y / xy.y, Y, (1.0 - xy.x - xy.y) * Y / xy.y)
    }

    /// RGB→XYZ matrix from chromaticities (columns are the primaries' XYZ, scaled so RGB(1,1,1) = white).
    public static func rgbToXYZMatrix(primaries: [SIMD2<Double>], white: SIMD2<Double>) -> Matrix3 {
        var cols: [SIMD3<Double>] = []
        for p in primaries { cols.append(SIMD3(p.x / p.y, 1.0, (1.0 - p.x - p.y) / p.y)) }
        let M = Matrix3(rows: [cols[0].x, cols[1].x, cols[2].x], [cols[0].y, cols[1].y, cols[2].y], [cols[0].z, cols[1].z, cols[2].z])
        let W = xyToXYZ(white)
        let S = M.inverse * W
        return Matrix3(rows: [M[0, 0] * S.x, M[0, 1] * S.y, M[0, 2] * S.z],
                             [M[1, 0] * S.x, M[1, 1] * S.y, M[1, 2] * S.z],
                             [M[2, 0] * S.x, M[2, 1] * S.y, M[2, 2] * S.z])
    }

    public static let sRGBToXYZ = rgbToXYZMatrix(primaries: sRGBPrimaries, white: d65)
    public static let xyzToSRGB = sRGBToXYZ.inverse
    public static let p3ToXYZ = rgbToXYZMatrix(primaries: p3Primaries, white: d65)
    public static let xyzToP3 = p3ToXYZ.inverse
    public static let sRGBToP3 = xyzToP3 * sRGBToXYZ
    public static let p3ToSRGB = sRGBToP3.inverse

    static let bradford = Matrix3(rows: [0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296])

    /// Bradford chromatic adaptation from `source` white to `destination` white (both XYZ with Y = 1).
    public static func bradfordAdaptation(from source: SIMD3<Double>, to destination: SIMD3<Double>) -> Matrix3 {
        let s = bradford * source
        let d = bradford * destination
        let D = Matrix3.diagonal(SIMD3(d.x / s.x, d.y / s.y, d.z / s.z))
        return bradford.inverse * D * bradford
    }

    public static func srgbEncode(_ v: Double) -> Double {
        let c = min(max(v, 0), 1)
        return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
    }

    public static func srgbDecode(_ v: Double) -> Double {
        v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }
}
