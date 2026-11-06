import XCTest
@testable import TechnichromeCore

final class SpectralMathTests: XCTestCase {
    /// The tabulated CIE 1931 2° observer: equal-energy white is at the centre of the chromaticity diagram, and ȳ
    /// integrates to the CIE's own sum (106.857 at 1 nm; the 5 nm rows times 5 give 106.857 too).
    func testObserverIsTheCIETable() {
        XCTAssertEqual(Spectral.sampleCount, 95)
        XCTAssertEqual(Spectral.wavelengths.first, 360); XCTAssertEqual(Spectral.wavelengths.last, 830)
        XCTAssertEqual(Spectral.cmfTable.count, Spectral.sampleCount)
        let xyz = Spectral.xyz(of: [Double](repeating: 1.0, count: Spectral.sampleCount))
        let sum = xyz.x + xyz.y + xyz.z
        XCTAssertEqual(xyz.x / sum, 1.0 / 3.0, accuracy: 1e-4)
        XCTAssertEqual(xyz.y / sum, 1.0 / 3.0, accuracy: 1e-4)
        XCTAssertEqual(xyz.y * 5, 106.857, accuracy: 0.01)
        // Two rows read straight from the CIE table: ȳ = 1 at 555 nm, and x̄ at 600 nm.
        XCTAssertEqual(Spectral.cmfTable[39], SIMD3(0.5120501, 1.0, 0.005749999))
        XCTAssertEqual(Spectral.cmfTable[48].x, 1.0622, accuracy: 0)
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
