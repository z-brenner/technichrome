//
//  RAWDeveloper.swift
//  Technichrome
//
//  Turns a RAW file (Bayer DNG or Apple ProRAW linear DNG) into a scene-linear CIImage using
//  Apple's RAW decoder with every "look" stage disabled, then runs the Technichrome engine on it.
//
//  What the decoder does for us: black-level subtraction, linearisation, lens-shading correction,
//  demosaicing (Bayer), noise reduction, white balance (as-shot neutral), camera matrix → working
//  space. What it must NOT do: the global tone curve ("boost"), local tone mapping, gamut mapping,
//  highlight "EDR" styling. With boost = 0 the output is linear (Apple docs: "A value of 0
//  indicates no global tone curve (linear response)").
//
//  Bayer RAW vs Apple ProRAW: see docs/RAW_PIPELINE.md.
//

import Foundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

public struct RAWDecodeInfo: Sendable {
    public var nativeSize: CGSize
    /// DNG BaselineExposure (stops) as reported by the decoder, 0 if absent.
    public var baselineExposure: Double
    public var cameraModel: String
    public var orientation: CGImagePropertyOrientation
}

public enum RAWDeveloperError: Error, LocalizedError {
    case unsupportedRAW
    public var errorDescription: String? { "This file is not a RAW image Core Image can decode." }
}

public final class RAWDeveloper {
    public struct Options: Sendable {
        /// 0…1. Apple's chroma noise reduction. RAW chroma noise reads as "dye grain" after the high
        /// matrix contrast, so a moderate amount is the default. Technicolor prints were grainless.
        public var colorNoiseReduction: Float = 0.6
        public var luminanceNoiseReduction: Float = 0.25
        /// Keep sharpening off: the dye-diffusion stage and the sharp silver key define the texture.
        public var sharpness: Float = 0.0
        public var detail: Float = 0.0
        public var lensCorrection: Bool = true
        /// 0 = full resolution, 0.25 = quick preview
        public var scaleFactor: Float = 1.0
        public var draftMode: Bool = false
        public init() {}
    }

    public let filter: CIRAWFilter
    public let info: RAWDecodeInfo

    public init(url: URL, options: Options = Options()) throws {
        guard let f = CIRAWFilter(imageURL: url) else { throw RAWDeveloperError.unsupportedRAW }
        filter = f
        info = Self.configure(f, options: options, url: url)
    }

    public init(data: Data, identifierHint: String? = UTType.rawImage.identifier, options: Options = Options()) throws {
        guard let f = CIRAWFilter(imageData: data, identifierHint: identifierHint) else { throw RAWDeveloperError.unsupportedRAW }
        filter = f
        info = Self.configure(f, options: options, url: nil)
    }

    private static func configure(_ f: CIRAWFilter, options: Options, url: URL?) -> RAWDecodeInfo {
        // Read the decoder's defaults *before* overriding them: baselineExposure defaults to the DNG tag.
        let baseline = Double(f.baselineExposure)
        let props = f.properties
        let dng = props[kCGImagePropertyDNGDictionary as String] as? [String: Any]
        let model = (dng?[kCGImagePropertyDNGUniqueCameraModel as String] as? String)
            ?? ((props[kCGImagePropertyTIFFDictionary as String] as? [String: Any])?[kCGImagePropertyTIFFModel as String] as? String)
            ?? "Unknown camera"
        let orientationValue = (props[kCGImagePropertyOrientation as String] as? UInt32) ?? 1
        let orientation = CGImagePropertyOrientation(rawValue: orientationValue) ?? .up

        // Linear decode: no tone curve, no local tone map, no gamut mapping, no EDR styling.
        f.boostAmount = 0
        f.boostShadowAmount = 0
        if f.isLocalToneMapSupported { f.localToneMapAmount = 0 }
        f.isGamutMappingEnabled = false
        f.extendedDynamicRangeAmount = 0
        f.baselineExposure = 0          // applied by the engine instead (keeps highlight headroom)
        f.exposure = 0
        f.shadowBias = 0
        if f.isColorNoiseReductionSupported { f.colorNoiseReductionAmount = options.colorNoiseReduction }
        if f.isLuminanceNoiseReductionSupported { f.luminanceNoiseReductionAmount = options.luminanceNoiseReduction }
        if f.isSharpnessSupported { f.sharpnessAmount = options.sharpness }
        if f.isDetailSupported { f.detailAmount = options.detail }
        if f.isLensCorrectionSupported { f.isLensCorrectionEnabled = options.lensCorrection }
        f.scaleFactor = options.scaleFactor
        f.isDraftModeEnabled = options.draftMode
        f.orientation = orientation

        return RAWDecodeInfo(nativeSize: f.nativeSize, baselineExposure: baseline, cameraModel: model, orientation: orientation)
    }

    /// Scene-linear image in the Core Image working space (extended linear sRGB when rendered with
    /// `CIContext.technichrome()`), with the as-shot white balance applied and no tone curve.
    public var linearImage: CIImage? { filter.outputImage }
}
