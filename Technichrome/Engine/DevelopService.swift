//
//  DevelopService.swift
//  Technichrome
//
//  Develops a stored photograph: RAW → scene-linear → Technichrome print → JPEG (Display P3) +
//  thumbnail. Also renders quick previews for the develop animation and the Laboratory.
//

import Foundation
import CoreImage
import UIKit
import ImageIO
import UniformTypeIdentifiers

public struct DevelopedImage: Sendable {
    public let image: CGImage
    public let baselineExposure: Double
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

    /// Full-resolution develop, written to disk. Returns the developed CGImage (for display).
    @discardableResult
    public func developToDisk(record: PhotoRecord, store: PhotoStore, parameters: EngineParameters, extraEV: Double) async throws -> DevelopedImage {
        let (linear, baseline) = try linearSource(for: record, store: store)
        let longEdge = Double(max(linear.extent.width, linear.extent.height))
        let print = makePrint(linear: linear, baselineEV: baseline, parameters: parameters, extraEV: extraEV, fullLongEdge: longEdge)
        let developedURL = store.developedURL(for: record)
        let thumbURL = store.thumbnailURL(for: record)
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        try context.writeJPEGRepresentation(of: print, to: developedURL, colorSpace: TechnichromeEngine.outputColorSpace,
                                            options: [quality: 0.95])
        // Thumbnail (long edge 600 px)
        let ts = 600.0 / longEdge
        let thumb = print.transformed(by: CGAffineTransform(scaleX: ts, y: ts))
        try context.writeJPEGRepresentation(of: thumb, to: thumbURL, colorSpace: TechnichromeEngine.outputColorSpace,
                                            options: [quality: 0.85])
        guard let cg = render(thumb.transformed(by: CGAffineTransform(scaleX: 2.5, y: 2.5))) else {
            throw RAWDeveloperError.unsupportedRAW
        }
        return DevelopedImage(image: cg, baselineExposure: baseline)
    }
}
