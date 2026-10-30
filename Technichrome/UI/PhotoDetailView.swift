//
//  PhotoDetailView.swift
//  Technichrome
//

import SwiftUI

struct PhotoDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let record: PhotoRecord

    @State private var image: UIImage?
    @State private var appleImage: UIImage?
    @State private var comparing = false
    @State private var zoom: CGFloat = 1
    @State private var lastZoom: CGFloat = 1
    @State private var confirmDelete = false
    @State private var message: String?
    @State private var showsInfo = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                Spacer(minLength: 0)
                ZStack {
                    if comparing, let a = appleImage {
                        Image(uiImage: a).resizable().scaledToFit()
                    } else if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .scaleEffect(zoom)
                            .gesture(MagnifyGesture()
                                .onChanged { v in zoom = max(1, min(5, lastZoom * v.magnification)) }
                                .onEnded { _ in lastZoom = zoom })
                            .onTapGesture(count: 2) { withAnimation(.spring(response: 0.3)) { zoom = 1; lastZoom = 1 } }
                    } else {
                        TCLabel("undeveloped", size: 11)
                    }
                }
                .clipped()
                .onLongPressGesture(minimumDuration: 0.15, perform: {}, onPressingChanged: { down in
                    if appleImage != nil { comparing = down }
                })
                Spacer(minLength: 0)
                if showsInfo { infoPanel }
                footer
            }
        }
        .task { load() }
        .confirmationDialog("Delete this photograph and its RAW file?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                model.store.delete(record)
                dismiss()
            }
        }
        .alert("Technichrome", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK") {}
        } message: { Text(message ?? "") }
    }

    private var header: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivory).frame(width: 44, height: 44)
            }.buttonStyle(.plain).accessibilityLabel("Close")
            Spacer()
            VStack(spacing: 3) {
                TCLabel(record.capturedAt.formatted(date: .abbreviated, time: .shortened), size: 9, color: Theme.ivory)
                TCLabel(comparing ? "apple rendering" : record.rawKind.rawValue, size: 9)
            }
            Spacer()
            Button { withAnimation { showsInfo.toggle() } } label: {
                Image(systemName: "info.circle").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivoryDim).frame(width: 44, height: 44)
            }.buttonStyle(.plain).accessibilityLabel("Photo information")
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
    }

    private var infoPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            row("Source", record.rawKind == .none ? "No RAW (display-referred image)" : "\(record.rawKind.rawValue) · \(record.pixelWidth)×\(record.pixelHeight)")
            row("Camera", record.cameraModel ?? "—")
            if let iso = record.iso, let t = record.exposureDuration {
                row("Exposure", String(format: "ISO %.0f · 1/%.0f s · %+.1f EV", iso, 1 / max(t, 1e-6), record.exposureBias))
            }
            row("Baseline", String(format: "%+.2f EV (DNG)", record.baselineExposure))
            row("Print", "\(record.parameters?.name ?? "Technichrome v1") · \(String(format: "%+.1f", record.printExposureEV)) EV · timed \(String(format: "%+.2f", record.printTimingEV)) EV")
        }
        .padding(14)
        .background(Theme.panel)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            TCLabel(k, size: 9).frame(width: 70, alignment: .leading)
            Text(v).font(Theme.mono(11)).foregroundStyle(Theme.ivory)
            Spacer()
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            PillButton(title: "Save", prominent: true) {
                Task {
                    do {
                        let withRAW = model.settings.saveRAWWithPrint && record.hasRAW
                        try await ExportService.saveToPhotos(record: record, store: model.store, includeRAW: withRAW)
                        message = withRAW ? "Saved to Photos (print + DNG)." : "Saved to Photos."
                        Haptics.success()
                    }
                    catch { message = error.localizedDescription }
                }
            }
            .disabled(!record.isDeveloped)
            ShareLink(items: shareItems) {
                TCLabel("Share", size: 11, color: Theme.ivory, tracking: 2)
                    .padding(.horizontal, 16).padding(.vertical, 9)
                    .background(Capsule().fill(Color.white.opacity(0.06)))
                    .overlay(Capsule().strokeBorder(Theme.ivoryFaint, lineWidth: 1))
            }
            .buttonStyle(.plain)
            PillButton(title: "Lab") {
                model.selectedPhoto = record
                model.showsLaboratory = true
            }
            PillButton(title: "Delete") { confirmDelete = true }
        }
        .padding(.bottom, 28)
        .padding(.top, 10)
    }

    private var shareItems: [URL] {
        var items: [URL] = []
        let dev = model.store.developedURL(for: record)
        if FileManager.default.fileExists(atPath: dev.path) { items.append(dev) }
        let raw = model.store.originalURL(for: record)
        if FileManager.default.fileExists(atPath: raw.path) { items.append(raw) }
        return items
    }

    private func load() {
        image = UIImage(contentsOfFile: model.store.developedURL(for: record).path)
        let a = model.store.appleURL(for: record)
        if FileManager.default.fileExists(atPath: a.path) { appleImage = UIImage(contentsOfFile: a.path) }
    }
}
