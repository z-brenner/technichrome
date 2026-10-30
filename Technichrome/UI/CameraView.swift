//
//  CameraView.swift
//  Technichrome
//
//  The instrument: a live Technichrome preview, lens choice, exposure, the shutter. Nothing else.
//

import SwiftUI
import AVFoundation
import Combine

struct CameraView: View {
    @Environment(AppModel.self) private var model
    @State private var renderer: PreviewRenderer?
    @State private var focusPoint: CGPoint?
    @State private var focusVisible = false
    @State private var evDragStart: Float?
    @State private var pendingLockPoint: CGPoint?
    @State private var showsLook = true
    @State private var captureError: String?
    @State private var flashOverlay = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                topBar
                    .frame(height: 56)
                preview(size: geo.size)
                bottomBar
                    .frame(height: 150)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .onAppear { setUp() }
        .onDisappear { model.camera.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.camera.start() } else if phase == .background { model.camera.stop() }
        }
        .onChange(of: model.parameters) { _, p in renderer?.parameters = p }
        .onChange(of: model.camera.exposureBias) { _, ev in renderer?.cameraBiasEV = Double(ev) }
        .alert("Capture failed", isPresented: Binding(get: { captureError != nil }, set: { if !$0 { captureError = nil } })) {
            Button("OK") {}
        } message: { Text(captureError ?? "") }
    }

    // MARK: - Pieces

    private var topBar: some View {
        HStack(alignment: .center) {
            lensPicker
            Spacer()
            rawBadge
            Spacer()
            Button {
                showsLook.toggle()
                renderer?.showsLook = showsLook
                Haptics.tick()
            } label: {
                TCLabel(showsLook ? "look" : "plain", size: 10, color: showsLook ? Theme.ivory : Theme.ivoryDim)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .overlay(Capsule().strokeBorder(Theme.ivoryFaint, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showsLook ? "Preview shows the Technichrome look" : "Preview shows the plain camera image")
            .frame(width: 90, alignment: .trailing)
        }
        .padding(.horizontal, 18)
    }

    private var lensPicker: some View {
        HStack(spacing: 6) {
            ForEach(model.camera.availableLenses) { lens in
                let selected = lens == model.camera.currentLens
                Button {
                    model.camera.switchLens(lens)
                    Haptics.tick()
                } label: {
                    Text(label(for: lens))
                        .font(Theme.label(11))
                        .foregroundStyle(selected ? Color.black : Theme.ivoryDim)
                        .frame(width: 34, height: 26)
                        .background(Circle().fill(selected ? Theme.ivory : Color.white.opacity(0.06)))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(width: 130, alignment: .leading)
    }

    private func label(for lens: Lens) -> String {
        if let l = model.camera.lensLabels[lens] { return l.replacingOccurrences(of: "×", with: "") }
        switch lens {
        case .ultraWide: return "0.5"
        case .wide: return "1"
        case .telephoto: return "T"
        }
    }

    /// Volume buttons and the Camera Control button photograph only while the camera is the active surface;
    /// under the develop screen or a sheet they keep their system behaviour.
    private var hardwareShutterEnabled: Bool {
        model.camera.isConfigured && model.developing == nil && !model.showsLaboratory && !model.showsSettings
    }

    private var rawBadge: some View {
        VStack(spacing: 3) {
            Wordmark(size: 12)
            TCLabel(model.camera.rawKind == .none ? "heif · no raw" : model.camera.rawKind.rawValue, size: 9,
                    color: model.camera.rawKind == .bayer ? Theme.ivory : Theme.ivoryDim, tracking: 2.5)
        }
    }

    private func preview(size: CGSize) -> some View {
        ZStack {
            if let renderer {
                PreviewView(renderer: renderer, captureEventsEnabled: hardwareShutterEnabled) { capture() }
            } else {
                Rectangle().fill(Color(white: 0.05))
            }
            if model.camera.authorizationDenied {
                VStack(spacing: 10) {
                    TCLabel("camera access needed", size: 12, color: Theme.ivory)
                    Text("Allow camera access in Settings to photograph with Technichrome.")
                        .font(Theme.body(14)).foregroundStyle(Theme.ivoryDim).multilineTextAlignment(.center)
                    PillButton(title: "Open settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
                .padding(32)
            }
            if let p = focusPoint, focusVisible {
                FocusReticle()
                    .position(p)
                    .transition(.opacity)
            }
            if model.camera.isExposureFocusLocked {
                VStack {
                    HStack {
                        TCLabel("ae · af locked", size: 9, color: Theme.ivory, tracking: 2.5)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Capsule().fill(Color.black.opacity(0.45)))
                        Spacer()
                    }
                    Spacer()
                }
                .padding(14)
                .transition(.opacity)
            }
            if flashOverlay {
                Rectangle().fill(Color.black).ignoresSafeArea()
            }
        }
        .contentShape(Rectangle())
        .gesture(dragForExposure)
        .simultaneousGesture(longPressToLock)
        .onTapGesture(count: 2) {
            model.camera.resetFocus()
            model.camera.setExposureBias(0)
            Haptics.tick()
        }
        .onTapGesture(count: 1, coordinateSpace: .local) { location in
            tapToFocus(at: location)
        }
    }

    private var dragForExposure: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { v in
                if evDragStart == nil { evDragStart = model.camera.exposureBias }
                let delta = Float(-v.translation.height / 90.0)   // ~90 pt per stop
                let ev = ((evDragStart ?? 0) + delta)
                let snapped = (ev * 3).rounded() / 3
                if snapped != model.camera.exposureBias {
                    model.camera.setExposureBias(snapped)
                    Haptics.tick()
                }
            }
            .onEnded { _ in evDragStart = nil }
    }

    /// Long press: AE/AF lock at the point (the location comes from the drag that follows the press).
    private var longPressToLock: some Gesture {
        LongPressGesture(minimumDuration: 0.5, maximumDistance: 12)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
            .onChanged { value in
                if case .second(true, let drag?) = value, pendingLockPoint == nil { pendingLockPoint = drag.location }
            }
            .onEnded { value in
                var point: CGPoint?
                if case .second(true, let drag?) = value { point = drag.location } else { point = pendingLockPoint }
                pendingLockPoint = nil
                if let point { lockExposureAndFocus(at: point) }
            }
    }

    private func lockExposureAndFocus(at location: CGPoint) {
        guard let renderer, let dp = renderer.devicePoint(forTap: location) else { return }
        model.camera.lockExposureAndFocus(atDevicePoint: dp)
        focusPoint = location
        withAnimation(.easeOut(duration: 0.15)) { focusVisible = true }   // stays until the next tap
        Haptics.success()
    }

    private func tapToFocus(at location: CGPoint) {
        guard let renderer, let dp = renderer.devicePoint(forTap: location) else { return }
        model.camera.focus(atDevicePoint: dp)
        focusPoint = location
        withAnimation(.easeOut(duration: 0.15)) { focusVisible = true }
        Haptics.tick()
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            withAnimation(.easeIn(duration: 0.4)) { focusVisible = false }
        }
    }

    private var bottomBar: some View {
        HStack {
            galleryThumb
                .frame(width: 90, alignment: .leading)
            Spacer()
            ShutterButton(isBusy: model.camera.isCapturing) { capture() }
            Spacer()
            exposureReadout
                .frame(width: 90, alignment: .trailing)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 10)
    }

    private var galleryThumb: some View {
        Button {
            model.screen = .gallery
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.06))
                if let r = model.store.records.first, let ui = UIImage(contentsOfFile: model.store.thumbnailURL(for: r).path) {
                    Image(uiImage: ui).resizable().scaledToFill()
                } else {
                    Image(systemName: "square.grid.3x3").font(.system(size: 14, weight: .light)).foregroundStyle(Theme.ivoryDim)
                }
            }
            .frame(width: 46, height: 46)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.ivoryFaint, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var exposureReadout: some View {
        let ev = model.camera.exposureBias
        return Button {
            model.camera.setExposureBias(0)
            Haptics.tick()
        } label: {
            VStack(spacing: 2) {
                Text(ev == 0 ? "±0" : String(format: "%@%.1f", ev > 0 ? "+" : "−", abs(ev)))
                    .font(Theme.mono(15))
                    .foregroundStyle(ev == 0 ? Theme.ivoryDim : Theme.ivory)
                TCLabel("ev", size: 9)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions

    private func setUp() {
        if renderer == nil, let r = PreviewRenderer(engine: model.engine) {
            renderer = r
            model.camera.frameHandler = { buffer in r.submit(pixelBuffer: buffer) }
        }
        renderer?.parameters = model.parameters   // may have changed in the Laboratory while this view was away
        renderer?.cameraBiasEV = Double(model.camera.exposureBias)
        model.camera.start()
    }

    private func capture() {
        guard !model.camera.isCapturing else { return }
        Haptics.shutter()
        withAnimation(.easeIn(duration: 0.06)) { flashOverlay = true }
        Task {
            do {
                let result = try await model.camera.capture()
                withAnimation(.easeOut(duration: 0.2)) { flashOverlay = false }
                let record = try await model.store.add(capture: result)
                model.developing = record
            } catch {
                withAnimation { flashOverlay = false }
                captureError = error.localizedDescription
                Haptics.error()
            }
        }
    }
}

struct FocusReticle: View {
    @State private var scale: CGFloat = 1.3
    var body: some View {
        Rectangle()
            .strokeBorder(Theme.ivory.opacity(0.9), lineWidth: 1)
            .frame(width: 64, height: 64)
            .scaleEffect(scale)
            .onAppear { withAnimation(.easeOut(duration: 0.25)) { scale = 1.0 } }
    }
}
