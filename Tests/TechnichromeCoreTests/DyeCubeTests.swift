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
                    let d = SIMD3(Double(r) / n * p.dyeDMax[0], Double(g) / n * p.dyeDMax[1], Double(b) / n * p.dyeDMax[2])
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
