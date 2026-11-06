import XCTest
@testable import TechnichromeCore

/// The baked dye cube: the factorised bake against the print model evaluated directly.
final class DyeCubeTests: XCTestCase {
    /// Every node of `LUTBuilder.build` must equal `PrintModel.displayLinear` + `softClipGamut` at that node's densities.
    func worstNodeError(_ p: EngineParameters, dimension: Int, displaySpace: PrintModel.DisplaySpace) -> Double {
        let lut = LUTBuilder.build(parameters: p, dimension: dimension, displaySpace: displaySpace)
        let model = PrintModel(parameters: p, displaySpace: displaySpace)
        let n = Double(dimension - 1)
        var worst = 0.0
        for b in 0..<dimension {
            for g in 0..<dimension {
                for r in 0..<dimension {
                    // Each axis spans gain · D max of its dye.
                    let d = SIMD3(Double(r) / n * p.dyeDMax[0] * p.dyeGain[0], Double(g) / n * p.dyeDMax[1] * p.dyeGain[1],
                                  Double(b) / n * p.dyeDMax[2] * p.dyeGain[2])
                    let direct = PrintModel.softClipGamut(model.displayLinear(dyeDensities: d))
                    let baked = lut.entry(r, g, b)
                    for c in 0..<3 { worst = max(worst, abs(baked[c] - direct[c])) }
                }
            }
        }
        return worst
    }

    func testFactorisedBakeEqualsDirectEvaluationAtEveryNode() {
        let shipped = worstNodeError(.default, dimension: 17, displaySpace: .displayP3)
        XCTAssertLessThan(shipped, 1e-6)
        // Three different D max (each dye its own transmittance table), another lamp, the sRGB cube.
        var p = EngineParameters.default
        p.dyeDMax = [3.1, 2.6, 2.3]
        p.projectorCCT = 4800
        p.printDMin = 0.1
        let varied = worstNodeError(p, dimension: 9, displaySpace: .sRGB)
        XCTAssertLessThan(varied, 1e-6)
        print("factorised cube vs direct evaluation: \(shipped) (shipped look, 17³), \(varied) (varied, 9³, sRGB)")
    }
}

/// The engine's cube cache (TechnichromeEngine.cubeData): several looks at once, bakes only on a miss, any thread.
final class DyeCubeCacheTests: XCTestCase {
    /// The shipped look and one whose print model differs (another lamp).
    let a = EngineParameters.default
    var b: EngineParameters { var p = EngineParameters.default; p.projectorCCT = 4800; return p }

    func bytes(_ p: EngineParameters, _ dimension: Int) -> Data {
        LUTBuilder.build(parameters: p, dimension: dimension).data.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    func testTwoLooksInTurnBakeOnceEach() {
        let cache = DyeCubeCache(dimension: 9)
        for _ in 0..<5 {
            XCTAssertEqual(cache.cube(for: a).data, bytes(a, 9))
            XCTAssertEqual(cache.cube(for: b).data, bytes(b, 9))
        }
        XCTAssertEqual(cache.bakeCount, 2, "the preview's look and the Laboratory's must not evict each other")
        XCTAssertEqual(cache.cube(for: a).dimension, 9)
    }

    func testToneParametersReuseTheCube() {
        let cache = DyeCubeCache(dimension: 9)
        var p = a
        _ = cache.cube(for: p)
        p.exposureEV = 1; p.matrixGamma += 0.5; p.keyStrength = 1; p.dyeLightEV = [0.3, 0, -0.2]
        _ = cache.cube(for: p)
        XCTAssertEqual(cache.bakeCount, 1, "only the print-model inputs select a cube")
    }

    func testTheLeastRecentlyUsedCubeGoesFirst() {
        let cache = DyeCubeCache(dimension: 5, capacity: 2)
        var c = a
        c.dyeDMax = [3.1, 2.6, 2.3]
        _ = cache.cube(for: a); _ = cache.cube(for: b)
        _ = cache.cube(for: a)                        // a is now the most recent: c evicts b
        _ = cache.cube(for: c)
        XCTAssertEqual(cache.bakeCount, 3)
        _ = cache.cube(for: a)
        XCTAssertEqual(cache.bakeCount, 3, "a stayed")
        _ = cache.cube(for: b)
        XCTAssertEqual(cache.bakeCount, 4, "b was evicted")
    }

    func testConcurrentCallersGetTheSameCubes() {
        let cache = DyeCubeCache(dimension: 9)
        let expected = [bytes(a, 9), bytes(b, 9)]
        let looks = [a, b]
        let lock = NSLock()
        var mismatches = 0
        DispatchQueue.concurrentPerform(iterations: 64) { i in
            let cube = cache.cube(for: looks[i % 2])
            if cube.data != expected[i % 2] { lock.lock(); mismatches += 1; lock.unlock() }
        }
        XCTAssertEqual(mismatches, 0)
        let afterRace = cache.bakeCount
        XCTAssertGreaterThanOrEqual(afterRace, 2)
        for i in 0..<8 { _ = cache.cube(for: looks[i % 2]) }
        XCTAssertEqual(cache.bakeCount, afterRace, "both looks are kept once baked")
    }
}
