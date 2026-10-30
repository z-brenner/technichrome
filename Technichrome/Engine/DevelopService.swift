//
//  DevelopService.swift
//  Technichrome
//
//  Develops a stored photograph: RAW → scene-linear → Technichrome print → JPEG (Display P3) +
//  thumbnail. Also renders quick previews for the develop animation and the Laboratory.
//

import Foundation
import CoreImage
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
            var opts = RAWDeveloper.Options()
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

        try Self.writeJPEG(full, to: store.developedURL(for: record), quality: 0.95)

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

    /// Writes a CGImage (which carries its Display P3 colour space) as a JPEG with ImageIO.
    static func writeJPEG(_ image: CGImage, to url: URL, quality: Double) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw DevelopError.writeFailed(url)
        }
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw DevelopError.writeFailed(url) }
    }
}
