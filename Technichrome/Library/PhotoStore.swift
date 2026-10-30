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
    /// The parameters the print was developed with (nil = app default at the time).
    public var parameters: EngineParameters?
    public var isDeveloped: Bool

    public var originalFileName: String { rawKind == .none ? "original.heic" : "original.dng" }
    public var hasRAW: Bool { rawKind != .none }
}

@MainActor
@Observable
public final class PhotoStore {
    public private(set) var records: [PhotoRecord] = []
    public nonisolated let root: URL

    public init(root: URL? = nil) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.root = root ?? docs.appendingPathComponent("Photos", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        reload()
    }

    public nonisolated func folder(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    public nonisolated func originalURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent(r.originalFileName) }
    public nonisolated func appleURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent("apple.heic") }
    public nonisolated func developedURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent("developed.jpg") }
    public nonisolated func thumbnailURL(for r: PhotoRecord) -> URL { folder(for: r.id).appendingPathComponent("thumb.jpg") }
    private nonisolated func recordURL(for id: UUID) -> URL { folder(for: id).appendingPathComponent("record.json") }

    public func reload() {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { records = []; return }
        var found: [PhotoRecord] = []
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        for d in dirs {
            let url = d.appendingPathComponent("record.json")
            if let data = try? Data(contentsOf: url), let r = try? dec.decode(PhotoRecord.self, from: data) {
                found.append(r)
            }
        }
        records = found.sorted { $0.capturedAt > $1.capturedAt }
    }

    /// Persists a capture: writes the original (DNG or HEIF) and the optional Apple companion.
    @discardableResult
    public func add(capture: CaptureResult) throws -> PhotoRecord {
        let id = UUID()
        let dir = folder(for: id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var record = PhotoRecord(id: id, capturedAt: capture.capturedAt, rawKind: capture.rawKind, lens: capture.lens,
                                 pixelWidth: capture.pixelWidth, pixelHeight: capture.pixelHeight, cameraModel: capture.lensModel,
                                 iso: capture.iso, exposureDuration: capture.exposureDuration, exposureBias: capture.exposureBias,
                                 baselineExposure: 0, printExposureEV: 0, parameters: nil, isDeveloped: false)
        if let raw = capture.rawData {
            try raw.write(to: dir.appendingPathComponent("original.dng"), options: .atomic)
            if let heif = capture.processedData {
                try heif.write(to: dir.appendingPathComponent("apple.heic"), options: .atomic)
            }
        } else if let heif = capture.processedData {
            record.rawKind = .none
            try heif.write(to: dir.appendingPathComponent("original.heic"), options: .atomic)
        } else {
            throw CameraError.captureFailed("nothing to save")
        }
        try save(record)
        records.insert(record, at: 0)
        return record
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
