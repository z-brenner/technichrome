//
//  EngineGPUParityTests.swift
//  TechnichromeTests
//
//  Runs the real Core Image / Metal engine (hosted in the app, so default.metallib is available)
//  on known scene-linear values and compares every pixel with the CPU reference pipeline, which is
//  itself verified against the Python prototype. Runs on the simulator in CI.
//

import XCTest
import CoreImage
@testable import Technichrome

final class EngineGPUParityTests: XCTestCase {
    static let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!

    /// Builds an N×1 scene-linear image whose pixels are the given values, tagged with the working colour
    /// space so Core Image passes them through unchanged.
    func makeImage(_ values: [SIMD3<Double>]) -> CIImage {
        var floats: [Float] = []
        for v in values { floats += [Float(v.x), Float(v.y), Float(v.z), 1] }
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        return CIImage(bitmapData: data, bytesPerRow: values.count * 16, size: CGSize(width: values.count, height: 1),
                       format: .RGBAf, colorSpace: Self.workingSpace)
    }

    func readPixels(_ image: CIImage, context: CIContext, count: Int) -> [SIMD3<Double>] {
        var out = [Float](repeating: 0, count: count * 4)
        context.render(image, toBitmap: &out, rowBytes: count * 16, bounds: CGRect(x: 0, y: 0, width: count, height: 1),
                       format: .RGBAf, colorSpace: Self.workingSpace)
        return (0..<count).map { SIMD3(Double(out[$0 * 4]), Double(out[$0 * 4 + 1]), Double(out[$0 * 4 + 2])) }
    }

    let samples: [SIMD3<Double>] = [
        SIMD3(1, 1, 1), SIMD3(0.18, 0.18, 0.18), SIMD3(0.02, 0.02, 0.02), SIMD3(3, 3, 3), SIMD3(0.42, 0.04, 0.045),
        SIMD3(0.05, 0.3, 0.06), SIMD3(0.04, 0.05, 0.5), SIMD3(0.6, 0.5, 0.1), SIMD3(0.5, 0.3, 0.2), SIMD3(0.2, 0.12, 0.09),
        SIMD3(0, 0, 0), SIMD3(0.9, 0.02, 0.6), SIMD3(0.7, 0.7, 0.2), SIMD3(0.1, 0.4, 0.5), SIMD3(0.33, 0.1, 0.5), SIMD3(2.5, 0.2, 0.1),
    ]

    func testGPUEngineMatchesCPUReference() throws {
        let engine = try TechnichromeEngine(lutDimension: 33)
        let context = CIContext.technichrome()
        let params = EngineParameters.default
        let reference = ReferencePipeline(parameters: params, lutDimension: 33, displaySpace: .displayP3)
        let input = makeImage(samples)
        let output = engine.makeImage(from: input, parameters: params, exposureScale: 1, longEdge: Double(samples.count), spatial: false)
        let pixels = readPixels(output, context: context, count: samples.count)
        var worst = 0.0
        for (i, s) in samples.enumerated() {
            // The engine returns working-space (linear sRGB) values; the reference returns Display P3 linear.
            let expected = ColorSpaces.p3ToSRGB * reference.develop(sceneLinear: s)
            for c in 0..<3 {
                let err = abs(pixels[i][c] - expected[c])
                worst = max(worst, err)
                XCTAssertEqual(pixels[i][c], expected[c], accuracy: 0.02, "sample \(i) \(s) channel \(c): GPU \(pixels[i]) vs reference \(expected)")
            }
        }
        print("GPU vs CPU reference worst error: \(worst)")
    }

    func testMisregistrationLeavesUniformImageUnchanged() throws {
        // A uniform image shifted against itself must print identically: guards the alpha-summing class of bug.
        let engine = try TechnichromeEngine(lutDimension: 33)
        let context = CIContext.technichrome()
        var params = EngineParameters.default
        let uniform = [SIMD3<Double>](repeating: SIMD3(0.42, 0.04, 0.045), count: 8)
        let input = makeImage(uniform)
        let plain = readPixels(engine.makeImage(from: input, parameters: params, exposureScale: 1, longEdge: 4000, spatial: false), context: context, count: 8)
        params.misregistrationAt4K = 2.0
        params.diffusionSigmaAt4K = 0
        let shifted = readPixels(engine.makeImage(from: input, parameters: params, exposureScale: 1, longEdge: 4000, spatial: true), context: context, count: 8)
        for c in 0..<3 { XCTAssertEqual(shifted[4][c], plain[4][c], accuracy: 0.01) }
    }

    func testDyeMaskStagesAreOrderedLikeTheReveal() throws {
        // Key only must be neutral; adding dyes must only remove light from the channels they absorb.
        let engine = try TechnichromeEngine(lutDimension: 33)
        let context = CIContext.technichrome()
        let params = EngineParameters.default
        let input = makeImage([SIMD3(0.42, 0.04, 0.045)])
        func out(_ mask: DyeMask) -> SIMD3<Double> {
            readPixels(engine.makeImage(from: input, parameters: params, exposureScale: 1, longEdge: 1, dyeMask: mask, spatial: false), context: context, count: 1)[0]
        }
        let key = out(.none)
        XCTAssertEqual(key.x, key.y, accuracy: 0.03); XCTAssertEqual(key.y, key.z, accuracy: 0.03)
        let yellow = out(.afterYellow)
        XCTAssertLessThan(yellow.z, key.z, "yellow must absorb blue")
        let cyan = out(.afterCyan)
        XCTAssertLessThanOrEqual(cyan.x, yellow.x + 0.01, "cyan must not add red")
        let all = out(.all)
        XCTAssertLessThan(all.y, cyan.y, "magenta must absorb green")
    }

    func testTimingOnUniformGreyMatchesFormula() throws {
        let engine = try TechnichromeEngine(lutDimension: 17)
        let service = DevelopService(engine: engine)
        let params = EngineParameters.default
        let grey = 0.06
        let input = makeImage([SIMD3<Double>](repeating: SIMD3(repeating: grey), count: 16))
        let measured = service.measureTiming(linear: input, baselineEV: 0, parameters: params)
        let scale = Double(TechnichromeEngine.exposureScale(parameters: params, baselineEV: 0))
        let expected = PrintTiming.exposureEV(geometricMeanLuminance: grey * scale, target: params.timingTarget,
                                              strength: params.timingStrength, limit: params.timingLimit)
        XCTAssertEqual(measured, expected, accuracy: 0.02)
    }
}
