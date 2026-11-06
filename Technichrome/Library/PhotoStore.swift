//
//  PhotoStore.swift
//  Technichrome
//
//  Local, on-device library. One folder per photograph:
//    original.dng  (or original.heic when no RAW was available)  — preserved untouched
//    apple.heic    Apple's own rendering, if captured alongside (comparison only)
//    developed.jpg the Technichrome print (Display P3)
//    thumb.jpg     gallery thumbnail
//    record.json   metadata + the engine parameters the print was developed with
//

import Foundation
import Observation
import UIKit

public struct PhotoRecord: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var capturedAt: Date
    public var rawKind: RAWKind
    public var lens: Lens
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var cameraModel: String?
    public var iso: Float?
    public var exposureDuration: Double?
    public var exposureBias: Float
    /// DNG BaselineExposure read at develop time (0 if absent).
    public var baselineExposure: Double
    /// Extra exposure (stops) chosen for this print on top of the engine's default.
    public var printExposureEV: Double
    /// Print timing measured at develop time (stops), see PrintTiming.swift.
    public var printTimingEV: Double
    /// The parameters the print was developed with (nil = app default at the time).
    public var parameters: EngineParameters?
    public var isDeveloped: Bool
    /// File name of the original inside the photograph's folder when it is not the default (imports keep
    /// their container type: original.jpg, original.tiff, …).
    public var originalFile: String?
    /// The CIRAWFilter decoder version the print was developed with (nil before the first develop, and for
    /// display-referred originals). A re-develop asks for the same one, so an iOS update does not change it.
    public var decoderVersion: String?
    /// Whether CIRAWFilter's highlight recovery was on for the print (nil: the decoder's default, where the app
    /// cannot set it).
    public var highlightRecovery: Bool?

    public var originalFileName: String { originalFile ?? (rawKind == .none ? "original.heic" : "original.dng") }
    public var hasRAW: Bool { rawKind != .none }
    /// Total per-print exposure offset applied on top of the engine parameters.
    public var totalPrintEV: Double { printExposureEV + printTimingEV }

    public init(id: UUID, capturedAt: Date, rawKind: RAWKind, lens: Lens, pixelWidth: Int, pixelHeight: Int, cameraModel: String?,
                iso: Float?, exposureDuration: Double?, exposureBias: Float, baselineExposure: Double, printExposureEV: Double,
                printTimingEV: Double = 0, parameters: EngineParameters?, isDeveloped: Bool, originalFile: String? = nil) {
        self.id = id; self.capturedAt = capturedAt; self.rawKind = rawKind; self.lens = lens
        self.pixelWidth = pixelWidth; self.pixelHeight = pixelHeight; self.cameraModel = cameraModel
        self.iso = iso; self.exposureDuration = exposureDuration; self.exposureBias = exposureBias
        self.baselineExposure = baselineExposure; self.printExposureEV = printExposureEV; self.printTimingEV = printTimingEV
        self.parameters = parameters; self.isDeveloped = isDeveloped; self.originalFile = originalFile
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        capturedAt = try c.decode(Date.self, forKey: .capturedAt)
        rawKind = try c.decodeIfPresent(RAWKind.self, forKey: .rawKind) ?? .none
        lens = try c.decodeIfPresent(Lens.self, forKey: .lens) ?? .wide
        pixelWidth = try c.decodeIfPresent(Int.self, forKey: .pixelWidth) ?? 0
        pixelHeight = try c.decodeIfPresent(Int.self, forKey: .pixelHeight) ?? 0
        cameraModel = try c.decodeIfPresent(String.self, forKey: .cameraModel)
        iso = try c.decodeIfPresent(Float.self, forKey: .iso)
        exposureDuration = try c.decodeIfPresent(Double.self, forKey: .exposureDuration)
        exposureBias = try c.decodeIfPresent(Float.self, forKey: .exposureBias) ?? 0
        baselineExposure = try c.decodeIfPresent(Double.self, forKey: .baselineExposure) ?? 0
        printExposureEV = try c.decodeIfPresent(Double.self, forKey: .printExposureEV) ?? 0
        printTimingEV = try c.decodeIfPresent(Double.self, forKey: .printTimingEV) ?? 0
        parameters = try c.decodeIfPresent(EngineParameters.self, forKey: .parameters)
        isDeveloped = try c.decodeIfPresent(Bool.self, forKey: .isDeveloped) ?? false
        originalFile = try c.decodeIfPresent(String.self, forKey: .originalFile)
        decoderVersion = try c.decodeIfPresent(String.self, forKey: .decoderVersion)
        highlightRecovery = try c.decodeIfPresent(Bool.self, forKey: .highlightRecovery)
    }
}

@MainActor
@Observable
public final class PhotoStore {
    public private(set) var records: [PhotoRecord] = []
    /// Whether the library on disk has been read (see `init`); until then `records` holds only what was added.
    public private(set) var isLoaded = false
    public nonisolated let root: URL

    public init(root: URL? = nil) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let root = root ?? docs.appendingPathComponent("Photos", isDirectory: true)
        self.root = root
        // The library is read once, off the main thread. It used to be read on the main thread at launch (in
        // AppModel.init) and again on every gallery appearance, a cost that grew with the number of photographs.
        // The store is the only writer afterwards, so it stays current without reading again.
        Task { [weak self] in
            let loaded = await Task.detached(priority: .userInitiated) { PhotoStore.loadRecords(root: root) }.value
            self?.merge(loaded)
        }
    }

    public nonisolated func folder(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    public nonisolated func originalURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent(r.originalFileName) }
    public nonisolated func appleURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent("apple.heic") }
    public nonisolated func developedURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent("developed.jpg") }
    public nonisolated func thumbnailURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent("thumb.jpg") }
    private nonisolated func recordURL(for id: UUID) -> URL { folder(for: id).appendingPathComponent("record.json") }

    /// Every record under `root`, newest first. Runs off the main thread.
    nonisolated static func loadRecords(root: URL) -> [PhotoRecord] {
        let fm = FileManager.default
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        var found: [PhotoRecord] = []
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        for d in dirs {
            let url = d.appendingPathComponent("record.json")
            if let data = try? Data(contentsOf: url), let r = try? dec.decode(PhotoRecord.self, from: data) {
                found.append(r)
            }
        }
        return found.sorted { $0.capturedAt > $1.capturedAt }
    }

    /// Adds the records read from disk after those added since launch, which are the newest and stay first.
    private func merge(_ loaded: [PhotoRecord]) {
        let known = Set(records.map(\.id))
        records += loaded.filter { !known.contains($0.id) }
        isLoaded = true
    }

    /// Persists a capture: writes the original (DNG or HEIF) and the optional Apple companion off the
    /// main actor (a DNG is tens of megabytes), then registers the record.
    @discardableResult
    public func add(capture: CaptureResult) async throws -> PhotoRecord {
        let id = UUID()
        let dir = folder(for: id)
        var record = PhotoRecord(id: id, capturedAt: capture.capturedAt, rawKind: capture.rawKind, lens: capture.lens,
                                 pixelWidth: capture.pixelWidth, pixelHeight: capture.pixelHeight, cameraModel: capture.lensModel,
                                 iso: capture.iso, exposureDuration: capture.exposureDuration, exposureBias: capture.exposureBias,
                                 baselineExposure: 0, printExposureEV: 0, parameters: nil, isDeveloped: false)
        if capture.rawData == nil { record.rawKind = .none }
        guard capture.rawData != nil || capture.processedData != nil else { throw CameraError.captureFailed("nothing to save") }
        try await Task.detached(priority: .userInitiated) {
            try Self.writeCaptureFiles(capture, to: dir)
        }.value
        try save(record)
        records.insert(record, at: 0)
        return record
    }

    /// Adds an existing file (a DNG from Files or Photos, or any image) to the library, untouched, and
    /// returns its undeveloped record. The file's own tags decide how it is labelled (see PhotoImporter.swift).
    @discardableResult
    public func add(importedData data: Data) async throws -> PhotoRecord {
        let info = try await Task.detached(priority: .userInitiated) { try ImportedFile(data: data) }.value
        let id = UUID()
        let dir = folder(for: id)
        let fileName = info.fileName
        try await Task.detached(priority: .userInitiated) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: dir.appendingPathComponent(fileName), options: .atomic)
        }.value
        return try register(info, id: id)
    }

    /// Adds a file chosen in Files without reading it into memory: it is mapped for the tag inspection (which
    /// reads only the header and the tags) and copied by the file system. A 48 MP ProRAW is up to about 100 MB,
    /// which was read whole, inspected and written out again.
    @discardableResult
    public func add(importedFileAt url: URL) async throws -> PhotoRecord {
        let id = UUID()
        let dir = folder(for: id)
        let info = try await Task.detached(priority: .userInitiated) { () throws -> ImportedFile in
            let secured = url.startAccessingSecurityScopedResource()
            defer { if secured { url.stopAccessingSecurityScopedResource() } }
            let info = try ImportedFile(data: Data(contentsOf: url, options: .mappedIfSafe))
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: url, to: dir.appendingPathComponent(info.fileName))
            } catch {
                try? FileManager.default.removeItem(at: dir)     // no half-imported folder
                throw error
            }
            return info
        }.value
        return try register(info, id: id)
    }

    /// The undeveloped record of an imported file, saved and listed first.
    private func register(_ info: ImportedFile, id: UUID) throws -> PhotoRecord {
        let record = PhotoRecord(id: id, capturedAt: info.capturedAt ?? Date(), rawKind: info.rawKind, lens: .wide,
                                 pixelWidth: info.pixelWidth, pixelHeight: info.pixelHeight, cameraModel: info.cameraModel,
                                 iso: info.iso, exposureDuration: info.exposureDuration, exposureBias: 0, baselineExposure: 0,
                                 printExposureEV: 0, parameters: nil, isDeveloped: false, originalFile: info.fileName)
        try save(record)
        records.insert(record, at: 0)
        return record
    }

    private nonisolated static func writeCaptureFiles(_ capture: CaptureResult, to dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let raw = capture.rawData {
            try raw.write(to: dir.appendingPathComponent("original.dng"), options: .atomic)
            if let heif = capture.processedData {
                try heif.write(to: dir.appendingPathComponent("apple.heic"), options: .atomic)
            }
        } else if let heif = capture.processedData {
            try heif.write(to: dir.appendingPathComponent("original.heic"), options: .atomic)
        }
    }

    public func save(_ record: PhotoRecord) throws {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(record).write(to: recordURL(for: record.id), options: .atomic)
        if let i = records.firstIndex(where: { $0.id == record.id }) { records[i] = record }
    }

    public func delete(_ record: PhotoRecord) {
        try? FileManager.default.removeItem(at: folder(for: record.id))
        records.removeAll { $0.id == record.id }
    }

    public func record(id: UUID) -> PhotoRecord? { records.first { $0.id == id } }
}
