//
//  DevelopEndToEndTests.swift
//  TechnichromeTests
//
//  The app's own develop path, end to end, on the two synthetic Bayer DNGs the web smoke test uses
//  (tools/colorscience/make_test_dng.py; copies in Fixtures/): the import and its labelling, Apple's linear
//  RAW decode, the quick decode and its materialised buffer, the print timing, the full-resolution develop to
//  disk, the print's size, profile and provenance, the thumbnail, and the pinned decoder version. Nothing of
//  this ran anywhere before (the GPU parity tests start from known scene-linear values). Runs on the simulator.
//

import XCTest
import CoreImage
import ImageIO
@testable import Technichrome

final class DevelopEndToEndTests: XCTestCase {

    @MainActor
    func testSyntheticLandscapeDNGDevelopsEndToEnd() async throws {
        try await developAndCheck("synthetic-a", width: 320, height: 240, model: "Synthetic Bayer A", baselineEV: 0)
    }

    @MainActor
    func testSyntheticPortraitDNGWithBaselineExposureDevelopsEndToEnd() async throws {
        try await developAndCheck("synthetic-b", width: 240, height: 320, model: "Synthetic Bayer B", baselineEV: -0.5)
    }

    // MARK: - The path

    @MainActor
    private func developAndCheck(_ name: String, width: Int, height: Int, model: String, baselineEV: Double) async throws {
        let bundle = Bundle(for: DevelopEndToEndTests.self)
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "dng")
                                ?? bundle.url(forResource: name, withExtension: "dng", subdirectory: "Fixtures"),
                                "\(name).dng is missing from the test bundle")
        // Apple's decoder has to accept the synthetic file at all; if it does not, nothing below says anything
        // about the app, so the test is skipped with that finding rather than failed.
        guard let probe = CIRAWFilter(imageURL: url), probe.outputImage != nil else {
            throw XCTSkip("CIRAWFilter on this simulator does not decode \(name).dng (a synthetic DNG's missing tags?)")
        }

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("e2e-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = PhotoStore(root: root)

        // Import: labelled from the file's own tags, stored untouched.
        let record = try await store.add(importedFileAt: url)
        XCTAssertEqual(record.rawKind, .bayer)
        XCTAssertEqual(record.pixelWidth, width)
        XCTAssertEqual(record.pixelHeight, height)
        XCTAssertEqual(record.cameraModel, model)
        XCTAssertEqual(try Data(contentsOf: store.originalURL(for: record)), try Data(contentsOf: url))

        let engine = try TechnichromeEngine(lutDimension: 17)
        let dev = DevelopService(engine: engine)
        let params = EngineParameters.default

        // The quick decode: finite, the DNG's baseline exposure read before the decoder's is zeroed, and the
        // materialised buffer printing like the decoder's own recipe.
        let (recipe, recipeBaseline) = try dev.linearSource(for: record, store: store, scaleFactor: 0.25, draft: true,
                                                            maxLongEdge: DevelopService.quickLongEdge)
        let (quick, baseline) = try dev.quickSource(for: record, store: store)
        XCTAssertEqual(baseline, recipeBaseline)
        XCTAssertEqual(baseline, baselineEV, accuracy: 0.01, "BaselineExposure as CIRAWFilter reports it")
        XCTAssertEqual(quick.extent.size, recipe.extent.integral.size)
        let linear = readPixels(quick, context: dev.context)
        XCTAssertFalse(linear.isEmpty)
        XCTAssertTrue(linear.allSatisfy { $0.isFinite }, "the materialised decode holds a non-finite value")

        let timing = dev.measureTiming(linear: quick, baselineEV: baseline, parameters: params)
        XCTAssertTrue(timing.isFinite)
        XCTAssertLessThanOrEqual(abs(timing), params.timingLimit + 1e-9)

        let longEdge = Double(max(quick.extent.width, quick.extent.height))
        let fromBuffer = readPixels(dev.makePrint(linear: quick, baselineEV: baseline, parameters: params, extraEV: timing,
                                                  fullLongEdge: longEdge, spatial: false), context: dev.context)
        let fromRecipe = readPixels(dev.makePrint(linear: recipe, baselineEV: baseline, parameters: params, extraEV: timing,
                                                  fullLongEdge: longEdge, spatial: false), context: dev.context)
        XCTAssertEqual(fromBuffer.count, fromRecipe.count)
        var sum = 0.0, worst = 0.0
        for (a, b) in zip(fromBuffer, fromRecipe) {
            let d = Double(abs(a - b))
            sum += d
            worst = max(worst, d)
        }
        let mean = sum / Double(max(fromBuffer.count, 1))
        print("\(name): materialised vs recipe print, mean \(mean), worst \(worst)")
        XCTAssertLessThan(mean, 1e-3)
        XCTAssertLessThan(worst, 2e-2)

        // The Laboratory's timing rule: the stored timing while the timing parameters are those of the develop,
        // measured again when they change.
        var developedRecord = record
        developedRecord.printTimingEV = timing
        developedRecord.parameters = params
        XCTAssertEqual(dev.printTiming(for: developedRecord, parameters: params, linear: quick, baselineEV: baseline), timing)
        var untimed = params
        untimed.timingStrength = 0
        XCTAssertEqual(dev.printTiming(for: developedRecord, parameters: untimed, linear: quick, baselineEV: baseline), 0)

        // The full-resolution develop, written to disk.
        var timed = record
        timed.printTimingEV = timing
        let result = try dev.developToDisk(record: timed, store: store, parameters: params, extraEV: timed.totalPrintEV)
        let version = try XCTUnwrap(result.decoderVersion, "the decoder version is returned for the record")
        XCTAssertFalse(version.isEmpty)
        print("\(name): CIRAWFilter decoder \(version), highlight recovery \(String(describing: result.highlightRecovery))")
        XCTAssertLessThanOrEqual(max(result.image.width, result.image.height), 1500)

        // The print: the decode's size and orientation, Display P3, the provenance tags, no location.
        let (full, _) = try dev.linearSource(for: timed, store: store)
        let printURL = store.developedURL(for: timed)
        let printSource = try XCTUnwrap(CGImageSourceCreateWithURL(printURL as CFURL, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(printSource, 0, nil) as? [CFString: Any])
        let printWidth = try XCTUnwrap(props[kCGImagePropertyPixelWidth] as? Int)
        let printHeight = try XCTUnwrap(props[kCGImagePropertyPixelHeight] as? Int)
        XCTAssertEqual(printWidth, Int(full.extent.width))
        XCTAssertEqual(printHeight, Int(full.extent.height))
        XCTAssertEqual(printWidth > printHeight, width > height, "the print keeps the original's orientation")
        XCTAssertLessThanOrEqual(abs(printWidth - width), 8, "the decoder crops at most a few pixels")
        XCTAssertLessThanOrEqual(abs(printHeight - height), 8)
        XCTAssertEqual((props[kCGImagePropertyOrientation] as? Int) ?? 1, 1, "the print is upright, no orientation tag")
        XCTAssertNil(props[kCGImagePropertyGPSDictionary], "no location in the print")
        let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        XCTAssertEqual(tiff?[kCGImagePropertyTIFFSoftware] as? String, "Technichrome")
        XCTAssertEqual(tiff?[kCGImagePropertyTIFFModel] as? String, model, "the camera model is carried over")
        let printImage = try XCTUnwrap(CGImageSourceCreateImageAtIndex(printSource, 0, nil))
        let profile = props[kCGImagePropertyProfileName] as? String
        let spaceName = printImage.colorSpace?.name as String?
        XCTAssertTrue(spaceName == (CGColorSpace.displayP3 as String) || (profile?.contains("P3") ?? false),
                      "the print is Display P3 (profile \(profile ?? "none"), colour space \(spaceName ?? "none"))")

        // The gallery thumbnail.
        let thumbSource = try XCTUnwrap(CGImageSourceCreateWithURL(store.thumbnailURL(for: timed) as CFURL, nil))
        let thumbProps = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(thumbSource, 0, nil) as? [CFString: Any])
        let thumbEdge = max(thumbProps[kCGImagePropertyPixelWidth] as? Int ?? .max, thumbProps[kCGImagePropertyPixelHeight] as? Int ?? .max)
        XCTAssertLessThanOrEqual(thumbEdge, 600)

        // A re-develop with the recorded decoder version gives the same print.
        let firstPixels = try decodedBytes(printURL)
        var pinned = timed
        pinned.decoderVersion = version
        let again = try dev.developToDisk(record: pinned, store: store, parameters: params, extraEV: pinned.totalPrintEV)
        XCTAssertEqual(again.decoderVersion, version)
        let secondPixels = try decodedBytes(printURL)
        XCTAssertEqual(firstPixels.count, secondPixels.count)
        var largest = 0
        for (a, b) in zip(firstPixels, secondPixels) { largest = max(largest, abs(Int(a) - Int(b))) }
        XCTAssertLessThanOrEqual(largest, 1, "a re-develop with the pinned decoder differs by \(largest) codes")
    }

    // MARK: - Helpers

    /// Every channel of every pixel, rendered in the working space as floats.
    private func readPixels(_ image: CIImage, context: CIContext) -> [Float] {
        let r = image.extent.integral
        let w = Int(r.width), h = Int(r.height)
        guard w > 0, h > 0 else { return [] }
        var out = [Float](repeating: .nan, count: w * h * 4)
        context.render(image, toBitmap: &out, rowBytes: w * 16, bounds: r, format: .RGBAf,
                       colorSpace: TechnichromeEngine.workingColorSpace)
        return out
    }

    /// The decoded bytes of a JPEG, as ImageIO delivers them.
    private func decodedBytes(_ url: URL) throws -> [UInt8] {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: true] as CFDictionary))
        let data = try XCTUnwrap(image.dataProvider?.data as Data?)
        return [UInt8](data)
    }
}
