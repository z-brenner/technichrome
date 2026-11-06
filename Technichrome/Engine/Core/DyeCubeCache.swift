//
//  DyeCubeCache.swift
//  Technichrome
//
//  The baked dye cubes in hand: a few entries keyed by the print-model inputs (PrintModelKey), most recently
//  used first, so the live preview, the Laboratory, a pinned look and the develop each keep theirs while
//  another is in use. Thread-safe. A bake runs outside the lock: a thread asking for a cube that is already
//  cached never waits for another thread's bake. Two threads missing the same key at once both bake (a few
//  milliseconds) and share the first result kept.
//

import Foundation

public final class DyeCubeCache: @unchecked Sendable {
    /// A baked cube in CIColorCube's layout (RGBA Float32, cyan fastest, then magenta, then yellow), as bytes.
    public struct Cube: Sendable {
        public let data: Data
        public let dimension: Int
    }

    public let dimension: Int
    public let capacity: Int

    private let lock = NSLock()
    private var entries: [(key: PrintModelKey, cube: Cube)] = []   // most recently used first
    private var bakes = 0

    /// Cubes are Display P3, the print model's only space (an sRGB print is converted from the finished P3 print).
    public init(dimension: Int = 33, capacity: Int = 4) {
        precondition(capacity > 0, "a cube cache holds at least one cube")
        self.dimension = dimension
        self.capacity = capacity
    }

    /// The cube for these parameters: the cached one, or a new bake, which is then kept.
    public func cube(for p: EngineParameters) -> Cube {
        let key = PrintModelKey(p)
        if let cube = cached(key) { return cube }
        let lut = LUTBuilder.build(parameters: p, dimension: dimension)
        let cube = Cube(data: lut.data.withUnsafeBufferPointer { Data(buffer: $0) }, dimension: lut.dimension)
        return keep(cube, for: key)
    }

    /// How many cubes have been baked so far, a duplicate bake in a race included.
    public var bakeCount: Int {
        lock.lock(); defer { lock.unlock() }
        return bakes
    }

    private func cached(_ key: PrintModelKey) -> Cube? {
        lock.lock(); defer { lock.unlock() }
        return touch(key)
    }

    private func keep(_ cube: Cube, for key: PrintModelKey) -> Cube {
        lock.lock(); defer { lock.unlock() }
        bakes += 1
        if let kept = touch(key) { return kept }   // another thread baked the same cube meanwhile
        entries.insert((key, cube), at: 0)
        if entries.count > capacity { entries.removeLast(entries.count - capacity) }
        return cube
    }

    /// Moves the entry for `key` to the front and returns its cube. Call with the lock held.
    private func touch(_ key: PrintModelKey) -> Cube? {
        guard let i = entries.firstIndex(where: { $0.key == key }) else { return nil }
        let entry = entries.remove(at: i)
        entries.insert(entry, at: 0)
        return entry.cube
    }
}
