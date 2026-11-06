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
    /// An imported DNG whose main image is already demosaiced but is not Apple's ProRAW (a converter's or
    /// another camera's linear DNG). Developed through the same linear decoder as ProRAW.
    case linearDNG = "Linear DNG"
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

/// One thing the camera system reported about the current lens, shown in Settings so a first run on
/// real hardware can be checked against the README's list of untested items.
public struct CaptureFact: Identifiable, Sendable, Equatable {
    public let label: String
    public let value: String
    public var id: String { label }
}

/// The capture device's system-pressure level (heat, power draw), as AVFoundation reports it.
public enum CameraPressure: Int, Sendable, Comparable {
    case nominal, fair, serious, critical, shutdown

    public static func < (a: CameraPressure, b: CameraPressure) -> Bool { a.rawValue < b.rawValue }

    init(_ level: AVCaptureDevice.SystemPressureState.Level) {
        switch level {
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        case .shutdown: self = .shutdown
        default: self = .nominal
        }
    }

    var label: String {
        switch self {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        case .shutdown: return "shutdown"
        }
    }
}

/// What the session is actually doing, reported by the core whenever it changes: read from the session, not
/// inferred from what was asked of it.
struct CaptureSessionState: Sendable, Equatable {
    var isRunning = false
    var isInterrupted = false
    /// Why the session is interrupted (a call, another app using the camera, heat), while it is.
    var interruption: String?
    /// A runtime error that stopped the session and was not recovered automatically.
    var error: String?
    var pressure: CameraPressure = .nominal
}

/// State the core reports back after (re)configuration.
struct CaptureConfiguration: Sendable {
    var rawKind: RAWKind
    var availableLenses: [Lens]
    var zoomLabel: String
    /// "0.5×", "1×", "2×"… per available lens, from the fields of view.
    var lensLabels: [Lens: String] = [:]
    var facts: [CaptureFact] = []
}

@MainActor
@Observable
public final class CameraService {
    /// The session's real running state (observed on the session, not set when `start` returns).
    public private(set) var isRunning = false
    /// Interrupted by the system: a call, another app using the camera, Picture in Picture, heat.
    public private(set) var isInterrupted = false
    /// Why, while interrupted.
    public private(set) var interruption: String?
    /// The last interruption reason seen since launch (shown in Settings, for the hardware checklist).
    public private(set) var lastInterruption: String?
    /// A runtime error that stopped the session (cleared when it runs again).
    public private(set) var sessionError: String?
    /// The camera's system pressure. From `.serious` the preview stream is throttled and the timed-preview
    /// measurement pauses; from `.critical` the preview drops the look.
    public private(set) var pressure: CameraPressure = .nominal
    public private(set) var isConfigured = false
    public private(set) var authorizationDenied = false
    public private(set) var currentLens: Lens = .wide
    public private(set) var availableLenses: [Lens] = []
    public private(set) var rawKind: RAWKind = .none
    public private(set) var exposureBias: Float = 0
    public private(set) var isCapturing = false
    public private(set) var lastError: String?
    public private(set) var zoomLabel: String = "1×"
    public private(set) var lensLabels: [Lens: String] = [:]
    /// What AVFoundation reported for the current lens (formats, RAW, colour space, controls).
    public private(set) var facts: [CaptureFact] = []
    /// AE/AF lock (long press on the preview): focus and exposure hold until the next tap.
    public private(set) var isExposureFocusLocked = false
    /// Whether to also request Apple's processed HEIF alongside the RAW (for the comparison view).
    public var captureCompanionHEIF = true
    /// Whether the shutter can take a photograph now.
    public var canCapture: Bool { isConfigured && isRunning && !isInterrupted }
    /// Request the largest photo size the format offers (48 MP on recent main cameras) instead of 12 MP.
    public var fullResolutionRAW = false {
        didSet {
            guard fullResolutionRAW != oldValue else { return }
            core.preferFullResolution = fullResolutionRAW
            if isConfigured { reconfigureCurrentLens() }
        }
    }

    @ObservationIgnored private let core = CaptureCore()

    public init() {
        // Camera Control (iPhone 16): the exposure slider and the lens picker report here; the core has
        // already applied the change to the device, so only the published state is updated.
        core.exposureBiasFromControl = { [weak self] ev in
            Task { @MainActor in self?.exposureBias = ev }
        }
        core.lensFromControl = { [weak self] lens in
            Task { @MainActor in self?.switchLens(lens) }
        }
        // FIFO on the main queue, so the states are applied in the order the session queue reported them.
        core.stateChanged = { [weak self] state in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.applySession(state) } }
        }
    }

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
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func stop() {
        core.stop()
    }

    private func applySession(_ s: CaptureSessionState) {
        isRunning = s.isRunning
        isInterrupted = s.isInterrupted
        interruption = s.interruption
        if let reason = s.interruption { lastInterruption = reason }
        sessionError = s.error
        pressure = s.pressure
    }

    private func apply(_ c: CaptureConfiguration) {
        rawKind = c.rawKind
        availableLenses = c.availableLenses
        zoomLabel = c.zoomLabel
        lensLabels = c.lensLabels
        facts = c.facts
    }

    // MARK: - Controls

    public func switchLens(_ lens: Lens) {
        guard lens != currentLens else { return }
        let previous = currentLens
        currentLens = lens
        isExposureFocusLocked = false     // the new camera starts in continuous focus and exposure
        Task {
            do {
                let config = try await core.reconfigure(lens: lens)
                apply(config)
            } catch {
                // The core kept the previous camera; say so, unless another switch came in meanwhile.
                if currentLens == lens { currentLens = previous }
                lastError = error.localizedDescription
            }
        }
    }

    private func reconfigureCurrentLens() {
        isExposureFocusLocked = false     // configureSession restores continuous focus and exposure
        Task {
            do {
                let config = try await core.reconfigure(lens: currentLens)
                apply(config)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    /// Focus and expose at a point in device coordinates (0…1, origin top-left, landscape sensor frame).
    public func focus(atDevicePoint p: CGPoint) {
        isExposureFocusLocked = false
        core.focus(at: p)
    }

    public func resetFocus() {
        isExposureFocusLocked = false
        core.resetFocus()
    }

    /// AE/AF lock at a point: one focus and exposure run, then both hold until `focus` or `resetFocus`.
    public func lockExposureAndFocus(atDevicePoint p: CGPoint) {
        isExposureFocusLocked = true
        core.lock(at: p)
    }

    public func setExposureBias(_ ev: Float) {
        let clamped = max(-3, min(3, ev))
        exposureBias = clamped
        core.setExposureBias(clamped)
    }

    // MARK: - Capture

    public func capture() async throws -> CaptureResult {
        guard canCapture else { throw CameraError.captureFailed(interruption ?? "the camera is not running") }
        guard !isCapturing else { throw CameraError.captureFailed("camera busy") }
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
    private var lastConfiguration = CaptureConfiguration(rawKind: .none, availableLenses: [], zoomLabel: "1×")
    var frameHandler: (@Sendable (CVPixelBuffer) -> Void)?

    // Camera Control (iOS 18, iPhone 16): an exposure-compensation slider and a lens picker, created once
    // and kept across lens changes. Stored type-erased because stored properties cannot be
    // availability-gated; every use is behind `#available(iOS 18.0, *)`.
    private var exposureControl: AnyObject?
    private var lensControl: AnyObject?
    private var controlLenses: [Lens] = []
    private var currentBias: Float = 0
    /// Set from the main actor, read on the session queue at configuration time (a benign race for a Bool).
    var preferFullResolution = false
    private var locked = false
    private var subjectAreaObserver: NSObjectProtocol?
    /// Called (on the session queue) when the hardware controls change a value.
    var exposureBiasFromControl: (@Sendable (Float) -> Void)?
    var lensFromControl: (@Sendable (Lens) -> Void)?
    /// Called on the session queue whenever the session's state changes.
    var stateChanged: (@Sendable (CaptureSessionState) -> Void)?

    // Session state, observed rather than assumed (queue only).
    private var state = CaptureSessionState()
    /// Whether the app wants the session running: a media-services reset restarts it only then.
    private var wantsRunning = false
    /// One automatic restart per `start`, so a reset that recurs cannot become a restart loop.
    private var automaticRestartUsed = false
    private var sessionObservers: [NSObjectProtocol] = []
    private var runningObservation: NSKeyValueObservation?
    private var pressureObservation: NSKeyValueObservation?
    /// Whether the frame rate is currently throttled for system pressure.
    private var throttled = false

    /// How long a capture may take before the continuation is failed (keeps the shutter from locking up
    /// if the delegate is never called).
    private let captureTimeout: TimeInterval = 20

    override init() {
        super.init()
        installSessionObservers()
    }

    deinit {
        sessionObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: Lifecycle

    func start(lens: Lens) async throws -> CaptureConfiguration {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [self] in
                wantsRunning = true
                automaticRestartUsed = false
                state.error = nil
                do {
                    if !configured {
                        try configureSession(lens: lens)
                        applyRAWPolicy()
                    }
                    // Blocks until the session runs or fails; a failure arrives as a runtime-error notification.
                    if !session.isRunning { session.startRunning() }
                    reportState()
                    cont.resume(returning: lastConfiguration)
                } catch {
                    reportState()
                    cont.resume(throwing: error)
                }
            }
        }
    }

    func stop() {
        queue.async { [self] in
            wantsRunning = false
            if session.isRunning { session.stopRunning() }
            reportState()
        }
    }

    // MARK: Session state

    /// Registered once for the session's lifetime. Each handler hops to `queue`, where every AVFoundation
    /// object is used, and the state is reported from there, so the reports reach the main actor in order.
    private func installSessionObservers() {
        let center = NotificationCenter.default
        sessionObservers = [
            center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] n in
                let error = n.userInfo?[AVCaptureSessionErrorKey] as? AVError
                self?.queue.async { self?.handleRuntimeError(error) }
            },
            center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] n in
                let reason = (n.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)
                    .flatMap { AVCaptureSession.InterruptionReason(rawValue: $0.intValue) }
                self?.queue.async { self?.handleInterruption(reason) }
            },
            center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in
                // The session resumes by itself when an interruption ends.
                self?.queue.async { self?.reportState() }
            },
        ]
        runningObservation = session.observe(\.isRunning, options: [.new]) { [weak self] _, _ in
            self?.queue.async { self?.reportState() }
        }
    }

    /// Publishes the session's real state. Runs on `queue`.
    private func reportState() {
        state.isRunning = session.isRunning
        state.isInterrupted = session.isInterrupted
        if !state.isInterrupted { state.interruption = nil }
        if state.isRunning { state.error = nil }
        stateChanged?(state)
    }

    private func handleRuntimeError(_ error: AVError?) {
        // A media-services reset (the media server restarted) leaves a session that can be started again.
        // Restart only if the app wants the camera running, and once per `start`: a reset that recurs is
        // reported instead of looping.
        if error?.code == .mediaServicesWereReset, wantsRunning, !automaticRestartUsed {
            automaticRestartUsed = true
            session.startRunning()
            if session.isRunning { reportState(); return }
        }
        state.error = error?.localizedDescription ?? "The camera stopped unexpectedly."
        reportState()
    }

    private func handleInterruption(_ reason: AVCaptureSession.InterruptionReason?) {
        state.interruption = Self.describe(reason)
        reportState()
    }

    static func describe(_ reason: AVCaptureSession.InterruptionReason?) -> String {
        switch reason {
        case .videoDeviceNotAvailableInBackground?: return "camera unavailable in the background"
        case .audioDeviceInUseByAnotherClient?: return "audio in use by another app"
        case .videoDeviceInUseByAnotherClient?: return "camera in use by another app"
        case .videoDeviceNotAvailableWithMultipleForegroundApps?: return "camera unavailable with several apps on screen"
        case .videoDeviceNotAvailableDueToSystemPressure?: return "camera paused: the iPhone is too hot"
        default: return "camera interrupted"
        }
    }

    /// Observes the current device's system pressure (heat, power). Replaced with the device.
    private func observePressure(of dev: AVCaptureDevice) {
        throttled = false                 // adding the input reset the device's frame durations to their defaults
        pressureObservation = dev.observe(\.systemPressureState, options: [.initial, .new]) { [weak self] dev, _ in
            let pressure = CameraPressure(dev.systemPressureState.level)
            self?.queue.async { self?.handlePressure(pressure, device: dev) }
        }
    }

    /// Frame-rate throttling, which AVFoundation recommends against system pressure: from `.serious` up the
    /// preview stream runs at 15–20 fps (the values of Apple's AVCam sample, which also uses the `.photo`
    /// preset); below it the device's defaults return. Photographs are unaffected.
    private func handlePressure(_ pressure: CameraPressure, device dev: AVCaptureDevice) {
        guard dev === device else { return }      // a late report from the previous lens
        let throttle = pressure >= .serious
        if throttle != throttled, (try? dev.lockForConfiguration()) != nil {
            if throttle {
                if dev.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 15 && $0.maxFrameRate >= 20 }) {
                    dev.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 20)
                    dev.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 15)
                    throttled = true
                }
            } else {
                dev.activeVideoMinFrameDuration = .invalid
                dev.activeVideoMaxFrameDuration = .invalid
                throttled = false
            }
            dev.unlockForConfiguration()
        }
        state.pressure = pressure
        reportState()
    }

    /// A lens or photo-size change, in one configuration of the running (or stopped) session: one pipeline
    /// rebuild, never a moment without an input. If the new camera cannot be added the previous one stays
    /// (see `configureSession`) and the error is thrown.
    func reconfigure(lens: Lens) async throws -> CaptureConfiguration {
        try await withCheckedThrowingContinuation { cont in
            queue.async { [self] in
                do {
                    try configureSession(lens: lens)
                    applyRAWPolicy()
                    cont.resume(returning: lastConfiguration)
                } catch {
                    syncLensPicker()          // back on the lens that is actually in use
                    cont.resume(throwing: error)
                }
            }
        }
    }

    /// Inputs, outputs and device settings. Committed before any RAW format is queried, because the
    /// photo output only reports RAW formats once it is connected to a committed session.
    private func configureSession(lens: Lens) throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        // Assigned only when it differs: choosing a preset resets the device's frame durations (pressure throttling).
        if session.sessionPreset != .photo { session.sessionPreset = .photo }
        // The live preview is linearised from the video stream, so keep that stream plain: no video HDR
        // (local tone mapping) and a known sRGB colour space instead of automatic wide colour.
        session.automaticallyConfiguresCaptureDeviceForWideColor = false

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
        // The camera input is swapped inside this one configuration, only when the camera changes (a photo-size
        // change keeps it). As in Apple's AVCam, the new input is made before the old one is removed, and if the
        // session refuses it the old one goes back, so a failed lens change never leaves the session without a
        // camera; everything tied to the device changes only once the new input is in.
        if videoInput?.device !== dev {
            let input = try AVCaptureDeviceInput(device: dev)
            let old = videoInput
            if let old { session.removeInput(old) }
            guard session.canAddInput(input) else {
                if let old, session.canAddInput(old) { session.addInput(old) }
                throw CameraError.configurationFailed("cannot add camera input")
            }
            session.addInput(input)
            videoInput = input
            observePressure(of: dev)
        }
        device = dev
        locked = false                    // the device below is put into continuous focus and exposure
        // A change of subject (the user recomposed) returns a tapped focus to continuous mode, unless locked.
        if let old = subjectAreaObserver { NotificationCenter.default.removeObserver(old) }
        subjectAreaObserver = NotificationCenter.default.addObserver(forName: .AVCaptureDeviceSubjectAreaDidChange, object: dev, queue: nil) { [weak self] _ in
            guard let self else { return }
            // Check and reset in one queue operation, so a lock requested in between cannot be undone.
            self.queue.async { if !self.locked { self.resetFocusNow() } }
        }

        if !session.outputs.contains(photoOutput) {
            guard session.canAddOutput(photoOutput) else { throw CameraError.configurationFailed("cannot add photo output") }
            session.addOutput(photoOutput)
        }
        photoOutput.maxPhotoQualityPrioritization = .quality
        // maxPhotoDimensions is chosen after the commit, in applyRAWPolicy.

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
            if currentBias != 0 {
                dev.setExposureTargetBias(max(dev.minExposureTargetBias, min(dev.maxExposureTargetBias, currentBias)), completionHandler: nil)
            }
            if dev.activeFormat.isVideoHDRSupported {
                dev.automaticallyAdjustsVideoHDREnabled = false
                dev.isVideoHDREnabled = false
            }
            if dev.activeFormat.supportedColorSpaces.contains(.sRGB) { dev.activeColorSpace = .sRGB }
            if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            dev.unlockForConfiguration()
        }

        configured = true
        let labels = Dictionary(uniqueKeysWithValues: lenses.map { ($0, Self.zoomLabel(for: $0, devices: discovery.devices)) })
        lastConfiguration = CaptureConfiguration(rawKind: .none, availableLenses: lenses,
                                                 zoomLabel: labels[lens] ?? "1×", lensLabels: labels)
        installControls(lenses: lenses, labels: labels, current: lens)
    }

    // MARK: Camera Control

    /// Adds the Camera Control slider and picker (iPhone 16) the first time the session is configured, and
    /// keeps the picker on the current lens afterwards. Runs inside begin/commitConfiguration on `queue`.
    private func installControls(lenses: [Lens], labels: [Lens: String], current: Lens) {
        guard #available(iOS 18.0, *), session.supportsControls else { return }
        if let picker = lensControl as? AVCaptureIndexPicker {
            if let i = controlLenses.firstIndex(of: current), picker.selectedIndex != i { picker.selectedIndex = i }
            return
        }
        // Installed already. With a single lens there is no picker to update, and without this guard every
        // reconfiguration (a full-resolution toggle) would add another slider.
        guard exposureControl == nil else { return }
        // Exposure compensation in thirds of a stop, the same range as the on-screen control.
        let values = (-9...9).map { Float($0) / 3 }
        let slider = AVCaptureSlider("Exposure", symbolName: "plusminus.circle", values: values)
        slider.prominentValues = [-2, -1, 0, 1, 2]
        slider.value = currentBias
        slider.setActionQueue(queue) { [weak self] value in
            guard let self else { return }
            let snapped = (value * 3).rounded() / 3
            self.currentBias = self.applyExposureBias(snapped)
            self.exposureBiasFromControl?(self.currentBias)
        }
        if session.canAddControl(slider) { session.addControl(slider); exposureControl = slider }

        if lenses.count > 1 {
            let picker = AVCaptureIndexPicker("Lens", symbolName: "camera.aperture",
                                              localizedIndexTitles: lenses.map { labels[$0] ?? "1×" })
            picker.selectedIndex = lenses.firstIndex(of: current) ?? 0
            picker.setActionQueue(queue) { [weak self] index in
                guard let self, lenses.indices.contains(index) else { return }
                self.lensFromControl?(lenses[index])
            }
            if session.canAddControl(picker) { session.addControl(picker); lensControl = picker; controlLenses = lenses }
        }
        session.setControlsDelegate(self, queue: queue)
    }

    /// Sets the device's exposure bias (clamped to what it supports) and returns the value applied.
    @discardableResult
    private func applyExposureBias(_ ev: Float) -> Float {
        guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return ev }
        let v = max(dev.minExposureTargetBias, min(dev.maxExposureTargetBias, ev))
        dev.setExposureTargetBias(v, completionHandler: nil)
        dev.unlockForConfiguration()
        return v
    }

    /// Keeps the Camera Control lens picker on the camera actually in use (after a lens change that failed).
    private func syncLensPicker() {
        guard #available(iOS 18.0, *), let picker = lensControl as? AVCaptureIndexPicker,
              let lens = Lens.allCases.first(where: { $0.deviceType == device?.deviceType }),
              let i = controlLenses.firstIndex(of: lens), picker.selectedIndex != i else { return }
        picker.selectedIndex = i
    }

    /// Photo size and RAW policy, decided after the configuration is committed (and before `startRunning` on
    /// the first start, as Apple recommends for both, since each reconfigures the pipeline).
    ///
    /// The photo size must be one the *active* format supports, and the format a preset brings is only certain
    /// once the configuration is committed, so it is chosen here rather than inside the configuration.
    /// RAW: Bayer first; ProRAW only when the camera offers no Bayer format at all.
    private func applyRAWPolicy() {
        if let dev = device, let chosen = Self.photoDimensions(for: dev.activeFormat, fullResolution: preferFullResolution) {
            let current = photoOutput.maxPhotoDimensions
            if current.width != chosen.width || current.height != chosen.height { photoOutput.maxPhotoDimensions = chosen }
        }
        let formats = photoOutput.availableRawPhotoPixelFormatTypes
        if formats.contains(where: { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }) {
            // Back from a lens that needed ProRAW: switch it off, so the pipeline is not left in its ProRAW
            // configuration while Bayer RAW is captured (and the Settings facts say what is in use).
            if photoOutput.isAppleProRAWEnabled { photoOutput.isAppleProRAWEnabled = false }
            lastConfiguration.rawKind = .bayer
        } else if photoOutput.isAppleProRAWSupported {
            photoOutput.isAppleProRAWEnabled = true
            let hasProRAW = photoOutput.availableRawPhotoPixelFormatTypes.contains { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }
            lastConfiguration.rawKind = hasProRAW ? .proRAW : .none
        } else {
            lastConfiguration.rawKind = .none
        }
        lastConfiguration.facts = collectFacts()
    }

    /// What the camera system says about the current lens, for the Settings screen.
    private func collectFacts() -> [CaptureFact] {
        guard let dev = device else { return [] }
        var facts: [CaptureFact] = []
        func add(_ label: String, _ value: String) { facts.append(CaptureFact(label: label, value: value)) }
        func fourCC(_ t: OSType) -> String {
            let bytes = [UInt8((t >> 24) & 0xFF), UInt8((t >> 16) & 0xFF), UInt8((t >> 8) & 0xFF), UInt8(t & 0xFF)]
            return String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? String(t)
        }
        func dims(_ d: CMVideoDimensions) -> String { "\(d.width)×\(d.height)" }
        add("Camera", dev.localizedName)
        let fd = CMVideoFormatDescriptionGetDimensions(dev.activeFormat.formatDescription)
        add("Active format", "\(dims(fd)) video")
        add("Photo sizes", dev.activeFormat.supportedMaxPhotoDimensions.map(dims).joined(separator: ", "))
        add("Max photo", dims(photoOutput.maxPhotoDimensions))
        let raw = photoOutput.availableRawPhotoPixelFormatTypes
        if raw.isEmpty {
            add("RAW formats", "none")
        } else {
            add("RAW formats", raw.map { t in
                let kind = AVCapturePhotoOutput.isBayerRAWPixelFormat(t) ? "Bayer" : (AVCapturePhotoOutput.isAppleProRAWPixelFormat(t) ? "ProRAW" : "other")
                return "\(fourCC(t)) (\(kind))"
            }.joined(separator: ", "))
        }
        add("Apple ProRAW", photoOutput.isAppleProRAWSupported ? (photoOutput.isAppleProRAWEnabled ? "supported, enabled" : "supported, off") : "not supported")
        add("ISO range", String(format: "%.0f–%.0f", dev.activeFormat.minISO, dev.activeFormat.maxISO))
        add("Bias range", String(format: "%+.1f…%+.1f EV", dev.minExposureTargetBias, dev.maxExposureTargetBias))
        add("Zoom factor", String(format: "%.2f", dev.videoZoomFactor))
        let space: String
        switch dev.activeColorSpace {
        case .sRGB: space = "sRGB"
        case .P3_D65: space = "P3 D65"
        case .HLG_BT2020: space = "HLG BT.2020"
        default: space = "other"
        }
        add("Preview colour space", space)
        add("Video HDR", dev.activeFormat.isVideoHDRSupported ? (dev.isVideoHDREnabled ? "on" : "off") : "not supported")
        if #available(iOS 18.0, *) {
            add("Camera Control", session.supportsControls ? "present, \(session.controls.count) controls" : "none")
        } else {
            add("Camera Control", "needs iOS 18")
        }
        return facts
    }

    /// 12 MP by default — the size every lens offers to Bayer RAW and the binned readout of 48 MP sensors —
    /// or the largest size the format offers when full resolution is requested.
    static func photoDimensions(for format: AVCaptureDevice.Format, fullResolution: Bool) -> CMVideoDimensions? {
        let sizes = format.supportedMaxPhotoDimensions.sorted { Int($0.width) * Int($0.height) < Int($1.width) * Int($1.height) }
        guard let largest = sizes.last else { return nil }
        if fullResolution { return largest }
        return sizes.first { Int($0.width) * Int($0.height) >= 11_000_000 } ?? largest
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
            locked = false
            if dev.isFocusPointOfInterestSupported { dev.focusPointOfInterest = p; dev.focusMode = .autoFocus }
            if dev.isExposurePointOfInterestSupported { dev.exposurePointOfInterest = p; dev.exposureMode = .continuousAutoExposure }
            dev.isSubjectAreaChangeMonitoringEnabled = true
            dev.unlockForConfiguration()
        }
    }

    /// AE/AF lock: one focus run and one exposure run at the point, after which the device holds both
    /// (`.autoFocus` and `.autoExpose` revert to `.locked` when they finish). Subject-area monitoring is
    /// off so nothing but the user unlocks it.
    func lock(at p: CGPoint) {
        queue.async { [self] in
            guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
            locked = true
            if dev.isFocusPointOfInterestSupported { dev.focusPointOfInterest = p }
            if dev.isFocusModeSupported(.autoFocus) { dev.focusMode = .autoFocus } else if dev.isFocusModeSupported(.locked) { dev.focusMode = .locked }
            if dev.isExposurePointOfInterestSupported { dev.exposurePointOfInterest = p }
            if dev.isExposureModeSupported(.autoExpose) { dev.exposureMode = .autoExpose } else if dev.isExposureModeSupported(.locked) { dev.exposureMode = .locked }
            dev.isSubjectAreaChangeMonitoringEnabled = false
            dev.unlockForConfiguration()
        }
    }

    func resetFocus() {
        queue.async { [self] in resetFocusNow() }
    }

    /// Continuous focus and exposure at the centre; releases any lock. Runs on `queue`.
    private func resetFocusNow() {
        guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
        locked = false
        let centre = CGPoint(x: 0.5, y: 0.5)
        if dev.isFocusPointOfInterestSupported { dev.focusPointOfInterest = centre }
        if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
        if dev.isExposurePointOfInterestSupported { dev.exposurePointOfInterest = centre }
        if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
        dev.isSubjectAreaChangeMonitoringEnabled = false
        dev.unlockForConfiguration()
    }

    func setExposureBias(_ ev: Float) {
        queue.async { [self] in
            currentBias = applyExposureBias(max(-3, min(3, ev)))
            // Keep the Camera Control slider on the same value (it may only be set on its action queue).
            if #available(iOS 18.0, *), let slider = exposureControl as? AVCaptureSlider, abs(slider.value - currentBias) > 1e-4 {
                slider.value = currentBias
            }
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
                // Watchdog: a capture that never reports back must not leave the shutter locked.
                queue.asyncAfter(deadline: .now() + captureTimeout) { [weak self, weak processor] in
                    guard let self, let processor, self.inFlight[id] === processor else { return }
                    self.inFlight[id] = nil
                    processor.fail(CameraError.captureFailed("the camera did not deliver the photograph in time"))
                }
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

@available(iOS 18.0, *)
extension CaptureCore: AVCaptureSessionControlsDelegate {
    // The controls need a delegate to become active; nothing in the app changes while they are shown.
    func sessionControlsDidBecomeActive(_ session: AVCaptureSession) {}
    func sessionControlsWillEnterFullscreenAppearance(_ session: AVCaptureSession) {}
    func sessionControlsWillExitFullscreenAppearance(_ session: AVCaptureSession) {}
    func sessionControlsDidBecomeInactive(_ session: AVCaptureSession) {}
}

/// Collects the RAW and processed photos of one capture request. Completes exactly once.
final class PhotoCaptureProcessor: NSObject, AVCapturePhotoCaptureDelegate {
    private let kind: RAWKind
    private let lens: Lens
    private let bias: Float
    private let completion: (Result<CaptureResult, Error>) -> Void
    private let lock = NSLock()
    private var finished = false
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

    private func finish(_ result: Result<CaptureResult, Error>) {
        lock.lock()
        let already = finished
        finished = true
        lock.unlock()
        if !already { completion(result) }
    }

    func fail(_ error: Error) { finish(.failure(error)) }

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
            finish(.failure(CameraError.captureFailed(error.localizedDescription)))
            return
        }
        guard rawData != nil || processedData != nil else {
            finish(.failure(CameraError.captureFailed("no image data was delivered")))
            return
        }
        let result = CaptureResult(rawData: rawData, rawKind: rawData == nil ? .none : kind, processedData: processedData,
                                   pixelWidth: width, pixelHeight: height, lens: lens, exposureBias: bias,
                                   iso: iso, exposureDuration: duration, lensModel: lensModel, capturedAt: Date())
        finish(.success(result))
    }
}
