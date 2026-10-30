//
//  DNGInspector.swift
//  Technichrome
//
//  Reads what a DNG (TIFF) container says about itself — colour-filter-array data or already
//  demosaiced linear data, make, model, dimensions — from the tags alone, without decoding a pixel.
//  Used to label imported files honestly: a DNG that stores demosaiced data (Apple ProRAW, a
//  Lightroom export) is a linear DNG, not Bayer RAW. Platform-independent; unit-tested on Linux.
//

import Foundation

public struct DNGInspection: Equatable, Sendable {
    /// PhotometricInterpretation of the main image (TIFF tag 262).
    public enum Kind: Equatable, Sendable {
        /// 32803: colour filter array — genuine sensor mosaic data (Bayer and the like).
        case cfa
        /// 34892: demosaiced, camera-space linear data (Apple ProRAW, "linear DNG" exports).
        case linearRaw
        /// 2: plain RGB (a TIFF, or a DNG whose main image is RGB).
        case rgb
        case other(UInt16)
    }
    public var kind: Kind
    /// True when the DNGVersion tag is present: the file claims to be a DNG, not a plain TIFF.
    public var isDNG: Bool
    public var make: String?
    public var model: String?
    public var uniqueCameraModel: String?
    public var width: Int?
    public var height: Int?

    public init(kind: Kind, isDNG: Bool, make: String? = nil, model: String? = nil, uniqueCameraModel: String? = nil,
                width: Int? = nil, height: Int? = nil) {
        self.kind = kind; self.isDNG = isDNG; self.make = make; self.model = model
        self.uniqueCameraModel = uniqueCameraModel; self.width = width; self.height = height
    }
}

public enum DNGInspector {
    // TIFF tags
    static let newSubfileType: UInt16 = 254
    static let imageWidth: UInt16 = 256
    static let imageLength: UInt16 = 257
    static let photometricInterpretation: UInt16 = 262
    static let make: UInt16 = 271
    static let model: UInt16 = 272
    static let subIFDs: UInt16 = 330
    static let dngVersion: UInt16 = 50706
    static let uniqueCameraModel: UInt16 = 50708

    /// Returns nil when the data is not a classic TIFF/DNG container (BigTIFF is not supported).
    public static func inspect(_ data: Data) -> DNGInspection? {
        guard let r = Reader(data) else { return nil }
        guard let ifd0 = r.readIFD(at: r.firstIFDOffset) else { return nil }

        // The main image is the IFD whose NewSubfileType is 0: often a SubIFD of a thumbnail IFD0 (DNG),
        // sometimes IFD0 itself. Bounded walk: IFD0, its SubIFDs, their SubIFDs, and the IFD chain.
        var candidates: [IFD] = [ifd0]
        for off in ifd0.subIFDOffsets.prefix(8) {
            if let sub = r.readIFD(at: off) {
                candidates.append(sub)
                for off2 in sub.subIFDOffsets.prefix(4) { if let sub2 = r.readIFD(at: off2) { candidates.append(sub2) } }
            }
        }
        var next = ifd0.nextIFDOffset, hops = 0
        while next != 0, hops < 4, let chained = r.readIFD(at: next) { candidates.append(chained); next = chained.nextIFDOffset; hops += 1 }

        let main = candidates.first { ($0.newSubfileType ?? 0) == 0 && $0.photometric != nil } ?? ifd0
        let kind: DNGInspection.Kind
        switch main.photometric {
        case 32803: kind = .cfa
        case 34892: kind = .linearRaw
        case 2: kind = .rgb
        case let v?: kind = .other(v)
        case nil: kind = .other(0)
        }
        return DNGInspection(kind: kind, isDNG: ifd0.hasDNGVersion, make: ifd0.make, model: ifd0.model,
                             uniqueCameraModel: ifd0.uniqueCameraModel, width: main.width, height: main.height)
    }

    struct IFD {
        var newSubfileType: Int?
        var photometric: UInt16?
        var width: Int?
        var height: Int?
        var make: String?
        var model: String?
        var uniqueCameraModel: String?
        var hasDNGVersion = false
        var subIFDOffsets: [Int] = []
        var nextIFDOffset = 0
    }

    struct Reader {
        let data: Data
        let base: Int
        let bigEndian: Bool
        let firstIFDOffset: Int

        init?(_ data: Data) {
            self.data = data
            base = data.startIndex
            guard data.count >= 8 else { return nil }
            let b0 = data[base], b1 = data[base + 1]
            if b0 == 0x49, b1 == 0x49 { bigEndian = false }          // "II"
            else if b0 == 0x4D, b1 == 0x4D { bigEndian = true }      // "MM"
            else { return nil }
            let magic = Reader.u16(data, base + 2, bigEndian)
            guard magic == 42 else { return nil }                    // 43 would be BigTIFF
            firstIFDOffset = Int(Reader.u32(data, base + 4, bigEndian))
            guard firstIFDOffset >= 8, firstIFDOffset < data.count else { return nil }
        }

        static func u16(_ d: Data, _ i: Int, _ be: Bool) -> UInt16 {
            let a = UInt16(d[i]), b = UInt16(d[i + 1])
            return be ? (a << 8 | b) : (b << 8 | a)
        }
        static func u32(_ d: Data, _ i: Int, _ be: Bool) -> UInt32 {
            let a = UInt32(d[i]), b = UInt32(d[i + 1]), c = UInt32(d[i + 2]), e = UInt32(d[i + 3])
            return be ? (a << 24 | b << 16 | c << 8 | e) : (e << 24 | c << 16 | b << 8 | a)
        }

        func has(_ offset: Int, _ length: Int) -> Bool { offset >= 0 && length >= 0 && offset + length <= data.count }
        func u16(at off: Int) -> UInt16? { has(off, 2) ? Reader.u16(data, base + off, bigEndian) : nil }
        func u32(at off: Int) -> UInt32? { has(off, 4) ? Reader.u32(data, base + off, bigEndian) : nil }

        /// Size in bytes of one element of a TIFF field type.
        static func elementSize(_ type: UInt16) -> Int? {
            switch type {
            case 1, 2, 6, 7: return 1       // BYTE, ASCII, SBYTE, UNDEFINED
            case 3, 8: return 2             // SHORT, SSHORT
            case 4, 9, 11, 13: return 4     // LONG, SLONG, FLOAT, IFD
            case 5, 10, 12: return 8        // RATIONAL, SRATIONAL, DOUBLE
            default: return nil
            }
        }

        /// Unsigned integer values of an entry (BYTE, SHORT, LONG, IFD), at most `limit` of them.
        func integers(entryAt e: Int, limit: Int = 16) -> [UInt32]? {
            guard let type = u16(at: e + 2), let count = u32(at: e + 4), let size = Reader.elementSize(type) else { return nil }
            guard type == 1 || type == 3 || type == 4 || type == 13 else { return nil }
            let n = min(Int(count), limit)
            let total = size * Int(count)
            let start = total <= 4 ? e + 8 : Int(u32(at: e + 8) ?? UInt32.max)
            guard has(start, size * n) else { return nil }
            return (0..<n).map { i in
                switch size {
                case 1: return UInt32(data[base + start + i])
                case 2: return UInt32(Reader.u16(data, base + start + 2 * i, bigEndian))
                default: return Reader.u32(data, base + start + 4 * i, bigEndian)
                }
            }
        }

        /// ASCII value of an entry, trimmed of its NUL terminator and surrounding whitespace.
        func string(entryAt e: Int) -> String? {
            guard let type = u16(at: e + 2), type == 2, let count = u32(at: e + 4), count > 0, count < 4096 else { return nil }
            let n = Int(count)
            let start = n <= 4 ? e + 8 : Int(u32(at: e + 8) ?? UInt32.max)
            guard has(start, n) else { return nil }
            let bytes = data[(base + start)..<(base + start + n)]
            let s = String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return s.isEmpty ? nil : s
        }

        func readIFD(at offset: Int) -> IFD? {
            guard let count = u16(at: offset), count > 0, count < 4096, has(offset + 2, 12 * Int(count) + 4) else { return nil }
            var ifd = IFD()
            for i in 0..<Int(count) {
                let e = offset + 2 + 12 * i
                guard let tag = u16(at: e) else { return nil }
                switch tag {
                case DNGInspector.newSubfileType: ifd.newSubfileType = integers(entryAt: e, limit: 1)?.first.map(Int.init)
                case DNGInspector.imageWidth: ifd.width = integers(entryAt: e, limit: 1)?.first.map(Int.init)
                case DNGInspector.imageLength: ifd.height = integers(entryAt: e, limit: 1)?.first.map(Int.init)
                case DNGInspector.photometricInterpretation: ifd.photometric = integers(entryAt: e, limit: 1)?.first.map { UInt16(truncatingIfNeeded: $0) }
                case DNGInspector.make: ifd.make = string(entryAt: e)
                case DNGInspector.model: ifd.model = string(entryAt: e)
                case DNGInspector.uniqueCameraModel: ifd.uniqueCameraModel = string(entryAt: e)
                case DNGInspector.dngVersion: ifd.hasDNGVersion = true
                case DNGInspector.subIFDs: ifd.subIFDOffsets = (integers(entryAt: e, limit: 8) ?? []).map(Int.init).filter { $0 > 0 }
                default: break
                }
            }
            ifd.nextIFDOffset = Int(u32(at: offset + 2 + 12 * Int(count)) ?? 0)
            return ifd
        }
    }
}
