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
    /// Wavelength grid: 360–830 nm in 5 nm steps (95 samples), the range of the CIE tables.
    public static let wavelengths: [Double] = stride(from: 360.0, through: 830.0, by: 5.0).map { $0 }
    public static var sampleCount: Int { wavelengths.count }

    /// CIE 1931 2° standard observer (x̄, ȳ, z̄) on the wavelength grid: the CIE's table, CIE 2019, "Colour-matching
    /// functions of CIE 1931 standard colorimetric observer", DOI 10.25039/CIE.DS.xvudnb9b (from CIE 018:2019, Table 6;
    /// CC BY-SA 4.0), published at 1 nm from 360 to 830 nm; these are its rows at every 5 nm, digits as published, the
    /// same rows as tools/colorscience/tcspectral.py. Equal-energy white integrates to xy (0.33331, 0.33329).
    public static let cmfTable: [SIMD3<Double>] = [
        SIMD3(0.0001299, 0.000003917, 0.0006061),  // 360
        SIMD3(0.0002321, 0.000006965, 0.001086),  // 365
        SIMD3(0.0004149, 0.00001239, 0.001946),  // 370
        SIMD3(0.0007416, 0.00002202, 0.003486),  // 375
        SIMD3(0.001368, 0.000039, 0.006450001),  // 380
        SIMD3(0.002236, 0.000064, 0.01054999),  // 385
        SIMD3(0.004243, 0.00012, 0.02005001),  // 390
        SIMD3(0.00765, 0.000217, 0.03621),  // 395
        SIMD3(0.01431, 0.000396, 0.06785001),  // 400
        SIMD3(0.02319, 0.00064, 0.1102),  // 405
        SIMD3(0.04351, 0.00121, 0.2074),  // 410
        SIMD3(0.07763, 0.00218, 0.3713),  // 415
        SIMD3(0.13438, 0.004, 0.6456),  // 420
        SIMD3(0.21477, 0.0073, 1.0390501),  // 425
        SIMD3(0.2839, 0.0116, 1.3856),  // 430
        SIMD3(0.3285, 0.01684, 1.62296),  // 435
        SIMD3(0.34828, 0.023, 1.74706),  // 440
        SIMD3(0.34806, 0.0298, 1.7826),  // 445
        SIMD3(0.3362, 0.038, 1.77211),  // 450
        SIMD3(0.3187, 0.048, 1.7441),  // 455
        SIMD3(0.2908, 0.06, 1.6692),  // 460
        SIMD3(0.2511, 0.0739, 1.5281),  // 465
        SIMD3(0.19536, 0.09098, 1.28764),  // 470
        SIMD3(0.1421, 0.1126, 1.0419),  // 475
        SIMD3(0.09564, 0.13902, 0.8129501),  // 480
        SIMD3(0.05795001, 0.1693, 0.6162),  // 485
        SIMD3(0.03201, 0.20802, 0.46518),  // 490
        SIMD3(0.0147, 0.2586, 0.3533),  // 495
        SIMD3(0.0049, 0.323, 0.272),  // 500
        SIMD3(0.0024, 0.4073, 0.2123),  // 505
        SIMD3(0.0093, 0.503, 0.1582),  // 510
        SIMD3(0.0291, 0.6082, 0.1117),  // 515
        SIMD3(0.06327, 0.71, 0.07824999),  // 520
        SIMD3(0.1096, 0.7932, 0.05725001),  // 525
        SIMD3(0.1655, 0.862, 0.04216),  // 530
        SIMD3(0.2257499, 0.9148501, 0.02984),  // 535
        SIMD3(0.2904, 0.954, 0.0203),  // 540
        SIMD3(0.3597, 0.9803, 0.0134),  // 545
        SIMD3(0.4334499, 0.9949501, 0.008749999),  // 550
        SIMD3(0.5120501, 1.0, 0.005749999),  // 555
        SIMD3(0.5945, 0.995, 0.0039),  // 560
        SIMD3(0.6784, 0.9786, 0.002749999),  // 565
        SIMD3(0.7621, 0.952, 0.0021),  // 570
        SIMD3(0.8425, 0.9154, 0.0018),  // 575
        SIMD3(0.9163, 0.87, 0.001650001),  // 580
        SIMD3(0.9786, 0.8163, 0.0014),  // 585
        SIMD3(1.0263, 0.757, 0.0011),  // 590
        SIMD3(1.0567, 0.6949, 0.001),  // 595
        SIMD3(1.0622, 0.631, 0.0008),  // 600
        SIMD3(1.0456, 0.5668, 0.0006),  // 605
        SIMD3(1.0026, 0.503, 0.00034),  // 610
        SIMD3(0.9384, 0.4412, 0.00024),  // 615
        SIMD3(0.8544499, 0.381, 0.00019),  // 620
        SIMD3(0.7514, 0.321, 0.0001),  // 625
        SIMD3(0.6424, 0.265, 0.00004999999),  // 630
        SIMD3(0.5419, 0.217, 0.00003),  // 635
        SIMD3(0.4479, 0.175, 0.00002),  // 640
        SIMD3(0.3608, 0.1382, 0.00001),  // 645
        SIMD3(0.2835, 0.107, 0.0),  // 650
        SIMD3(0.2187, 0.0816, 0.0),  // 655
        SIMD3(0.1649, 0.061, 0.0),  // 660
        SIMD3(0.1212, 0.04458, 0.0),  // 665
        SIMD3(0.0874, 0.032, 0.0),  // 670
        SIMD3(0.0636, 0.0232, 0.0),  // 675
        SIMD3(0.04677, 0.017, 0.0),  // 680
        SIMD3(0.0329, 0.01192, 0.0),  // 685
        SIMD3(0.0227, 0.00821, 0.0),  // 690
        SIMD3(0.01584, 0.005723, 0.0),  // 695
        SIMD3(0.01135916, 0.004102, 0.0),  // 700
        SIMD3(0.008110916, 0.002929, 0.0),  // 705
        SIMD3(0.005790346, 0.002091, 0.0),  // 710
        SIMD3(0.004109457, 0.001484, 0.0),  // 715
        SIMD3(0.002899327, 0.001047, 0.0),  // 720
        SIMD3(0.00204919, 0.00074, 0.0),  // 725
        SIMD3(0.001439971, 0.00052, 0.0),  // 730
        SIMD3(0.0009999493, 0.0003611, 0.0),  // 735
        SIMD3(0.0006900786, 0.0002492, 0.0),  // 740
        SIMD3(0.0004760213, 0.0001719, 0.0),  // 745
        SIMD3(0.0003323011, 0.00012, 0.0),  // 750
        SIMD3(0.0002348261, 0.0000848, 0.0),  // 755
        SIMD3(0.0001661505, 0.00006, 0.0),  // 760
        SIMD3(0.000117413, 0.0000424, 0.0),  // 765
        SIMD3(0.00008307527, 0.00003, 0.0),  // 770
        SIMD3(0.00005870652, 0.0000212, 0.0),  // 775
        SIMD3(0.00004150994, 0.00001499, 0.0),  // 780
        SIMD3(0.00002935326, 0.0000106, 0.0),  // 785
        SIMD3(0.00002067383, 0.0000074657, 0.0),  // 790
        SIMD3(0.00001455977, 0.0000052578, 0.0),  // 795
        SIMD3(0.00001025398, 0.0000037029, 0.0),  // 800
        SIMD3(0.000007221456, 0.0000026078, 0.0),  // 805
        SIMD3(0.000005085868, 0.0000018366, 0.0),  // 810
        SIMD3(0.000003581652, 0.0000012934, 0.0),  // 815
        SIMD3(0.000002522525, 0.00000091093, 0.0),  // 820
        SIMD3(0.000001776509, 0.00000064153, 0.0),  // 825
        SIMD3(0.000001251141, 0.00000045181, 0.0),  // 830
    ]

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
