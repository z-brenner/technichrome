//
//  PhotoImporter.swift
//  Technichrome
//
//  Brings an existing file into the library untouched — a DNG from Files or Photos, or any image — and
//  labels it honestly: the DNG's own tags say whether it holds sensor (Bayer) data or data that was
//  already demosaiced (Apple ProRAW, a linear DNG export). The record is created undeveloped; the develop
//  screen then treats it exactly like a capture.
//

import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum ImportError: Error, LocalizedError {
    case notAnImage
    public var errorDescription: String? { "That file is not an image Technichrome can develop." }
}

/// What is learned about an imported file before it is written to the library.
struct ImportedFile: Sendable {
    var fileName: String
    var rawKind: RAWKind
    var pixelWidth: Int
    var pixelHeight: Int
    var cameraModel: String?
    var iso: Float?
    var exposureDuration: Double?
    var capturedAt: Date?

    init(data: Data) throws {
        if let dng = DNGInspector.inspect(data), dng.isDNG || dng.kind == .cfa || dng.kind == .linearRaw {
            fileName = "original.dng"
            switch dng.kind {
            case .cfa:
                rawKind = .bayer
            case .linearRaw:
                let maker = [dng.make, dng.uniqueCameraModel].compactMap { $0 }.joined(separator: " ")
                rawKind = maker.localizedCaseInsensitiveContains("Apple") ? .proRAW : .linearDNG
            default:
                rawKind = .linearDNG
            }
            pixelWidth = dng.width ?? 0
            pixelHeight = dng.height ?? 0
            cameraModel = dng.uniqueCameraModel ?? dng.model
        } else {
            fileName = "original.heic"      // replaced below from the container's actual type
            rawKind = .none
            pixelWidth = 0
            pixelHeight = 0
            cameraModel = nil
        }

        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
            // ImageIO cannot open it. A DNG still goes through CIRAWFilter at develop time; anything else is not an image.
            if rawKind == .none { throw ImportError.notAnImage }
            return
        }
        if rawKind == .none, let type = CGImageSourceGetType(source) as String?, let ext = UTType(type)?.preferredFilenameExtension {
            fileName = "original.\(ext)"
        }
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        if pixelWidth == 0, let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int {
            pixelWidth = w
            pixelHeight = h
        }
        let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
        if let ratings = exif[kCGImagePropertyExifISOSpeedRatings] as? [NSNumber], let v = ratings.first { iso = v.floatValue }
        if let t = exif[kCGImagePropertyExifExposureTime] as? NSNumber { exposureDuration = t.doubleValue }
        if cameraModel == nil {
            cameraModel = (exif[kCGImagePropertyExifLensModel] as? String) ?? (tiff[kCGImagePropertyTIFFModel] as? String)
        }
        if let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
            capturedAt = Self.exifDate(s, offset: exif[kCGImagePropertyExifOffsetTimeOriginal] as? String)
        }
    }

    /// EXIF "yyyy:MM:dd HH:mm:ss" with its OffsetTimeOriginal ("+02:00") when the file carries one; the
    /// current time zone is only a fallback for files that do not.
    static func exifDate(_ s: String, offset: String? = nil) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        f.timeZone = offset.flatMap(Self.timeZone(fromEXIFOffset:)) ?? TimeZone.current
        return f.date(from: s)
    }

    /// "+HH:MM" / "-HH:MM" (EXIF 2.31 OffsetTime) → a fixed-offset time zone.
    static func timeZone(fromEXIFOffset s: String) -> TimeZone? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count == 6, let sign = t.first, sign == "+" || sign == "-" else { return nil }
        let parts = t.dropFirst().split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0...14).contains(h), (0...59).contains(m) else { return nil }
        let seconds = (h * 3600 + m * 60) * (sign == "-" ? -1 : 1)
        return TimeZone(secondsFromGMT: seconds)
    }
}
