//
//  PreviewRenderer.swift
//  Technichrome
//
//  Live preview: camera frames → Technichrome engine → Metal view. The video frames are
//  display-referred (Apple's own tone mapping), so this is an approximation of the print; the
//  developed photograph is rendered from the RAW data. Rendering is paced by the display.
//

import Foundation
import CoreImage
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
    var parameters: EngineParameters = .default { didSet { if parameters != oldValue { dirty = true } } }
    var exposureEV: Double = 0 { didSet { dirty = true } }
    var showsLook = true { didSet { dirty = true } }
    /// Set when a new frame, parameter or size requires a redraw; the view ticks at 30 fps regardless.
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
        v.isPaused = false
        v.enableSetNeedsDisplay = false
        v.preferredFramesPerSecond = 30
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        v.backgroundColor = .black
        if let layer = v.layer as? CAMetalLayer {
            layer.colorspace = TechnichromeEngine.outputColorSpace
        }
        return v
    }

    /// Called on the video queue.
    nonisolated func submit(pixelBuffer: CVPixelBuffer) {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        frameLock.lock(); pendingFrame = image; frameLock.unlock()
    }

    nonisolated func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    nonisolated func draw(in view: MTKView) {
        // MTKView calls its delegate on the main thread.
        MainActor.assumeIsolated { render(in: view) }
    }

    private func render(in view: MTKView) {
        frameLock.lock(); let frame = pendingFrame; pendingFrame = nil; frameLock.unlock()
        if let frame { latest = frame; dirty = true }
        if view.drawableSize != lastDrawableSize { lastDrawableSize = view.drawableSize; dirty = true }
        guard dirty, let source = latest, let drawable = view.currentDrawable, let buffer = commandQueue.makeCommandBuffer() else { return }
        dirty = false

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
        if showsLook, let engine {
            let scale = TechnichromeEngine.exposureScale(parameters: parameters, baselineEV: 0, extraEV: exposureEV)
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
