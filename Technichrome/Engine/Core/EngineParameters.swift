//
//  EngineParameters.swift
//  Technichrome
//
//  Every adjustable quantity of the Technichrome rendering engine ("imbibition model").
//  The struct is Codable so presets can be stored as JSON and edited in the in-app Laboratory.
//
//  Which numbers are historically documented and which are artistic approximations is
//  discussed in docs/COLOR_SCIENCE.md. Nothing here is a measurement of a real print.
//

import Foundation

/// One absorption lobe of a dye: an asymmetric generalised Gaussian in wavelength (nm),
/// exp(−½·|(λ−μ)/σ|^shape). shape = 2 is a Gaussian; 3–4 gives the flat-topped, sharp-edged
/// ("block dye") band of real imbibition dyes and taking filters.
public struct DyeLobe: Codable, Equatable, Sendable {
    public var mu: Double
    public var sigmaLeft: Double
    public var sigmaRight: Double
    public var amplitude: Double
    public var shape: Double

    public init(mu: Double, sigmaLeft: Double, sigmaRight: Double, amplitude: Double, shape: Double = 2.0) {
        self.mu = mu; self.sigmaLeft = sigmaLeft; self.sigmaRight = sigmaRight; self.amplitude = amplitude; self.shape = shape
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mu = try c.decode(Double.self, forKey: .mu)
        sigmaLeft = try c.decode(Double.self, forKey: .sigmaLeft)
        sigmaRight = try c.decode(Double.self, forKey: .sigmaRight)
        amplitude = try c.decode(Double.self, forKey: .amplitude)
        shape = try c.decodeIfPresent(Double.self, forKey: .shape) ?? 2.0
    }
}

/// Spectral absorbance of a dye as a sum of lobes, normalised to a peak of 1.
public struct DyeSpectrum: Codable, Equatable, Sendable {
    public var lobes: [DyeLobe]

    public init(lobes: [DyeLobe]) { self.lobes = lobes }

    /// Normalised absorbance on the spectral grid (peak = 1).
    public func absorbance() -> [Double] {
        var a = [Double](repeating: 0, count: Spectral.sampleCount)
        for lobe in lobes {
            let g = Spectral.asymmetricGaussian(mu: lobe.mu, sigmaLeft: lobe.sigmaLeft, sigmaRight: lobe.sigmaRight, shape: lobe.shape)
            for i in a.indices { a[i] += lobe.amplitude * g[i] }
        }
        let peak = a.max() ?? 1
        if peak > 0 { for i in a.indices { a[i] /= peak } }
        return a
    }
}

/// Parameters of one characteristic (H&D) curve: density versus log10 exposure, as a Richards
/// (generalised logistic) curve — see CharacteristicCurve.swift.
public struct CurveParameters: Codable, Equatable, Sendable {
    public var dMin: Double
    public var dMax: Double
    /// Slope at the half-density point (density per log10 exposure).
    public var gamma: Double
    /// log10 exposure at half density.
    public var logE0: Double
    /// Asymmetry: 1 = plain logistic; → 0 = Gompertz-like (abrupt toe, long shoulder); > 1 = long toe.
    public var nu: Double

    public init(dMin: Double, dMax: Double, gamma: Double, logE0: Double, nu: Double) {
        self.dMin = dMin; self.dMax = dMax; self.gamma = gamma; self.logE0 = logE0; self.nu = nu
    }
}

public struct EngineParameters: Codable, Equatable, Sendable {
    // MARK: Exposure
    /// Exposure compensation applied to the scene-linear input, in stops.
    public var exposureEV: Double

    // MARK: Three-strip camera
    /// Rows = red, green, blue separation records; columns = linear sRGB R, G, B. Rows sum to 1.
    /// Derived offline from assumed filter/emulsion sensitivities (tools/colorscience/tcengine.py).
    public var separationMatrix: [Double]

    // MARK: Separation negatives ("developed to equal contrast", Ball 1935)
    public var negative: CurveParameters

    // MARK: Matrices and dye transfer
    /// Peak density of each dye (cyan, magenta, yellow) at full transfer.
    public var dyeDMax: [Double]
    /// Density multiplier per dye (kept at 1; the print is balanced with the printer lights below).
    public var dyeGain: [Double]
    /// Printer light per matrix in stops: how a laboratory balanced a print so greys print neutral.
    /// Positive = more light through that negative = more of that dye. Calibrated by the prototype.
    public var dyeLightEV: [Double]
    /// Matrix-film characteristic (positive relief → dye density). dMin/dMax are taken from dyeDMax.
    public var matrixGamma: Double
    public var matrixLogE0: Double
    public var matrixNu: Double

    // MARK: Silver key image (printed from the green record; used c. 1932–1944)
    /// 0 = no key (post-1944 prints), 1 = the full documented "50 %" image.
    public var keyStrength: Double
    public var key: CurveParameters

    // MARK: Print stock and projection
    /// Neutral density of clear base + stain. Normalised away (eye adapts to screen white); only
    /// affects second-order colour interactions.
    public var printDMin: Double
    /// Correlated colour temperature of the projector lamp (carbon arc ≈ daylight-ish).
    public var projectorCCT: Double
    /// Dye absorbances.
    public var cyan: DyeSpectrum
    public var magenta: DyeSpectrum
    public var yellow: DyeSpectrum

    // MARK: Display rendering
    /// Viewing-condition compensation: a dark-surround print viewed on a bright-surround phone.
    /// Applied as a power on display-linear values (1 = none).
    public var surroundExponent: Double

    // MARK: Print timing (see PrintTiming.swift)
    /// 0 = fixed printer light; 1 = fully re-time every scene to the target key.
    public var timingStrength: Double
    /// Target geometric-mean scene luminance (a normally exposed scene sits near 0.16–0.18).
    public var timingTarget: Double
    /// Maximum correction in stops, either way.
    public var timingLimit: Double

    // MARK: Spatial stages
    /// Dye diffusion in the gelatin: Gaussian σ in pixels for a 4000 px long edge (scaled with size).
    public var diffusionSigmaAt4K: Double
    /// Per-dye misregistration in pixels at 4000 px long edge (0 = perfect pin registration).
    public var misregistrationAt4K: Double
    /// Negative halation / highlight glow. 0 = off.
    public var bloomAmount: Double
    public var bloomThreshold: Double
    /// Blur radius of the glow as a percentage of the long edge.
    public var bloomRadiusPercent: Double

    // MARK: Identity
    public var name: String

    public init(
        exposureEV: Double, separationMatrix: [Double], negative: CurveParameters,
        dyeDMax: [Double], dyeGain: [Double], dyeLightEV: [Double] = [0, 0, 0], matrixGamma: Double, matrixLogE0: Double, matrixNu: Double,
        keyStrength: Double, key: CurveParameters, printDMin: Double, projectorCCT: Double,
        cyan: DyeSpectrum, magenta: DyeSpectrum, yellow: DyeSpectrum, surroundExponent: Double,
        timingStrength: Double = 0.6, timingTarget: Double = 0.16, timingLimit: Double = 1.25,
        diffusionSigmaAt4K: Double, misregistrationAt4K: Double, bloomAmount: Double, bloomThreshold: Double, bloomRadiusPercent: Double,
        name: String
    ) {
        self.exposureEV = exposureEV; self.separationMatrix = separationMatrix; self.negative = negative
        self.dyeDMax = dyeDMax; self.dyeGain = dyeGain; self.dyeLightEV = dyeLightEV; self.matrixGamma = matrixGamma; self.matrixLogE0 = matrixLogE0
        self.matrixNu = matrixNu; self.keyStrength = keyStrength; self.key = key
        self.printDMin = printDMin; self.projectorCCT = projectorCCT; self.cyan = cyan; self.magenta = magenta; self.yellow = yellow
        self.surroundExponent = surroundExponent
        self.timingStrength = timingStrength; self.timingTarget = timingTarget; self.timingLimit = timingLimit
        self.diffusionSigmaAt4K = diffusionSigmaAt4K
        self.misregistrationAt4K = misregistrationAt4K; self.bloomAmount = bloomAmount; self.bloomThreshold = bloomThreshold
        self.bloomRadiusPercent = bloomRadiusPercent; self.name = name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = EngineParameters.technichromeV1
        exposureEV = try c.decodeIfPresent(Double.self, forKey: .exposureEV) ?? d.exposureEV
        separationMatrix = try c.decodeIfPresent([Double].self, forKey: .separationMatrix) ?? d.separationMatrix
        negative = try c.decodeIfPresent(CurveParameters.self, forKey: .negative) ?? d.negative
        dyeDMax = try c.decodeIfPresent([Double].self, forKey: .dyeDMax) ?? d.dyeDMax
        dyeGain = try c.decodeIfPresent([Double].self, forKey: .dyeGain) ?? d.dyeGain
        dyeLightEV = try c.decodeIfPresent([Double].self, forKey: .dyeLightEV) ?? d.dyeLightEV
        matrixGamma = try c.decodeIfPresent(Double.self, forKey: .matrixGamma) ?? d.matrixGamma
        matrixLogE0 = try c.decodeIfPresent(Double.self, forKey: .matrixLogE0) ?? d.matrixLogE0
        matrixNu = try c.decodeIfPresent(Double.self, forKey: .matrixNu) ?? d.matrixNu
        keyStrength = try c.decodeIfPresent(Double.self, forKey: .keyStrength) ?? d.keyStrength
        key = try c.decodeIfPresent(CurveParameters.self, forKey: .key) ?? d.key
        printDMin = try c.decodeIfPresent(Double.self, forKey: .printDMin) ?? d.printDMin
        projectorCCT = try c.decodeIfPresent(Double.self, forKey: .projectorCCT) ?? d.projectorCCT
        cyan = try c.decodeIfPresent(DyeSpectrum.self, forKey: .cyan) ?? d.cyan
        magenta = try c.decodeIfPresent(DyeSpectrum.self, forKey: .magenta) ?? d.magenta
        yellow = try c.decodeIfPresent(DyeSpectrum.self, forKey: .yellow) ?? d.yellow
        surroundExponent = try c.decodeIfPresent(Double.self, forKey: .surroundExponent) ?? d.surroundExponent
        timingStrength = try c.decodeIfPresent(Double.self, forKey: .timingStrength) ?? d.timingStrength
        timingTarget = try c.decodeIfPresent(Double.self, forKey: .timingTarget) ?? d.timingTarget
        timingLimit = try c.decodeIfPresent(Double.self, forKey: .timingLimit) ?? d.timingLimit
        diffusionSigmaAt4K = try c.decodeIfPresent(Double.self, forKey: .diffusionSigmaAt4K) ?? d.diffusionSigmaAt4K
        misregistrationAt4K = try c.decodeIfPresent(Double.self, forKey: .misregistrationAt4K) ?? d.misregistrationAt4K
        bloomAmount = try c.decodeIfPresent(Double.self, forKey: .bloomAmount) ?? d.bloomAmount
        bloomThreshold = try c.decodeIfPresent(Double.self, forKey: .bloomThreshold) ?? d.bloomThreshold
        bloomRadiusPercent = try c.decodeIfPresent(Double.self, forKey: .bloomRadiusPercent) ?? d.bloomRadiusPercent
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? d.name
        guard separationMatrix.count == 9, dyeDMax.count == 3, dyeGain.count == 3, dyeLightEV.count == 3 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "separationMatrix must have 9 values and dyeDMax/dyeGain/dyeLightEV 3"))
        }
    }

    /// The matrix-film curve for dye `i` (0 = cyan, 1 = magenta, 2 = yellow).
    public func matrixCurve(_ i: Int) -> CurveParameters {
        CurveParameters(dMin: 0, dMax: dyeDMax[i], gamma: matrixGamma, logE0: matrixLogE0, nu: matrixNu)
    }

    public var separation: Matrix3 { Matrix3(rowMajor: separationMatrix) }

    /// Spatial sigma (px) for an image whose long edge is `longEdge` pixels.
    public func diffusionSigma(longEdge: Double) -> Double { diffusionSigmaAt4K * longEdge / 4000.0 }
    public func misregistration(longEdge: Double) -> Double { misregistrationAt4K * longEdge / 4000.0 }

    // MARK: - Presets

    /// Technichrome v1 — the one meticulously tuned look. See docs/COLOR_SCIENCE.md.
    public static let technichromeV1 = EngineParameters(
        exposureEV: 0.0,
        separationMatrix: [0.8473, 0.1158, 0.0369,
                           0.0310, 0.9297, 0.0393,
                           0.0398, 0.0864, 0.8738],
        negative: CurveParameters(dMin: 0.12, dMax: 2.2, gamma: 0.4500, logE0: -1.0539, nu: 0.2001),
        dyeDMax: [2.8, 2.8, 2.8],
        dyeGain: [1.1963, 0.9153, 0.8884],
        dyeLightEV: [0.0000, 0.0000, 0.0000],
        matrixGamma: 3.2176, matrixLogE0: -1.0621, matrixNu: 0.0253,
        keyStrength: 0.15,
        key: CurveParameters(dMin: 0, dMax: 1.1, gamma: 0.9, logE0: -1.05, nu: 0.5),
        printDMin: 0.06,
        projectorCCT: 5400.0,
        cyan: DyeSpectrum(lobes: [DyeLobe(mu: 652.0, sigmaLeft: 52.0, sigmaRight: 62.0, amplitude: 1.00, shape: 3.0),
                                  DyeLobe(mu: 540.0, sigmaLeft: 45.0, sigmaRight: 40.0, amplitude: 0.22, shape: 2.0),
                                  DyeLobe(mu: 440.0, sigmaLeft: 35.0, sigmaRight: 35.0, amplitude: 0.12, shape: 2.0)]),
        magenta: DyeSpectrum(lobes: [DyeLobe(mu: 545.0, sigmaLeft: 42.0, sigmaRight: 42.0, amplitude: 1.00, shape: 3.5),
                                  DyeLobe(mu: 440.0, sigmaLeft: 40.0, sigmaRight: 35.0, amplitude: 0.22, shape: 2.0),
                                  DyeLobe(mu: 640.0, sigmaLeft: 25.0, sigmaRight: 40.0, amplitude: 0.04, shape: 2.0)]),
        yellow: DyeSpectrum(lobes: [DyeLobe(mu: 445.0, sigmaLeft: 45.0, sigmaRight: 40.0, amplitude: 1.00, shape: 3.5),
                                  DyeLobe(mu: 505.0, sigmaLeft: 15.0, sigmaRight: 30.0, amplitude: 0.08, shape: 2.0)]),
        surroundExponent: 0.92,
        timingStrength: 0.6, timingTarget: 0.16, timingLimit: 1.25,
        diffusionSigmaAt4K: 1.1,
        misregistrationAt4K: 0.0,
        bloomAmount: 0.0, bloomThreshold: 0.85, bloomRadiusPercent: 1.5,
        name: "Technichrome v1"
    )

    public static let `default` = technichromeV1

    // MARK: - JSON

    public func jsonData() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try enc.encode(self)
    }

    public static func fromJSON(_ data: Data) throws -> EngineParameters {
        try JSONDecoder().decode(EngineParameters.self, from: data)
    }
}
