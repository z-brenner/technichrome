//
//  TechnichromeEngine.swift
//  Technichrome
//
//  The GPU rendering engine: assembles the Core Image graph that turns a scene-linear image into a
//  Technichrome print. Used for the live preview (video frames), the quick develop preview and the
//  full-resolution develop. Core Image tiles large images automatically, so 12 MP Bayer RAW and
//  48 MP ProRAW go through the same code path.
//

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Metal

/// Which dye matrices have been transferred — drives the develop "reveal" animation.
public struct DyeMask: Equatable, Sendable {
    public var cyan: Bool
    public var magenta: Bool
    public var yellow: Bool

    public init(cyan: Bool, magenta: Bool, yellow: Bool) {
        self.cyan = cyan; self.magenta = magenta; self.yellow = yellow
    }

    public static let all = DyeMask(cyan: true, magenta: true, yellow: true)
    public static let none = DyeMask(cyan: false, magenta: false, yellow: false)
    /// Ball (1935) demonstration order: sound track + yellow, then cyan, then magenta.
    public static let afterYellow = DyeMask(cyan: false, magenta: false, yellow: true)
    public static let afterCyan = DyeMask(cyan: true, magenta: false, yellow: true)

    var vector: CIVector { CIVector(x: cyan ? 1 : 0, y: magenta ? 1 : 0, z: yellow ? 1 : 0) }
}

public enum EngineError: Error, LocalizedError {
    case metalLibraryMissing
    case kernelMissing(String)

    public var errorDescription: String? {
        switch self {
        case .metalLibraryMissing: return "The Technichrome Metal kernel library (default.metallib) is missing from the app bundle."
        case .kernelMissing(let name): return "Core Image kernel \(name) could not be loaded."
        }
    }
}

/// Thread-safe: build once, use from any queue. Parameters are captured per call.
public final class TechnichromeEngine: @unchecked Sendable {
    public static let workingColorSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
    public static let outputColorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

    private let bloomKernel: CIColorKernel
    private let separateKernel: CIColorKernel
    private let keyKernel: CIColorKernel
    private let printKernel: CIColorKernel
    private let linearViewKernel: CIColorKernel
    private let pickChannelsKernel: CIColorKernel
    private let logLuminanceKernel: CIColorKernel

    private let lutLock = NSLock()
    private var lutCache: (key: PrintModelKey, cube: Data, dimension: Int)?
    public let lutDimension: Int

    public init(lutDimension: Int = 33) throws {
        guard let url = Bundle.main.url(forResource: "default", withExtension: "metallib") else {
            throw EngineError.metalLibraryMissing
        }
        let data = try Data(contentsOf: url)
        func load(_ name: String) throws -> CIColorKernel {
            do {
                return try CIColorKernel(functionName: name, fromMetalLibraryData: data)
            } catch {
                throw EngineError.kernelMissing(name)
            }
        }
        bloomKernel = try load("tc_bloom_threshold")
        separateKernel = try load("tc_separate")
        keyKernel = try load("tc_key")
        printKernel = try load("tc_print")
        linearViewKernel = try load("tc_linear_view")
        pickChannelsKernel = try load("tc_pick_channels")
        logLuminanceKernel = try load("tc_log_luminance")
        self.lutDimension = lutDimension
    }

    // MARK: - LUT

    /// Bakes (and caches) the dye cube for a parameter set. Only the print-model parameters matter
    /// for the cube, so edits to exposure/curves reuse the cached data.
    public func cubeData(for p: EngineParameters) -> (Data, Int) {
        let key = PrintModelKey(p)
        lutLock.lock(); defer { lutLock.unlock() }
        if let c = lutCache, c.key == key {
            return (c.cube, c.dimension)
        }
        let lut = LUTBuilder.build(parameters: p, dimension: lutDimension, displaySpace: .displayP3)
        let data = lut.data.withUnsafeBufferPointer { Data(buffer: $0) }
        lutCache = (key, data, lut.dimension)
        return (data, lut.dimension)
    }

    // MARK: - Graph

    /// Exposure scale applied to the scene-linear input.
    /// `baselineEV` is the DNG BaselineExposure (0 for images that have none).
    public static func exposureScale(parameters p: EngineParameters, baselineEV: Double, extraEV: Double = 0) -> Float {
        Float(pow(2.0, p.exposureEV + baselineEV + extraEV))
    }

    /// Builds the full Technichrome graph for a scene-linear image in the working colour space.
    /// - Parameters:
    ///   - input: scene-linear image (CIRAWFilter output with boost 0, or a video frame CI has linearised)
    ///   - parameters: engine parameters
    ///   - exposureScale: linear multiplier (see `exposureScale(parameters:baselineEV:)`)
    ///   - longEdge: long edge of the *full-resolution* image, so spatial stages scale correctly when
    ///     rendering a scaled-down preview (pass the preview's own long edge for previews)
    ///   - dyeMask: which dyes are transferred (reveal animation)
    ///   - spatial: whether to run the spatial stages (diffusion, bloom, misregistration)
    public func makeImage(from input: CIImage, parameters p: EngineParameters, exposureScale: Float,
                          longEdge: Double, dyeMask: DyeMask = .all, spatial: Bool = true) -> CIImage {
        let extent = input.extent
        let src = input

        // Bloom / halation (optional)
        var glow: CIImage = CIImage(color: CIColor.black).cropped(to: extent)
        let bloomAmount: Float = spatial && p.bloomAmount > 0 ? Float(p.bloomAmount) : 0
        if bloomAmount > 0 {
            let excess = bloomKernel.apply(extent: extent, arguments: [src, Float(p.bloomThreshold)]) ?? glow
            let radius = max(1.0, p.bloomRadiusPercent / 100.0 * longEdge)
            glow = excess.clampedToExtent().applyingGaussianBlur(sigma: radius).cropped(to: extent)
        }

        // Three-strip camera, negatives, matrices → dye densities
        let neg = CharacteristicCurve(p.negative)
        let mat = CharacteristicCurve(p.matrixCurve(0))   // gamma/logE0/toe/shoulder shared across dyes
        let sep = p.separation
        let negVec = CIVector(x: CGFloat(neg.a), y: CGFloat(neg.logE0), z: CGFloat(neg.dMin), w: CGFloat(neg.span))
        let negShape = CIVector(x: CGFloat(neg.xHalf), y: CGFloat(neg.nu))
        let matVec = CIVector(x: CGFloat(mat.a), y: CGFloat(mat.logE0), z: CGFloat(mat.xHalf), w: CGFloat(mat.nu))
        let dmax = CIVector(x: CGFloat(p.dyeDMax[0]), y: CGFloat(p.dyeDMax[1]), z: CGFloat(p.dyeDMax[2]))
        let gain = CIVector(x: CGFloat(p.dyeGain[0]), y: CGFloat(p.dyeGain[1]), z: CGFloat(p.dyeGain[2]))
        let l10 = log10(2.0)
        let light = CIVector(x: CGFloat(p.dyeLightEV[0] * l10), y: CGFloat(p.dyeLightEV[1] * l10), z: CGFloat(p.dyeLightEV[2] * l10))
        func row(_ i: Int) -> CIVector { CIVector(x: CGFloat(sep[i, 0]), y: CGFloat(sep[i, 1]), z: CGFloat(sep[i, 2])) }

        guard var densities = separateKernel.apply(extent: extent, arguments: [
            src, glow, bloomAmount, exposureScale, row(0), row(1), row(2), negVec, negShape, matVec, dmax, gain, light, dyeMask.vector
        ]) else { return input }

        // Silver key image
        let keyCurve = CharacteristicCurve(p.key)
        let keyVec = CIVector(x: CGFloat(keyCurve.a), y: CGFloat(keyCurve.logE0),
                              z: CGFloat(keyCurve.span * p.keyStrength), w: CGFloat(keyCurve.xHalf))
        let keyT = keyKernel.apply(extent: extent, arguments: [src, glow, bloomAmount, exposureScale, row(1), negVec, negShape, keyVec, Float(keyCurve.nu)])
            ?? CIImage(color: CIColor.white).cropped(to: extent)

        // Dye diffusion in the gelatin (the key stays sharp)
        if spatial {
            let sigma = p.diffusionSigma(longEdge: longEdge)
            if sigma > 0.15 {
                densities = densities.clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: extent)
            }
            let shift = p.misregistration(longEdge: longEdge)
            if shift > 0.05 {
                densities = misregister(densities, by: shift, extent: extent)
            }
        }

        // Spectral print model (baked cube): densities → display-linear P3
        let (cube, dim) = cubeData(for: p)
        let cubeFilter = CIFilter.colorCube()
        cubeFilter.cubeDimension = Float(dim)
        cubeFilter.cubeData = cube
        cubeFilter.inputImage = densities
        let printed = cubeFilter.outputImage ?? densities

        // Key, viewing compensation, back to working space
        let m = ColorSpaces.p3ToSRGB
        func mrow(_ i: Int) -> CIVector { CIVector(x: CGFloat(m[i, 0]), y: CGFloat(m[i, 1]), z: CGFloat(m[i, 2])) }
        let out = printKernel.apply(extent: extent, arguments: [printed, keyT, Float(p.surroundExponent), Float(p.screenFlare), mrow(0), mrow(1), mrow(2)])
        return out ?? printed
    }

    /// log2(luminance) per pixel of a scene-linear image (red channel), for print timing.
    public func makeLogLuminance(from input: CIImage, exposureScale: Float) -> CIImage {
        logLuminanceKernel.apply(extent: input.extent, arguments: [input, exposureScale]) ?? input
    }

    /// A plain linear rendering of the same input (for the comparison view): exposure only.
    public func makeLinearView(from input: CIImage, exposureScale: Float) -> CIImage {
        linearViewKernel.apply(extent: input.extent, arguments: [input, exposureScale]) ?? input
    }

    /// Shifts the three dye images relative to each other (imperfect pin registration): three shifted
    /// copies of the density image, recombined channel-wise by a kernel so alpha is never summed.
    private func misregister(_ densities: CIImage, by shift: Double, extent: CGRect) -> CIImage {
        func shifted(dx: Double, dy: Double) -> CIImage {
            densities.clampedToExtent().transformed(by: CGAffineTransform(translationX: dx, y: dy)).cropped(to: extent)
        }
        let c = shifted(dx: shift, dy: 0)
        let m = shifted(dx: -0.5 * shift, dy: 0.866 * shift)
        let y = shifted(dx: -0.5 * shift, dy: -0.866 * shift)
        return pickChannelsKernel.apply(extent: extent, arguments: [c, m, y]) ?? densities
    }
}

public extension CIContext {
    /// The context every Technichrome render uses: linear working space with extended range so that
    /// RAW highlights above 1.0 and Display P3 colours outside sRGB survive between kernels.
    static func technichrome(device: MTLDevice? = MTLCreateSystemDefaultDevice()) -> CIContext {
        let options: [CIContextOption: Any] = [
            .workingColorSpace: TechnichromeEngine.workingColorSpace,
            .workingFormat: CIFormat.RGBAh,
            .cacheIntermediates: false,
            .name: "Technichrome",
        ]
        if let device { return CIContext(mtlDevice: device, options: options) }
        return CIContext(options: options)
    }
}
