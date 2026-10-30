import XCTest
@testable import TechnichromeCore

final class SpectralMathTests: XCTestCase {
    func testColourMatchingFunctionsIntegrateEqualEnergyToNearlyEqualXYZ() {
        let spd = [Double](repeating: 1.0, count: Spectral.sampleCount)
        let xyz = Spectral.xyz(of: spd)
        XCTAssertEqual(xyz.x / xyz.y, 1.0, accuracy: 0.01)
        XCTAssertEqual(xyz.z / xyz.y, 1.0, accuracy: 0.01)
    }

    func testSRGBMatrixMatchesStandardValues() {
        let m = ColorSpaces.sRGBToXYZ
        XCTAssertEqual(m[0, 0], 0.4124, accuracy: 0.001)
        XCTAssertEqual(m[1, 1], 0.7152, accuracy: 0.001)
        XCTAssertEqual(m[2, 2], 0.9505, accuracy: 0.001)
        let white = m * SIMD3(1, 1, 1)
        XCTAssertEqual(white.y, 1.0, accuracy: 1e-9)
        XCTAssertEqual(white.x, 0.9505, accuracy: 0.001)
    }

    func testP3RoundTrip() {
        let v = SIMD3(0.3, 0.6, 0.1)
        let back = ColorSpaces.p3ToSRGB * (ColorSpaces.sRGBToP3 * v)
        XCTAssertEqual(back.x, v.x, accuracy: 1e-9)
        XCTAssertEqual(back.y, v.y, accuracy: 1e-9)
        XCTAssertEqual(back.z, v.z, accuracy: 1e-9)
    }

    func testBradfordAdaptationIsIdentityForSameWhite() {
        let w = ColorSpaces.xyToXYZ(ColorSpaces.d65)
        let m = ColorSpaces.bradfordAdaptation(from: w, to: w)
        for i in 0..<3 { for j in 0..<3 { XCTAssertEqual(m[i, j], i == j ? 1 : 0, accuracy: 1e-9) } }
    }

    func testPlanckPeakNormalised() {
        let p = Spectral.planck(5400)
        XCTAssertEqual(p.max()!, 1.0, accuracy: 1e-12)
        XCTAssertTrue(p.allSatisfy { $0 > 0 })
    }

    func testMatrixInverse() {
        let m = Matrix3(rows: [2, 0, 1], [1, 3, 0], [0, 1, 4])
        let id = m * m.inverse
        for i in 0..<3 { for j in 0..<3 { XCTAssertEqual(id[i, j], i == j ? 1 : 0, accuracy: 1e-12) } }
    }
}
