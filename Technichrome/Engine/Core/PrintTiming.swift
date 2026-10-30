//
//  PrintTiming.swift
//  Technichrome
//
//  "Timing" is what a film laboratory did to every print: choose the printer light so that the
//  scene lands where it should on the print curve. A RAW file's absolute brightness depends on the
//  camera's auto-exposure decisions (iPhones protect highlights, so RAW frames often sit low), so the
//  engine measures the scene's geometric-mean luminance and nudges the print exposure toward a
//  target key — partially (strength) and within a limit, so intent survives.
//

import Foundation

public enum PrintTiming {
    /// Exposure correction in stops that moves a scene's geometric-mean luminance toward `target`,
    /// scaled by `strength` (0 = off, 1 = full correction) and clamped to ±`limit`.
    public static func exposureEV(geometricMeanLuminance g: Double, target: Double, strength: Double, limit: Double) -> Double {
        guard g > 0, target > 0, g.isFinite, strength > 0 else { return 0 }
        let full = log2(target / g)
        let scaled = full * min(max(strength, 0), 1)
        let lim = max(0, limit)
        return min(max(scaled, -lim), lim)
    }

    /// Geometric mean of a set of luminance samples (used by tests and the CPU reference).
    public static func geometricMean(_ samples: [Double]) -> Double {
        let logs = samples.compactMap { $0 > 0 ? log2(max($0, 1e-6)) : nil }
        guard !logs.isEmpty else { return 0 }
        return pow(2.0, logs.reduce(0, +) / Double(logs.count))
    }
}
