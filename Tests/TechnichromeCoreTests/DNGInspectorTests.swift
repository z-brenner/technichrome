import XCTest
@testable import TechnichromeCore

/// Builds minimal TIFF/DNG containers in memory so the inspector can be checked without real files.
private struct TIFFWriter {
    enum Field {
        case short(UInt16, UInt16)          // tag, value
        case long(UInt16, UInt32)
        case ascii(UInt16, String)
        case bytes(UInt16, [UInt8])
        case subIFDs(UInt16, [UInt32])      // offsets patched by the caller
    }
    var bigEndian = false
    var data = Data()

    init(bigEndian: Bool = false) {
        self.bigEndian = bigEndian
        data.append(contentsOf: bigEndian ? [0x4D, 0x4D] : [0x49, 0x49])
        put16(42)
        put32(8)    // IFD0 at offset 8
    }

    mutating func put16(_ v: UInt16) {
        data.append(contentsOf: bigEndian ? [UInt8(v >> 8), UInt8(v & 0xFF)] : [UInt8(v & 0xFF), UInt8(v >> 8)])
    }
    mutating func put32(_ v: UInt32) {
        let b = [UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
        data.append(contentsOf: bigEndian ? b : b.reversed())
    }

    /// Writes an IFD at the current end of the data and returns its offset. Out-of-line values are
    /// appended after the entry table. `next` is the next-IFD pointer.
    @discardableResult
    mutating func writeIFD(_ fields: [Field], next: UInt32 = 0) -> UInt32 {
        let start = UInt32(data.count)
        let sorted = fields   // tags are written in the given order; the inspector does not require sorting
        put16(UInt16(sorted.count))
        // Reserve the table, then fill it with values; out-of-line data goes after the next pointer.
        var tail = Data()
        let tailBase = Int(start) + 2 + 12 * sorted.count + 4
        for f in sorted {
            switch f {
            case .short(let tag, let v):
                put16(tag); put16(3); put32(1); put16(v); put16(0)
            case .long(let tag, let v):
                put16(tag); put16(4); put32(1); put32(v)
            case .ascii(let tag, let s):
                var bytes = Array(s.utf8); bytes.append(0)
                put16(tag); put16(2); put32(UInt32(bytes.count))
                if bytes.count <= 4 {
                    data.append(contentsOf: bytes + [UInt8](repeating: 0, count: 4 - bytes.count))
                } else {
                    put32(UInt32(tailBase + tail.count)); tail.append(contentsOf: bytes)
                }
            case .bytes(let tag, let b):
                put16(tag); put16(1); put32(UInt32(b.count))
                if b.count <= 4 {
                    data.append(contentsOf: b + [UInt8](repeating: 0, count: 4 - b.count))
                } else {
                    put32(UInt32(tailBase + tail.count)); tail.append(contentsOf: b)
                }
            case .subIFDs(let tag, let offsets):
                put16(tag); put16(4); put32(UInt32(offsets.count))
                if offsets.count == 1 {
                    put32(offsets[0])
                } else {
                    put32(UInt32(tailBase + tail.count))
                    for o in offsets {
                        let b = [UInt8(o >> 24), UInt8((o >> 16) & 0xFF), UInt8((o >> 8) & 0xFF), UInt8(o & 0xFF)]
                        tail.append(contentsOf: bigEndian ? b : b.reversed())
                    }
                }
            }
        }
        put32(next)
        data.append(tail)
        return start
    }
}

final class DNGInspectorTests: XCTestCase {
    func testProRAWStyleDNGWithThumbnailIFD0AndLinearSubIFD() {
        // IFD0 is an RGB thumbnail (NewSubfileType 1) carrying the camera tags; the main image is a SubIFD.
        var w = TIFFWriter()
        // IFD0 is at offset 8; its one SubIFD will be written right after it, so compute that offset first.
        let ifd0Fields: [TIFFWriter.Field] = [
            .long(254, 1), .long(256, 256), .long(257, 192), .short(262, 2),
            .ascii(271, "Apple"), .ascii(272, "iPhone 15 Pro"),
            .subIFDs(330, [0]),                              // patched below
            .bytes(50706, [1, 6, 0, 0]), .ascii(50708, "Apple iPhone 15 Pro back camera 6.765mm f/1.78"),
        ]
        let ifd0Size = 2 + 12 * ifd0Fields.count + 4 + ("Apple".utf8.count + 1) + ("iPhone 15 Pro".utf8.count + 1)
            + ("Apple iPhone 15 Pro back camera 6.765mm f/1.78".utf8.count + 1)
        let subOffset = UInt32(8 + ifd0Size)
        var patched = ifd0Fields
        patched[6] = .subIFDs(330, [subOffset])
        w.writeIFD(patched)
        XCTAssertEqual(UInt32(w.data.count), subOffset)
        w.writeIFD([.long(254, 0), .long(256, 8064), .long(257, 6048), .short(262, 34892)])

        let r = DNGInspector.inspect(w.data)
        XCTAssertNotNil(r)
        XCTAssertEqual(r?.kind, .linearRaw)
        XCTAssertTrue(r?.isDNG ?? false)
        XCTAssertEqual(r?.make, "Apple")
        XCTAssertEqual(r?.model, "iPhone 15 Pro")
        XCTAssertEqual(r?.uniqueCameraModel, "Apple iPhone 15 Pro back camera 6.765mm f/1.78")
        XCTAssertEqual(r?.width, 8064)
        XCTAssertEqual(r?.height, 6048)
    }

    func testBayerDNGInIFD0BigEndian() {
        var w = TIFFWriter(bigEndian: true)
        w.writeIFD([.long(254, 0), .long(256, 4032), .long(257, 3024), .short(262, 32803),
                    .ascii(271, "Apple"), .ascii(272, "iPhone 12"), .bytes(50706, [1, 4, 0, 0])])
        let r = DNGInspector.inspect(w.data)
        XCTAssertEqual(r?.kind, .cfa)
        XCTAssertTrue(r?.isDNG ?? false)
        XCTAssertEqual(r?.width, 4032)
        XCTAssertEqual(r?.model, "iPhone 12")
    }

    func testPlainTIFFIsNotADNG() {
        var w = TIFFWriter()
        w.writeIFD([.long(256, 10), .long(257, 10), .short(262, 2), .ascii(271, "Scanner")])
        let r = DNGInspector.inspect(w.data)
        XCTAssertEqual(r?.kind, .rgb)
        XCTAssertFalse(r?.isDNG ?? true)
    }

    func testGarbageAndTruncatedDataAreRejectedWithoutCrashing() {
        XCTAssertNil(DNGInspector.inspect(Data()))
        XCTAssertNil(DNGInspector.inspect(Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])))        // JPEG
        XCTAssertNil(DNGInspector.inspect(Data([0x49, 0x49, 0x2B, 0x00, 8, 0, 0, 0])))        // BigTIFF
        // A valid header pointing at an IFD that lies beyond the end of the data.
        var w = TIFFWriter()
        w.writeIFD([.long(254, 0), .short(262, 32803), .subIFDs(330, [100_000])])
        XCTAssertEqual(DNGInspector.inspect(w.data)?.kind, .cfa)                             // bad SubIFD ignored
        let truncated = w.data.prefix(20)
        XCTAssertNil(DNGInspector.inspect(truncated))
        // A slice with a non-zero start index must be read relative to its own start.
        var prefixed = Data([0, 0, 0])
        prefixed.append(w.data)
        XCTAssertEqual(DNGInspector.inspect(prefixed[3...])?.kind, .cfa)
    }
}
