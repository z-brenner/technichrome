//
//  CameraService.swift
//  Technichrome
//
//  AVFoundation session management and RAW capture. Policy: genuine Bayer RAW whenever the
//  selected physical camera offers it; Apple ProRAW as the second choice; HEIF as a last resort
//  (the engine still runs, but only on display-referred data — the UI says so).
//
//  `CameraService` is the main-actor, observable face used by SwiftUI. `CaptureCore` owns every
//  AVFoundation object and only ever touches them on its own serial queue.
//

import Foundation
import AVFoundation
import CoreImage
import UIKit
import Observation

public enum RAWKind: String, Codable, Sendable {
    case bayer = "Bayer RAW"
    case proRAW = "Apple ProRAW"
    case none = "HEIF"
}

public enum Lens: String, CaseIterable, Codable, Sendable, Identifiable {
    case ultraWide, wide, telephoto
    public var id: String { rawValue }
    var deviceType: AVCaptureDevice.DeviceType {
        switch self {
        case .ultraWide: return .builtInUltraWideCamera
        case .wide: return .builtInWideAngleCamera
        case .telephoto: return .builtInTelephotoCamera
        }
    }
}

public struct CaptureResult: Sendable {
    public var rawData: Data?            // DNG (Bayer or ProRAW)
    public var rawKind: RAWKind
    public var processedData: Data?      // HEIF companion (Apple's rendering) — optional
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var lens: Lens
    public var exposureBias: Float
    public var iso: Float?
    public var exposureDuration: Double?
    public var lensModel: String?
    public var capturedAt: Date
}

public enum CameraError: Error, LocalizedError {
    case notAuthorized
    case noCamera
    case configurationFailed(String)
    case captureFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notAuthorized: return "Technichrome needs camera access to photograph."
        case .noCamera: return "No camera is available on this device."
        case .configurationFailed(let s): return "Camera configuration failed: \(s)"
        case .captureFailed(let s): return "Capture failed: \(s)"
        }
    }
}

/// State the core reports back after (re)configuration.
struct CaptureConfiguration: Sendable {
    var rawKind: RAWKind
    var availableLenses: [Lens]
    var zoomLabel: String
}

@MainActor
@Observable
public final class CameraService {
    public private(set) var isRunning = false
    public private(set) var isConfigured = false
    public private(set) var authorizationDenied = false
    public private(set) var currentLens: Lens = .wide
    public private(set) var availableLenses: [Lens] = []
    public private(set) var rawKind: RAWKind = .none
    public private(set) var exposureBias: Float = 0
    public private(set) var isCapturing = false
    public private(set) var lastError: String?
    public private(set) var zoomLabel: String = "1×"
    /// Whether to also request Apple's processed HEIF alongside the RAW (for the comparison view).
    public var captureCompanionHEIF = true

    @ObservationIgnored private let core = CaptureCore()

    public init() {}

    /// Receives preview frames (BGRA) on the video queue.
    public var frameHandler: (@Sendable (CVPixelBuffer) -> Void)? {
        get { core.frameHandler }
        set { core.frameHandler = newValue }
    }

    // MARK: - Lifecycle

    public func start() {
        Task { await self.startAsync() }
    }

    public func startAsync() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        var granted = status == .authorized
        if status == .notDetermined {
            granted = await AVCaptureDevice.requestAccess(for: .video)
        }
        guard granted else {
            authorizationDenied = true
            lastError = CameraError.notAuthorized.localizedDescription
            return
        }
        do {
            let config = try await core.start(lens: currentLens)
            apply(config)
            isConfigured = true
            isRunning = true
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func stop() {
        core.stop()
        isRunning = false
    }

    private func apply(_ c: CaptureConfiguration) {
        rawKind = c.rawKind
        availableLenses = c.availableLenses
        zoomLabel = c.zoomLabel
    }

    // MARK: - Controls

    public func switchLens(_ lens: Lens) {
        guard lens != currentLens else { return }
        currentLens = lens
        Task {
            do {
                let config = try await core.reconfigure(lens: lens)
                apply(config)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// Focus and expose at a point in device coordinates (0…1, origin top-left, landscape sensor frame).
    public func focus(atDevicePoint p: CGPoint) { core.focus(at: p) }
    public func resetFocus() { core.resetFocus() }

    public func setExposureBias(_ ev: Float) {
        let clamped = max(-3, min(3, ev))
        exposureBias = clamped
        core.setExposureBias(clamped)
    }

    // MARK: - Capture

    public func capture() async throws -> CaptureResult {
        guard isConfigured, !isCapturing else { throw CameraError.captureFailed("camera busy") }
        isCapturing = true
        defer { isCapturing = false }
        return try await core.capture(lens: currentLens, bias: exposureBias, wantCompanion: captureCompanionHEIF)
    }
}

/// Owns the AVCaptureSession. All members are used on `queue` only, except `frameHandler` (written from
/// the main actor, read on the video queue — a benign race for a closure reference).
final class CaptureCore: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.technichrome.session", qos: .userInitiated)
    private let videoQueue = DispatchQueue(label: "com.technichrome.video", qos: .userInteractive)
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var device: AVCaptureDevice?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var inFlight: [Int64: PhotoCaptureProcessor] = [:]
    private var configured = false
    var frameHandler: (@Sendable (CVPixelBuffer) -> Void)?

    // MARK: Lifecycle

    func start(lens: Lens) async throws -> CaptureConfiguration {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [self] in
                do {
                    let config = try configured ? currentConfiguration() : configureSession(lens: lens)
                    if !session.isRunning { session.startRunning() }
                    cont.resume(returning: config)
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func reconfigure(lens: Lens) async throws -> CaptureConfiguration {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [self] in
                do {
                    session.beginConfiguration()
                    if let old = videoInput { session.removeInput(old); videoInput = nil }
                    configured = false
                    session.commitConfiguration()
                    let config = try configureSession(lens: lens)
                    if !session.isRunning { session.startRunning() }
                    cont.resume(returning: config)
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }

    private var lastConfiguration = CaptureConfiguration(rawKind: .none, availableLenses: [], zoomLabel: "1×")
    private func currentConfiguration() -> CaptureConfiguration { lastConfiguration }

    private func configureSession(lens: Lens) throws -> CaptureConfiguration {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo

        // Physical back cameras only: Bayer RAW is not available on virtual (multi-camera) devices.
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video, position: .back)
        let lenses = Lens.allCases.filter { l in discovery.devices.contains { $0.deviceType == l.deviceType } }
        guard let dev = discovery.devices.first(where: { $0.deviceType == lens.deviceType })
                ?? discovery.devices.first(where: { $0.deviceType == .builtInWideAngleCamera })
                ?? discovery.devices.first else {
            throw CameraError.noCamera
        }
        device = dev
        let input = try AVCaptureDeviceInput(device: dev)
        guard session.canAddInput(input) else { throw CameraError.configurationFailed("cannot add camera input") }
        session.addInput(input)
        videoInput = input

        if !session.outputs.contains(photoOutput) {
            guard session.canAddOutput(photoOutput) else { throw CameraError.configurationFailed("cannot add photo output") }
            session.addOutput(photoOutput)
        }
        photoOutput.maxPhotoQualityPrioritization = .quality
        if let largest = dev.activeFormat.supportedMaxPhotoDimensions.last {
            photoOutput.maxPhotoDimensions = largest
        }

        // RAW policy: Bayer first. Only enable ProRAW when the camera offers no Bayer format at all.
        let rawKind: RAWKind
        let hasBayer = photoOutput.availableRawPhotoPixelFormatTypes.contains { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }
        if hasBayer {
            rawKind = .bayer
        } else if photoOutput.isAppleProRAWSupported {
            photoOutput.isAppleProRAWEnabled = true
            let hasProRAW = photoOutput.availableRawPhotoPixelFormatTypes.contains { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }
            rawKind = hasProRAW ? .proRAW : .none
        } else {
            rawKind = .none
        }

        if !session.outputs.contains(videoOutput) {
            videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: videoQueue)
            if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
        }
        // Portrait preview frames.
        if let c = videoOutput.connection(with: .video), c.isVideoRotationAngleSupported(90) {
            c.videoRotationAngle = 90
        }
        rotationCoordinator = AVCaptureDevice.RotationCoordinator(device: dev, previewLayer: nil)

        // Bayer RAW requires videoZoomFactor == 1 on the physical device.
        if (try? dev.lockForConfiguration()) != nil {
            dev.videoZoomFactor = 1.0
            if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            dev.unlockForConfiguration()
        }

        configured = true
        lastConfiguration = CaptureConfiguration(rawKind: rawKind, availableLenses: lenses,
                                                 zoomLabel: Self.zoomLabel(for: lens, devices: discovery.devices))
        return lastConfiguration
    }

    private static func zoomLabel(for lens: Lens, devices: [AVCaptureDevice]) -> String {
        guard let wide = devices.first(where: { $0.deviceType == .builtInWideAngleCamera }),
              let dev = devices.first(where: { $0.deviceType == lens.deviceType }) else { return "1×" }
        let wf = Double(wide.activeFormat.videoFieldOfView)
        let df = Double(dev.activeFormat.videoFieldOfView)
        guard wf > 0, df > 0 else { return "1×" }
        let ratio = tan(wf * .pi / 360) / tan(df * .pi / 360)
        if abs(ratio - 1) < 0.05 { return "1×" }
        return ratio < 1 ? String(format: "%.1f×", ratio) : String(format: "%.0f×", ratio.rounded())
    }

    // MARK: Controls

    func focus(at p: CGPoint) {
        queue.async { [self] in
            guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
            if dev.isFocusPointOfInterestSupported { dev.focusPointOfInterest = p; dev.focusMode = .autoFocus }
            if dev.isExposurePointOfInterestSupported { dev.exposurePointOfInterest = p; dev.exposureMode = .continuousAutoExposure }
            dev.isSubjectAreaChangeMonitoringEnabled = true
            dev.unlockForConfiguration()
        }
    }

    func resetFocus() {
        queue.async { [self] in
            guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
            let centre = CGPoint(x: 0.5, y: 0.5)
            if dev.isFocusPointOfInterestSupported { dev.focusPointOfInterest = centre }
            if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if dev.isExposurePointOfInterestSupported { dev.exposurePointOfInterest = centre }
            if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            dev.unlockForConfiguration()
        }
    }

    func setExposureBias(_ ev: Float) {
        queue.async { [self] in
            guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
            let v = max(dev.minExposureTargetBias, min(dev.maxExposureTargetBias, ev))
            dev.setExposureTargetBias(v, completionHandler: nil)
            dev.unlockForConfiguration()
        }
    }

    // MARK: Capture

    func capture(lens: Lens, bias: Float, wantCompanion: Bool) async throws -> CaptureResult {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [self] in
                let available = photoOutput.availableRawPhotoPixelFormatTypes
                let bayer = available.first { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }
                let proRAW = available.first { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }
                let processedFormat: [String: Any]? = wantCompanion && photoOutput.availablePhotoCodecTypes.contains(.hevc)
                    ? [AVVideoCodecKey: AVVideoCodecType.hevc] : nil
                let settings: AVCapturePhotoSettings
                let kind: RAWKind
                if let fmt = bayer ?? proRAW {
                    kind = bayer != nil ? .bayer : .proRAW
                    if let processedFormat {
                        settings = AVCapturePhotoSettings(rawPixelFormatType: fmt, processedFormat: processedFormat)
                    } else {
                        settings = AVCapturePhotoSettings(rawPixelFormatType: fmt)
                    }
                } else {
                    kind = .none
                    settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
                }
                settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
                settings.photoQualityPrioritization = .quality
                settings.flashMode = .off
                let angle = rotationCoordinator?.videoRotationAngleForHorizonLevelCapture ?? 90
                if let c = photoOutput.connection(with: .video), c.isVideoRotationAngleSupported(angle) {
                    c.videoRotationAngle = angle
                }
                let id = settings.uniqueID
                let processor = PhotoCaptureProcessor(kind: kind, lens: lens, bias: bias) { [self] result in
                    queue.async { self.inFlight[id] = nil }
                    cont.resume(with: result)
                }
                inFlight[id] = processor
                photoOutput.capturePhoto(with: settings, delegate: processor)
            }
        }
    }

    // MARK: Video frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        frameHandler?(pb)
    }
}

/// Collects the RAW and processed photos of one capture request.
final class PhotoCaptureProcessor: NSObject, AVCapturePhotoCaptureDelegate {
    private let kind: RAWKind
    private let lens: Lens
    private let bias: Float
    private let completion: (Result<CaptureResult, Error>) -> Void
    private var rawData: Data?
    private var processedData: Data?
    private var width = 0, height = 0
    private var iso: Float?
    private var duration: Double?
    private var lensModel: String?
    private var failure: Error?

    init(kind: RAWKind, lens: Lens, bias: Float, completion: @escaping (Result<CaptureResult, Error>) -> Void) {
        self.kind = kind; self.lens = lens; self.bias = bias; self.completion = completion
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error { failure = error; return }
        guard let data = photo.fileDataRepresentation() else { return }
        if photo.isRawPhoto {
            rawData = data
            width = Int(photo.resolvedSettings.rawPhotoDimensions.width)
            height = Int(photo.resolvedSettings.rawPhotoDimensions.height)
        } else {
            processedData = data
            if width == 0 {
                width = Int(photo.resolvedSettings.photoDimensions.width)
                height = Int(photo.resolvedSettings.photoDimensions.height)
            }
        }
        if let exif = photo.metadata[kCGImagePropertyExifDictionary as String] as? [String: Any] {
            if let isoArr = exif[kCGImagePropertyExifISOSpeedRatings as String] as? [NSNumber], let v = isoArr.first { iso = v.floatValue }
            if let t = exif[kCGImagePropertyExifExposureTime as String] as? NSNumber { duration = t.doubleValue }
            if let m = exif[kCGImagePropertyExifLensModel as String] as? String { lensModel = m }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        if let error = error ?? failure {
            completion(.failure(CameraError.captureFailed(error.localizedDescription)))
            return
        }
        guard rawData != nil || processedData != nil else {
            completion(.failure(CameraError.captureFailed("no image data was delivered")))
            return
        }
        let result = CaptureResult(rawData: rawData, rawKind: rawData == nil ? .none : kind, processedData: processedData,
                                   pixelWidth: width, pixelHeight: height, lens: lens, exposureBias: bias,
                                   iso: iso, exposureDuration: duration, lensModel: lensModel, capturedAt: Date())
        completion(.success(result))
    }
}
