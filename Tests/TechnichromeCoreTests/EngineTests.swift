import XCTest
@testable import TechnichromeCore

final class EngineTests: XCTestCase {
    func testSeparationMatrixRowsSumToOne() {
        let m = EngineParameters.default.separation
        for i in 0..<3 {
            XCTAssertEqual(m[i, 0] + m[i, 1] + m[i, 2], 1.0, accuracy: 1e-3)
            XCTAssertTrue(m[i, 0] >= 0 && m[i, 1] >= 0 && m[i, 2] >= 0)
        }
    }

    func testCharacteristicCurveIsMonotonicAndBounded() {
        let c = CharacteristicCurve(EngineParameters.default.negative)
        var last = -Double.infinity
        for i in stride(from: -5.0, through: 3.0, by: 0.05) {
            let d = c.density(logExposure: i)
            XCTAssertGreaterThanOrEqual(d, last - 1e-12)
            XCTAssertGreaterThanOrEqual(d, c.dMin - 1e-12)
            XCTAssertLessThanOrEqual(d, c.dMin + c.span + 1e-12)
            last = d
        }
    }

    func testLUTCornersAreWhiteAndDark() {
        let lut = LUTBuilder.build(parameters: .default, dimension: 9)
        let white = lut.lookup(SIMD3(0, 0, 0))
        XCTAssertGreaterThan(white.min(), 0.93)
        let black = lut.lookup(SIMD3(1, 1, 1))
        XCTAssertLessThan(black.max(), 0.02)
    }

    func testGreyScaleStaysNeutralAndMonotonic() {
        let pipe = ReferencePipeline(parameters: .default, lutDimension: 17)
        var lastY = Double.infinity
        for stop in stride(from: 2.0, through: -8.0, by: -0.5) {
            let g = pow(2.0, stop)
            let out = pipe.develop(sceneLinear: SIMD3(repeating: g))
            let y = (out.x + out.y + out.z) / 3
            XCTAssertLessThanOrEqual(y, lastY + 1e-9, "not monotonic at stop \(stop)")
            if y > 0.01 {
                XCTAssertLessThan(abs(out.x - out.y) / y, 0.12, "grey not neutral at stop \(stop): \(out)")
                XCTAssertLessThan(abs(out.z - out.y) / y, 0.12, "grey not neutral at stop \(stop): \(out)")
            }
            lastY = y
        }
        let white = pipe.develop(sceneLinear: SIMD3(repeating: 1.0))
        XCTAssertGreaterThan(white.y, 0.6)
        let black = pipe.develop(sceneLinear: SIMD3(repeating: 0.002))
        XCTAssertLessThan(black.y, 0.01)
    }

    func testParametersRoundTripThroughJSON() throws {
        let p = EngineParameters.default
        let data = try p.jsonData()
        let back = try EngineParameters.fromJSON(data)
        XCTAssertEqual(p, back)
    }

    func testSubtractiveRedStaysRed() {
        let pipe = ReferencePipeline(parameters: .default, lutDimension: 17)
        let red = SIMD3(0.42, 0.04, 0.045)
        let out = pipe.develop(sceneLinear: red)
        XCTAssertGreaterThan(out.x, out.y * 2.5)
        XCTAssertGreaterThan(out.x, out.z * 2.5)
    }
}
