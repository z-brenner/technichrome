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

@MainActor
final class PreviewRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    let context: CIContext
    let engine: TechnichromeEngine?
    private let commandQueue: MTLCommandQueue
    private var latest: CIImage?
    nonisolated private let frameLock = NSLock()
    nonisolated(unsafe) private var pendingFrame: CIImage?
    var parameters: EngineParameters = .default
    var exposureEV: Double = 0
    var showsLook = true
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
        if let frame { latest = frame }
        guard let source = latest, let drawable = view.currentDrawable, let buffer = commandQueue.makeCommandBuffer() else { return }

        var image = source
        if showsLook, let engine {
            let scale = TechnichromeEngine.exposureScale(parameters: parameters, baselineEV: 0, extraEV: exposureEV)
            image = engine.makeImage(from: source, parameters: parameters, exposureScale: scale,
                                     longEdge: Double(max(source.extent.width, source.extent.height)), spatial: false)
        }
        // Aspect-fit into the drawable
        let dsize = view.drawableSize
        let ext = image.extent
        guard ext.width > 0, ext.height > 0, dsize.width > 0, dsize.height > 0 else { return }
        let s = min(dsize.width / ext.width, dsize.height / ext.height)
        let w = ext.width * s, h = ext.height * s
        let ox = (dsize.width - w) / 2, oy = (dsize.height - h) / 2
        let placed = image
            .transformed(by: CGAffineTransform(scaleX: s, y: s))
            .transformed(by: CGAffineTransform(translationX: ox - ext.minX * s, y: oy - ext.minY * s))
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

    func makeUIView(context: Context) -> MTKView { renderer.makeView() }
    func updateUIView(_ uiView: MTKView, context: Context) {}
}
