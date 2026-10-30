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

    func testScreenFlareLiftsBlackToTheDocumentedFloorAndKeepsWhite() {
        XCTAssertEqual(EngineParameters.default.screenFlare, 0, "the shipped look has no screen flare")
        var p = EngineParameters.default
        p.screenFlare = 1.0 / 64.0   // Ball (1935): projected contrast about 1 to 64
        let pipe = ReferencePipeline(parameters: p, lutDimension: 17)
        let black = pipe.develop(sceneLinear: SIMD3(repeating: 0))
        let white = pipe.develop(sceneLinear: SIMD3(repeating: 4))
        let floor = pow(1.0 / 65.0, p.surroundExponent)         // (0 + f) / (1 + f), then the viewing exponent
        XCTAssertGreaterThan(black.min(), floor * 0.98)
        XCTAssertLessThan(black.max(), pow(1.0 / 25.0, p.surroundExponent), "the floor is a lift, not a wash")
        XCTAssertGreaterThan(white.min(), 0.9)
        let plain = ReferencePipeline(parameters: .default, lutDimension: 17).develop(sceneLinear: SIMD3(repeating: 4))
        XCTAssertEqual(white.x, plain.x, accuracy: 0.03, "white is unchanged by flare")
    }

    func testSubtractiveRedStaysRed() {
        let pipe = ReferencePipeline(parameters: .default, lutDimension: 17)
        let red = SIMD3(0.42, 0.04, 0.045)
        let out = pipe.develop(sceneLinear: red)
        XCTAssertGreaterThan(out.x, out.y * 2.5)
        XCTAssertGreaterThan(out.x, out.z * 2.5)
    }
}

final class PrinterLightTests: XCTestCase {
    func testMoreLightOnTheCyanMatrixDarkensRed() {
        var p = EngineParameters.default
        let base = ReferencePipeline(parameters: p, lutDimension: 17).develop(sceneLinear: SIMD3(repeating: 0.3))
        p.dyeLightEV = [0.5, 0, 0]
        let lit = ReferencePipeline(parameters: p, lutDimension: 17).develop(sceneLinear: SIMD3(repeating: 0.3))
        XCTAssertLessThan(lit.x, base.x - 0.02, "more cyan dye must absorb more red")
        // Cyan's unwanted absorptions take some green and blue too, but red must fall the most.
        XCTAssertLessThan(lit.x / base.x, lit.y / base.y)
        XCTAssertLessThan(lit.x / base.x, lit.z / base.z)
    }

    func testEqualLightsOnAllMatricesActLikeExposure() {
        var p = EngineParameters.default
        let base = ReferencePipeline(parameters: p, lutDimension: 17).develop(sceneLinear: SIMD3(repeating: 0.3))
        p.dyeLightEV = [0.25, 0.25, 0.25]
        let lit = ReferencePipeline(parameters: p, lutDimension: 17).develop(sceneLinear: SIMD3(repeating: 0.3))
        // More light on every matrix = a darker print, still neutral.
        XCTAssertLessThan((lit.x + lit.y + lit.z), (base.x + base.y + base.z))
        XCTAssertLessThan(abs(lit.x - lit.y) / lit.y, 0.12)
    }
}
