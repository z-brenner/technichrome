//
//  DevelopService.swift
//  Technichrome
//
//  Develops a stored photograph: RAW → scene-linear → Technichrome print → JPEG (Display P3) +
//  thumbnail. Also renders quick previews for the develop animation and the Laboratory.
//

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

public struct DevelopedImage: @unchecked Sendable {
    public let image: CGImage           // display-sized (long edge ≈ 1500 px), Display P3
    public let baselineExposure: Double
}

public enum DevelopError: Error, LocalizedError {
    case renderFailed
    case writeFailed(URL)
    public var errorDescription: String? {
        switch self {
        case .renderFailed: return "The print could not be rendered."
        case .writeFailed(let url): return "The print could not be written to \(url.lastPathComponent)."
        }
    }
}

public final class DevelopService: @unchecked Sendable {
    public let engine: TechnichromeEngine
    public let context: CIContext

    public init(engine: TechnichromeEngine) {
        self.engine = engine
        self.context = CIContext.technichrome()
    }

    /// The scene-linear source for a record: RAW through the linear decoder, or a HEIF linearised by Core Image.
    public func linearSource(for record: PhotoRecord, store: PhotoStore, scaleFactor: Float = 1.0, draft: Bool = false) throws -> (CIImage, Double) {
        let url = store.originalURL(for: record)
        if record.hasRAW {
            var opts = RAWDeveloper.Options.adaptive(iso: record.iso)
            opts.scaleFactor = scaleFactor
            opts.draftMode = draft
            let dev = try RAWDeveloper(url: url, options: opts)
            guard let img = dev.linearImage else { throw RAWDeveloperError.unsupportedRAW }
            return (img, dev.info.baselineExposure)
        } else {
            guard var img = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { throw RAWDeveloperError.unsupportedRAW }
            if scaleFactor < 1 {
                img = img.transformed(by: CGAffineTransform(scaleX: CGFloat(scaleFactor), y: CGFloat(scaleFactor)))
            }
            return (img, 0)
        }
    }

    public func makePrint(linear: CIImage, baselineEV: Double, parameters: EngineParameters, extraEV: Double,
                          fullLongEdge: Double, dyeMask: DyeMask = .all, spatial: Bool = true) -> CIImage {
        let scale = TechnichromeEngine.exposureScale(parameters: parameters, baselineEV: baselineEV, extraEV: extraEV)
        return engine.makeImage(from: linear, parameters: parameters, exposureScale: scale, longEdge: fullLongEdge, dyeMask: dyeMask, spatial: spatial)
    }

    /// Print timing: measures the scene's geometric-mean luminance (after the DNG baseline exposure and the
    /// engine's fixed exposure, before any per-print choice) and returns the correction in stops. The
    /// photographer's exposure compensation (`cameraBiasEV`) is excluded from the correction.
    public func measureTiming(linear: CIImage, baselineEV: Double, parameters p: EngineParameters, cameraBiasEV: Double = 0) -> Double {
        guard p.timingStrength > 0 else { return 0 }
        let scale = TechnichromeEngine.exposureScale(parameters: p, baselineEV: baselineEV)
        let logLum = engine.makeLogLuminance(from: linear, exposureScale: scale)
        let average = CIFilter.areaAverage()
        average.inputImage = logLum
        average.extent = linear.extent
        guard let out = average.outputImage else { return 0 }
        var pixel = [Float](repeating: 0, count: 4)
        context.render(out, toBitmap: &pixel, rowBytes: 16, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: nil)
        let geometricMean = pow(2.0, Double(pixel[0]))
        return PrintTiming.exposureEV(geometricMeanLuminance: geometricMean, target: p.timingTarget, strength: p.timingStrength,
                                      limit: p.timingLimit, cameraBiasEV: cameraBiasEV)
    }

    public func render(_ image: CIImage) -> CGImage? {
        context.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: TechnichromeEngine.outputColorSpace)
    }

    /// Full-resolution develop, written to disk. The graph is evaluated exactly once; the thumbnail and the
    /// display image are derived from that render.
    @discardableResult
    public func developToDisk(record: PhotoRecord, store: PhotoStore, parameters: EngineParameters, extraEV: Double) throws -> DevelopedImage {
        let (linear, baseline) = try linearSource(for: record, store: store)
        let longEdge = Double(max(linear.extent.width, linear.extent.height))
        let print = makePrint(linear: linear, baselineEV: baseline, parameters: parameters, extraEV: extraEV, fullLongEdge: longEdge)
        guard let full = render(print) else { throw DevelopError.renderFailed }

        let provenance = Self.printMetadata(from: store.originalURL(for: record))
        try Self.writeJPEG(full, to: store.developedURL(for: record), quality: 0.95, metadata: provenance)

        let fullImage = CIImage(cgImage: full)
        let thumbScale = min(1.0, 600.0 / longEdge)
        guard let thumb = render(fullImage.transformed(by: CGAffineTransform(scaleX: thumbScale, y: thumbScale))) else {
            throw DevelopError.renderFailed
        }
        try Self.writeJPEG(thumb, to: store.thumbnailURL(for: record), quality: 0.85)

        let displayScale = min(1.0, 1500.0 / longEdge)
        guard let display = render(fullImage.transformed(by: CGAffineTransform(scaleX: displayScale, y: displayScale))) else {
            throw DevelopError.renderFailed
        }
        return DevelopedImage(image: display, baselineExposure: baseline)
    }

    /// Writes a CGImage (which carries its Display P3 colour space) as a JPEG with ImageIO, with optional
    /// EXIF/TIFF metadata.
    static func writeJPEG(_ image: CGImage, to url: URL, quality: Double, metadata: [CFString: Any] = [:]) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw DevelopError.writeFailed(url)
        }
        var props = metadata
        props[kCGImageDestinationLossyCompressionQuality] = quality
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw DevelopError.writeFailed(url) }
    }

    /// The provenance a print carries: the camera, exposure, lens and date tags of its original, plus a
    /// Software tag. Location tags are never copied. Orientation is not copied either: the print is upright.
    static func printMetadata(from original: URL) -> [CFString: Any] {
        guard let source = CGImageSourceCreateWithURL(original as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return [kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFSoftware: "Technichrome"]]
        }
        var out: [CFString: Any] = [:]
        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            let keep: [CFString] = [
                kCGImagePropertyExifDateTimeOriginal, kCGImagePropertyExifDateTimeDigitized, kCGImagePropertyExifOffsetTimeOriginal,
                kCGImagePropertyExifSubsecTimeOriginal, kCGImagePropertyExifISOSpeedRatings, kCGImagePropertyExifExposureTime,
                kCGImagePropertyExifFNumber, kCGImagePropertyExifApertureValue, kCGImagePropertyExifShutterSpeedValue,
                kCGImagePropertyExifBrightnessValue, kCGImagePropertyExifExposureBiasValue, kCGImagePropertyExifExposureProgram,
                kCGImagePropertyExifMeteringMode, kCGImagePropertyExifFlash, kCGImagePropertyExifWhiteBalance,
                kCGImagePropertyExifFocalLength, kCGImagePropertyExifFocalLenIn35mmFilm, kCGImagePropertyExifLensMake,
                kCGImagePropertyExifLensModel, kCGImagePropertyExifLensSpecification,
            ]
            var e: [CFString: Any] = [:]
            for k in keep { if let v = exif[k] { e[k] = v } }
            if !e.isEmpty { out[kCGImagePropertyExifDictionary] = e }
        }
        var tiff: [CFString: Any] = [:]
        if let t = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            for k in [kCGImagePropertyTIFFMake, kCGImagePropertyTIFFModel, kCGImagePropertyTIFFDateTime] { if let v = t[k] { tiff[k] = v } }
        }
        tiff[kCGImagePropertyTIFFSoftware] = "Technichrome"
        out[kCGImagePropertyTIFFDictionary] = tiff
        return out
    }
}
