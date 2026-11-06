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

    /// Long edge of the quick decodes (the develop reveal, the Laboratory), in pixels. A cap on top of the
    /// quarter scale: a 12 MP original decodes at a quarter as before, a 48 MP one no longer at 2016 px.
    public static let quickLongEdge: CGFloat = 1024

    /// The scene-linear source for a record: RAW through the linear decoder, or a HEIF linearised by Core Image.
    /// `maxLongEdge` lowers the scale further for large originals.
    public func linearSource(for record: PhotoRecord, store: PhotoStore, scaleFactor: Float = 1.0, draft: Bool = false,
                             maxLongEdge: CGFloat? = nil) throws -> (CIImage, Double) {
        let url = store.originalURL(for: record)
        if record.hasRAW {
            var opts = RAWDeveloper.Options.adaptive(iso: record.iso)
            opts.scaleFactor = scaleFactor
            opts.draftMode = draft
            let dev = try RAWDeveloper(url: url, options: opts)
            let native = max(dev.info.nativeSize.width, dev.info.nativeSize.height)
            if let maxLongEdge, native > 0 { dev.filter.scaleFactor = min(scaleFactor, Float(maxLongEdge / native)) }
            guard let img = dev.linearImage else { throw RAWDeveloperError.unsupportedRAW }
            return (img, dev.info.baselineExposure)
        } else {
            guard var img = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { throw RAWDeveloperError.unsupportedRAW }
            var scale = CGFloat(scaleFactor)
            let native = max(img.extent.width, img.extent.height)
            if let maxLongEdge, native > 0 { scale = min(scale, maxLongEdge / native) }
            if scale < 1 {
                img = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
            return (img, 0)
        }
    }

    /// The quick decode the develop reveal and the Laboratory work from: a quarter scale (at most
    /// `quickLongEdge`), draft mode, rendered once into a buffer. A CIImage from CIRAWFilter is a recipe, so
    /// demosaic, noise reduction and lens correction would otherwise run again on every render of it: five
    /// times in the reveal, once per slider movement in the Laboratory.
    public func quickSource(for record: PhotoRecord, store: PhotoStore) throws -> (CIImage, Double) {
        let (linear, baseline) = try linearSource(for: record, store: store, scaleFactor: 0.25, draft: true, maxLongEdge: Self.quickLongEdge)
        return (materialize(linear), baseline)
    }

    /// Renders an image once into a half-float RGBA buffer in the working space and returns an image backed by
    /// that buffer, at the same extent. RGBAh is the context's own working format, so values above 1 and below 0
    /// survive as they do between kernels (WWDC21 10160 renders ProRAW's linear output the same way).
    public func materialize(_ image: CIImage) -> CIImage {
        let r = image.extent.integral
        guard !r.isInfinite, r.width > 0, r.height > 0 else { return image }
        let width = Int(r.width), height = Int(r.height)
        let rowBytes = width * 8                       // four half floats per pixel
        var data = Data(count: rowBytes * height)
        data.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            context.render(image, toBitmap: base, rowBytes: rowBytes, bounds: r, format: .RGBAh,
                           colorSpace: TechnichromeEngine.workingColorSpace)
        }
        return CIImage(bitmapData: data, bytesPerRow: rowBytes, size: r.size, format: .RGBAh,
                       colorSpace: TechnichromeEngine.workingColorSpace)
            .transformed(by: CGAffineTransform(translationX: r.minX, y: r.minY))
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

    /// The print timing of `p` on a photograph. The stored value was measured at develop time with that time's
    /// parameters: it is kept while the parameters the timing depends on (print exposure, timing strength,
    /// target and limit) are unchanged, and measured again on `linear` (the quick decode, as at develop time)
    /// when they are not, so a look tuned in the Laboratory, its re-develop and its record agree.
    public func printTiming(for record: PhotoRecord, parameters p: EngineParameters, linear: CIImage, baselineEV: Double) -> Double {
        if let q = record.parameters, q.exposureEV == p.exposureEV, q.timingStrength == p.timingStrength,
           q.timingTarget == p.timingTarget, q.timingLimit == p.timingLimit {
            return record.printTimingEV
        }
        return measureTiming(linear: linear, baselineEV: baselineEV, parameters: p, cameraBiasEV: Double(record.exposureBias))
    }

    public func render(_ image: CIImage) -> CGImage? {
        context.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: TechnichromeEngine.outputColorSpace)
    }

    /// Full-resolution develop, written to disk. The graph is evaluated exactly once and streamed to the
    /// JPEG in tiles, so a 48 MP print never exists in memory as a whole; the thumbnail and the display
    /// image are then decoded from the file at reduced size by ImageIO.
    @discardableResult
    public func developToDisk(record: PhotoRecord, store: PhotoStore, parameters: EngineParameters, extraEV: Double) throws -> DevelopedImage {
        let (linear, baseline) = try linearSource(for: record, store: store)
        let longEdge = Double(max(linear.extent.width, linear.extent.height))
        let provenance = Self.printMetadata(from: store.originalURL(for: record))
        let print = makePrint(linear: linear, baselineEV: baseline, parameters: parameters, extraEV: extraEV, fullLongEdge: longEdge)
            .settingProperties(provenance as [AnyHashable: Any])

        let developedURL = store.developedURL(for: record)
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        do {
            try context.writeJPEGRepresentation(of: print, to: developedURL, colorSpace: TechnichromeEngine.outputColorSpace,
                                                options: [quality: 0.95])
        } catch {
            throw DevelopError.writeFailed(developedURL)
        }

        guard let thumb = Self.decodeDownscaled(developedURL, maxPixelSize: 600),
              let display = Self.decodeDownscaled(developedURL, maxPixelSize: 1500) else {
            throw DevelopError.renderFailed
        }
        try Self.writeJPEG(thumb, to: store.thumbnailURL(for: record), quality: 0.85)
        return DevelopedImage(image: display, baselineExposure: baseline)
    }

    /// Decodes a JPEG at reduced size (ImageIO scales during decoding, so the full image is never unpacked).
    static func decodeDownscaled(_ url: URL, maxPixelSize: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
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
