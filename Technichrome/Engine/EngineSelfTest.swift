//
//  EngineSelfTest.swift
//  Technichrome
//
//  Runs the GPU engine on known scene-linear colours and compares every pixel with the CPU reference
//  pipeline, on the device in hand. The same check runs on the simulator in CI; this one tells you what
//  this phone's GPU does with the kernels and the dye cube.
//

import Foundation
import CoreImage

public struct EngineSelfTestResult: Sendable {
    public let worstError: Double
    public let sampleCount: Int
    public let passed: Bool
    public let detail: String
}

public enum EngineSelfTest {
    static let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
    static let tolerance = 0.02

    public static let samples: [SIMD3<Double>] = [
        SIMD3(1, 1, 1), SIMD3(0.18, 0.18, 0.18), SIMD3(0.02, 0.02, 0.02), SIMD3(3, 3, 3), SIMD3(0.42, 0.04, 0.045),
        SIMD3(0.05, 0.3, 0.06), SIMD3(0.04, 0.05, 0.5), SIMD3(0.6, 0.5, 0.1), SIMD3(0.5, 0.3, 0.2), SIMD3(0.2, 0.12, 0.09),
        SIMD3(0, 0, 0), SIMD3(0.9, 0.02, 0.6), SIMD3(0.7, 0.7, 0.2), SIMD3(0.1, 0.4, 0.5), SIMD3(0.33, 0.1, 0.5), SIMD3(2.5, 0.2, 0.1),
    ]

    public static func run(engine: TechnichromeEngine, parameters: EngineParameters) -> EngineSelfTestResult {
        let context = CIContext.technichrome()
        let reference = ReferencePipeline(parameters: parameters, lutDimension: engine.lutDimension, displaySpace: .displayP3)
        var floats: [Float] = []
        for v in samples { floats += [Float(v.x), Float(v.y), Float(v.z), 1] }
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        let input = CIImage(bitmapData: data, bytesPerRow: samples.count * 16, size: CGSize(width: samples.count, height: 1),
                            format: .RGBAf, colorSpace: workingSpace)
        // The reference applies the parameters' exposure itself; the GPU graph takes it as a scale, so pass the
        // same one (a nonzero exposureEV saved from the Laboratory must not read as an engine failure).
        let scale = TechnichromeEngine.exposureScale(parameters: parameters, baselineEV: 0)
        let output = engine.makeImage(from: input, parameters: parameters, exposureScale: scale, longEdge: Double(samples.count), spatial: false)
        var out = [Float](repeating: 0, count: samples.count * 4)
        context.render(output, toBitmap: &out, rowBytes: samples.count * 16, bounds: CGRect(x: 0, y: 0, width: samples.count, height: 1),
                       format: .RGBAf, colorSpace: workingSpace)
        var worst = 0.0
        var worstIndex = 0
        for (i, s) in samples.enumerated() {
            let expected = ColorSpaces.p3ToSRGB * reference.develop(sceneLinear: s)
            for c in 0..<3 {
                let err = abs(Double(out[i * 4 + c]) - expected[c])
                if err > worst { worst = err; worstIndex = i }
            }
        }
        let passed = worst < tolerance
        let detail = String(format: "max |GPU − reference| = %.4f on sample %d (tolerance %.2f)", worst, worstIndex, tolerance)
        return EngineSelfTestResult(worstError: worst, sampleCount: samples.count, passed: passed, detail: detail)
    }
}
