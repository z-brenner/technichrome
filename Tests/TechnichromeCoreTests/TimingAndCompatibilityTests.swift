import XCTest
@testable import TechnichromeCore

final class TimingAndCompatibilityTests: XCTestCase {
    func testTimingMovesTowardTargetPartiallyAndClamps() {
        // Half a stop dark at strength 0.6 → +0.6 × 0.83 ≈ +0.5 stops
        let ev = PrintTiming.exposureEV(geometricMeanLuminance: 0.09, target: 0.16, strength: 0.6, limit: 1.25)
        XCTAssertEqual(ev, 0.6 * log2(0.16 / 0.09), accuracy: 1e-12)
        XCTAssertGreaterThan(ev, 0.4); XCTAssertLessThan(ev, 0.6)
        XCTAssertEqual(PrintTiming.exposureEV(geometricMeanLuminance: 0.001, target: 0.16, strength: 1, limit: 1.25), 1.25)
        XCTAssertEqual(PrintTiming.exposureEV(geometricMeanLuminance: 2.0, target: 0.16, strength: 1, limit: 1.25), -1.25)
        XCTAssertEqual(PrintTiming.exposureEV(geometricMeanLuminance: 0.16, target: 0.16, strength: 1, limit: 1.25), 0, accuracy: 1e-12)
        XCTAssertEqual(PrintTiming.exposureEV(geometricMeanLuminance: 0.09, target: 0.16, strength: 0, limit: 1.25), 0)
        XCTAssertEqual(PrintTiming.exposureEV(geometricMeanLuminance: 0, target: 0.16, strength: 1, limit: 1.25), 0)
    }

    func testTimingLeavesThePhotographersExposureCompensationAlone() {
        // The same scene, placed the same way by the camera's automatic exposure, once at ±0 and once at
        // −1 EV: the RAW is half as bright, but timing must correct only the camera's own placement.
        let plain = PrintTiming.exposureEV(geometricMeanLuminance: 0.09, target: 0.16, strength: 0.6, limit: 1.25)
        let biased = PrintTiming.exposureEV(geometricMeanLuminance: 0.045, target: 0.16, strength: 0.6, limit: 1.25, cameraBiasEV: -1)
        XCTAssertEqual(biased, plain, accuracy: 1e-12)
        // A bias alone, with the camera's placement already on target, needs no timing at all.
        XCTAssertEqual(PrintTiming.exposureEV(geometricMeanLuminance: 0.32, target: 0.16, strength: 1, limit: 1.25, cameraBiasEV: 1), 0, accuracy: 1e-12)
    }

    func testGeometricMean() {
        XCTAssertEqual(PrintTiming.geometricMean([0.04, 1.0]), 0.2, accuracy: 1e-12)
        XCTAssertEqual(PrintTiming.geometricMean([]), 0)
    }

    func testOlderPresetWithoutNewFieldsStillDecodes() throws {
        // A v1 preset: no timing fields, dye lobes without `shape`.
        let json = """
        {"exposureEV": 0.25, "keyStrength": 0.0,
         "cyan": {"lobes": [{"mu": 650, "sigmaLeft": 50, "sigmaRight": 60, "amplitude": 1.0}]},
         "name": "old preset"}
        """.data(using: .utf8)!
        let p = try EngineParameters.fromJSON(json)
        XCTAssertEqual(p.exposureEV, 0.25)
        XCTAssertEqual(p.keyStrength, 0.0)
        XCTAssertEqual(p.cyan.lobes.count, 1)
        XCTAssertEqual(p.cyan.lobes[0].shape, 2.0)
        XCTAssertEqual(p.timingStrength, EngineParameters.default.timingStrength)
        XCTAssertEqual(p.matrixGamma, EngineParameters.default.matrixGamma)
        XCTAssertEqual(p.name, "old preset")
    }

    func testMalformedMatrixIsRejected() {
        let json = #"{"separationMatrix": [1, 0, 0]}"#.data(using: .utf8)!
        XCTAssertThrowsError(try EngineParameters.fromJSON(json))
    }

    func testPrintModelKeyTracksOnlyPrintModelInputs() {
        var a = EngineParameters.default
        var b = a
        b.exposureEV += 1; b.matrixGamma += 0.5; b.keyStrength = 1
        XCTAssertEqual(PrintModelKey(a), PrintModelKey(b), "tone parameters must not invalidate the dye cube")
        a.projectorCCT += 100
        XCTAssertNotEqual(PrintModelKey(a), PrintModelKey(b))
        var c = EngineParameters.default
        c.cyan.lobes[0].mu += 5
        XCTAssertNotEqual(PrintModelKey(c), PrintModelKey(EngineParameters.default))
    }

    func testLUTIsMonotonicAlongTheNeutralDiagonal() {
        let lut = LUTBuilder.build(parameters: .default, dimension: 17)
        var last = 2.0
        for i in 0...32 {
            let t = Double(i) / 32
            let v = lut.lookup(SIMD3(repeating: t))
            let y = (v.x + v.y + v.z) / 3
            XCTAssertLessThanOrEqual(y, last + 1e-9, "cube not monotonic at \(t)")
            last = y
        }
    }
}
