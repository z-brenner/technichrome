//
//  PreviewRenderer.swift
//  Technichrome
//
//  Live preview: camera frames → Technichrome engine → Metal view. The video frames are
//  display-referred (Apple's own tone mapping), so this is an approximation of the print; the
//  developed photograph is rendered from the RAW data. Rendering is paced by the camera: a frame is
//  drawn when one arrives.
//

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Metal
import MetalKit
import UIKit
import SwiftUI
import AVKit

@MainActor
final class PreviewRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    let context: CIContext
    let engine: TechnichromeEngine?
    private let commandQueue: MTLCommandQueue
    private var latest: CIImage?
    nonisolated private let frameLock = NSLock()
    nonisolated(unsafe) private var pendingFrame: CIImage?
    /// A draw is queued on the main queue and has not run yet; guarded by `frameLock` (see requestDraw).
    nonisolated(unsafe) private var drawPending = false
    /// The view being drawn: `makeView` makes a new one each time the camera view appears.
    private weak var view: MTKView?
    var parameters: EngineParameters = .default { didSet { if parameters != oldValue { invalidate() } } }
    var exposureEV: Double = 0 { didSet { invalidate() } }
    /// The photographer's exposure compensation, excluded from the preview's print timing like the develop step's.
    var cameraBiasEV: Double = 0
    var showsLook = true { didSet { invalidate() } }
    /// The camera's system pressure. The preview's own cost is shed first: from `.serious` the timing
    /// measurement pauses, from `.critical` the preview is plain (photographs are still developed with the look).
    var systemPressure: CameraPressure = .nominal { didSet { if systemPressure != oldValue { invalidate() } } }
    /// Print timing for the preview: measured about twice a second from the frames and smoothed, so the
    /// preview predicts the timed print rather than the untimed one.
    private(set) var previewTimingEV: Double = 0
    /// A timing measurement is on the GPU (see startPreviewTimingMeasurement).
    private var timingInFlight = false
    private var frameCounter = 0
    /// Set when a new frame, parameter or size requires a redraw.
    private var dirty = true
    private var lastDrawableSize: CGSize = .zero
    /// Rendered image rect in view points (for tap-to-focus mapping).
    private(set) var imageRect: CGRect = .zero

    init?(engine: TechnichromeEngine?) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.commandQueue = queue
        self.context = CIContext.technichrome(device: device)
        self.engine = engine
        super.init()
    }

    func makeView() -> MTKView {
        let v = MTKView(frame: .zero, device: device)
        v.delegate = self
        v.framebufferOnly = false
        v.colorPixelFormat = .bgra8Unorm
        // Explicit drawing (MTKView: paused, no setNeedsDisplay, call `draw()`): a frame is drawn when the camera
        // delivers one or a parameter changes, not on a display timer that is not phase-locked to the camera
        // (which gave a variable latency and dropped or doubled frames). A stopped camera draws nothing.
        v.isPaused = true
        v.enableSetNeedsDisplay = false
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        v.backgroundColor = .black
        if let layer = v.layer as? CAMetalLayer {
            layer.colorspace = TechnichromeEngine.outputColorSpace
        }
        view = v
        dirty = true
        return v
    }

    /// A parameter changed: draw the last frame again, even with the camera stopped.
    private func invalidate() {
        dirty = true
        requestDraw()
    }

    /// Asks for one draw on the main queue. Requests made before it runs (frames arriving faster than the main
    /// thread draws, parameter changes) are coalesced into it, and it draws the newest frame.
    nonisolated private func requestDraw() {
        frameLock.lock()
        let schedule = !drawPending
        drawPending = true
        frameLock.unlock()
        guard schedule else { return }
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.performRequestedDraw() }
        }
    }

    private func performRequestedDraw() {
        frameLock.lock(); drawPending = false; frameLock.unlock()
        view?.draw()                      // calls draw(in:) synchronously
    }

    /// Drops the last camera frame, and the pixel buffer it holds, while the camera view is away: the renderer
    /// lives as long as the app (AppModel.previewRenderer).
    func releaseFrame() {
        frameLock.lock(); pendingFrame = nil; frameLock.unlock()
        latest = nil
    }

    /// Called on the video queue.
    nonisolated func submit(pixelBuffer: CVPixelBuffer) {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        frameLock.lock(); pendingFrame = image; frameLock.unlock()
        requestDraw()
    }

    nonisolated func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        requestDraw()                     // render() notices the new size
    }

    nonisolated func draw(in view: MTKView) {
        // MTKView calls its delegate on the main thread.
        MainActor.assumeIsolated { render(in: view) }
    }

    private func render(in view: MTKView) {
        frameLock.lock(); let frame = pendingFrame; pendingFrame = nil; frameLock.unlock()
        if let frame { latest = frame; dirty = true }
        if view.drawableSize != lastDrawableSize { lastDrawableSize = view.drawableSize; dirty = true }
        guard dirty, let source = latest else { return }

        // Aspect-fit into the drawable. The frame is scaled down *before* the engine runs: the camera can
        // deliver frames far larger than the screen, and the per-pixel maths costs the same for every pixel.
        let dsize = view.drawableSize
        let srcExtent = source.extent
        guard srcExtent.width > 0, srcExtent.height > 0, dsize.width > 0, dsize.height > 0 else { return }
        let s = min(dsize.width / srcExtent.width, dsize.height / srcExtent.height)
        let preScale = min(s, 1)   // never upscale before the engine
        var image = preScale < 1
            ? source.transformed(by: CGAffineTransform(scaleX: preScale, y: preScale), highQualityDownsample: true)
            : source
        if showsLook, systemPressure < .critical, let engine {
            frameCounter &+= 1
            if parameters.timingStrength > 0 {
                if frameCounter % 12 == 1, systemPressure < .serious {
                    startPreviewTimingMeasurement(of: image, engine: engine)
                }
            } else {
                previewTimingEV = 0
            }
            let scale = TechnichromeEngine.exposureScale(parameters: parameters, baselineEV: 0, extraEV: exposureEV + previewTimingEV)
            image = engine.makeImage(from: image, parameters: parameters, exposureScale: scale,
                                     longEdge: Double(max(image.extent.width, image.extent.height)), spatial: false)
        }
        let ext = image.extent
        let post = s / preScale
        let w = ext.width * post, h = ext.height * post
        let ox = (dsize.width - w) / 2, oy = (dsize.height - h) / 2
        let placed = image
            .transformed(by: CGAffineTransform(scaleX: post, y: post))
            .transformed(by: CGAffineTransform(translationX: ox - ext.minX * post, y: oy - ext.minY * post))
        let pointScale = view.contentScaleFactor > 0 ? view.contentScaleFactor : 1
        imageRect = CGRect(x: ox / pointScale, y: (dsize.height - oy - h) / pointScale, width: w / pointScale, height: h / pointScale)

        // The drawable is obtained as late as possible, once the graph is built: `currentDrawable` can block the
        // main thread while every drawable is in flight.
        guard let drawable = view.currentDrawable, let buffer = commandQueue.makeCommandBuffer() else { return }
        dirty = false
        let destination = CIRenderDestination(mtlTexture: drawable.texture, commandBuffer: buffer)
        destination.colorSpace = TechnichromeEngine.outputColorSpace
        destination.alphaMode = .none
        let black = CIImage(color: CIColor.black).cropped(to: CGRect(origin: .zero, size: dsize))
        do {
            try context.startTask(toRender: placed.composited(over: black), to: destination)
        } catch {
            return
        }
        buffer.present(drawable)
        buffer.commit()
    }

    /// Print timing measured the way the develop step measures it: geometric-mean luminance after the engine's
    /// fixed exposure, with the photographer's exposure compensation taken out (a mean of logs at preview size;
    /// downscaling first would bias the geometric mean).
    ///
    /// The 1×1 readback is asynchronous: the render is queued on the GPU here, waited for on a utility queue,
    /// and the result reaches the main actor a frame or two later, which the smoothing absorbs. A synchronous
    /// readback made the main thread wait for the GPU every 12 frames. One measurement at a time.
    private func startPreviewTimingMeasurement(of image: CIImage, engine: TechnichromeEngine) {
        guard !timingInFlight else { return }
        let p = parameters
        let bias = cameraBiasEV
        let average = CIFilter.areaAverage()
        average.inputImage = engine.makeLogLuminance(from: image, exposureScale: TechnichromeEngine.exposureScale(parameters: p, baselineEV: 0))
        average.extent = image.extent
        guard let out = average.outputImage, !out.extent.isInfinite else { return }
        let pixel = UnsafeMutablePointer<Float>.allocate(capacity: 4)
        pixel.initialize(repeating: .nan, count: 4)
        let destination = CIRenderDestination(bitmapData: pixel, width: 1, height: 1, bytesPerRow: 16, format: .RGBAf)
        // The working space itself, so the log values come back unconverted, negative ones included.
        destination.colorSpace = TechnichromeEngine.workingColorSpace
        let task: CIRenderTask
        do {
            task = try context.startTask(toRender: out, from: CGRect(origin: out.extent.origin, size: CGSize(width: 1, height: 1)),
                                         to: destination, at: .zero)
        } catch {
            pixel.deallocate()
            return
        }
        timingInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let logMean: Double = withExtendedLifetime(destination) {
                (try? task.waitUntilCompleted()) != nil ? Double(pixel[0]) : .nan
            }
            pixel.deallocate()
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.finishPreviewTiming(logMean: logMean, parameters: p, cameraBiasEV: bias) }
            }
        }
    }

    private func finishPreviewTiming(logMean: Double, parameters p: EngineParameters, cameraBiasEV bias: Double) {
        timingInFlight = false
        guard logMean.isFinite, parameters.timingStrength > 0 else { return }
        let measured = PrintTiming.exposureEV(geometricMeanLuminance: pow(2.0, logMean), target: p.timingTarget,
                                              strength: p.timingStrength, limit: p.timingLimit, cameraBiasEV: bias)
        previewTimingEV += 0.35 * (measured - previewTimingEV)   // settles within about a second
    }

    /// Maps a tap in view points to AVFoundation device coordinates (0…1, landscape sensor frame).
    func devicePoint(forTap p: CGPoint) -> CGPoint? {
        guard imageRect.width > 0 else { return nil }
        let nx = (p.x - imageRect.minX) / imageRect.width
        let ny = (p.y - imageRect.minY) / imageRect.height
        guard (0...1).contains(nx), (0...1).contains(ny) else { return nil }
        // Preview frames are rotated 90° (portrait); the sensor's x axis runs down the screen.
        return CGPoint(x: ny, y: 1 - nx)
    }
}

struct PreviewView: UIViewRepresentable {
    let renderer: PreviewRenderer
    /// Hardware capture events (volume buttons, the Camera Control button) are routed to `onCaptureEvent`
    /// while this is true; when false the buttons keep their system behaviour (volume).
    var captureEventsEnabled = true
    var onCaptureEvent: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MTKView {
        let view = renderer.makeView()
        context.coordinator.onCaptureEvent = onCaptureEvent
        if #available(iOS 17.2, *) {
            // Like the system camera: the photograph is taken when the button is released.
            let interaction = AVCaptureEventInteraction { [weak coordinator = context.coordinator] event in
                guard event.phase == .ended else { return }
                coordinator?.onCaptureEvent()
            }
            interaction.isEnabled = captureEventsEnabled
            view.addInteraction(interaction)
            context.coordinator.interaction = interaction
        }
        return view
    }

    func updateUIView(_ uiView: MTKView, context: Context) {
        context.coordinator.onCaptureEvent = onCaptureEvent
        if #available(iOS 17.2, *), let interaction = context.coordinator.interaction as? AVCaptureEventInteraction {
            if interaction.isEnabled != captureEventsEnabled { interaction.isEnabled = captureEventsEnabled }
        }
    }

    final class Coordinator {
        var onCaptureEvent: () -> Void = {}
        /// `AVCaptureEventInteraction` (iOS 17.2+), type-erased because stored properties cannot be availability-gated.
        var interaction: (any UIInteraction)?
    }
}
