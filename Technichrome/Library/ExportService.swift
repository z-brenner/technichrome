//
//  ExportService.swift
//  Technichrome
//
//  Saving to the Photos library. The developed JPEG is always its own asset so that Photos shows the
//  Technichrome print; the original DNG can be added as a second asset (Photos then shows a RAW badge).
//

import Foundation
import Photos
import UIKit

enum ExportError: Error, LocalizedError {
    case notAuthorized
    case missingDevelopedImage
    var errorDescription: String? {
        switch self {
        case .notAuthorized: return "Technichrome needs permission to add photos to your library."
        case .missingDevelopedImage: return "This photograph has not been developed yet."
        }
    }
}

enum ExportService {
    @MainActor
    static func saveToPhotos(record: PhotoRecord, store: PhotoStore, includeRAW: Bool) async throws {
        let developed = store.developedURL(for: record)
        guard FileManager.default.fileExists(atPath: developed.path) else { throw ExportError.missingDevelopedImage }
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw ExportError.notAuthorized }
        let rawURL = store.originalURL(for: record)
        let addRAW = includeRAW && record.hasRAW && FileManager.default.fileExists(atPath: rawURL.path)
        try await PHPhotoLibrary.shared().performChanges {
            let print = PHAssetCreationRequest.forAsset()
            let opts = PHAssetResourceCreationOptions()
            opts.originalFilename = "Technichrome-\(record.id.uuidString.prefix(8)).jpg"
            print.addResource(with: .photo, fileURL: developed, options: opts)
            print.creationDate = record.capturedAt
            if addRAW {
                let raw = PHAssetCreationRequest.forAsset()
                let ropts = PHAssetResourceCreationOptions()
                ropts.originalFilename = "Technichrome-\(record.id.uuidString.prefix(8)).dng"
                raw.addResource(with: .photo, fileURL: rawURL, options: ropts)
                raw.creationDate = record.capturedAt
            }
        }
    }
}
