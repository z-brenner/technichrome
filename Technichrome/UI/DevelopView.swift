//
//  DevelopView.swift
//  Technichrome
//
//  The moment after the shutter: the print builds up the way Ball described it in 1935 —
//  the silver key, then the yellow matrix, then cyan, then magenta — while the full-resolution
//  develop runs behind it.
//

import SwiftUI
import CoreImage

struct DevelopView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let record: PhotoRecord

    enum Stage: Int, CaseIterable {
        case key, yellow, cyan, magenta, done
        var caption: String {
            switch self {
            case .key: return "silver key"
            case .yellow: return "transferring yellow"
            case .cyan: return "transferring cyan"
            case .magenta: return "transferring magenta"
            case .done: return ""
            }
        }
        var mask: DyeMask {
            switch self {
            case .key: return .none
            case .yellow: return .afterYellow
            case .cyan: return .afterCyan
            case .magenta, .done: return .all
            }
        }
    }

    @State private var stageImages: [Stage: CGImage] = [:]
    @State private var stage: Stage = .key
    @State private var finalImage: CGImage?
    @State private var developed = false
    @State private var failure: String?
    @State private var saved = false
    @State private var comparing = false
    @State private var appleImage: UIImage?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                Spacer(minLength: 8)
                imageArea
                Spacer(minLength: 8)
                footer
            }
        }
        .task { await run() }
        .alert("Development failed", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK") { dismiss() }
        } message: { Text(failure ?? "") }
    }

    private var header: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivory)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            Spacer()
            VStack(spacing: 3) {
                Wordmark(size: 12)
                TCLabel(record.rawKind == .none ? "developed from heif" : "developed from \(record.rawKind.rawValue)", size: 9)
            }
            Spacer()
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
    }

    private var imageArea: some View {
        ZStack {
            if comparing, let apple = appleImage {
                Image(uiImage: apple).resizable().scaledToFit()
            } else if let img = finalImage ?? stageImages[stage] ?? stageImages.values.first {
                Image(decorative: img, scale: 1, orientation: .up)
                    .resizable()
                    .scaledToFit()
                    .transition(.opacity)
                    .id(finalImage != nil ? "final" : "stage\(stage.rawValue)")
            } else {
                Rectangle().fill(Color(white: 0.04))
                    .overlay(TCLabel("developing", size: 11))
                    .aspectRatio(CGFloat(max(record.pixelWidth, 1)) / CGFloat(max(record.pixelHeight, 1)), contentMode: .fit)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: stage)
        .animation(.easeInOut(duration: 0.35), value: finalImage != nil)
        .padding(.horizontal, 12)
        .onLongPressGesture(minimumDuration: 0.15, perform: {}, onPressingChanged: { down in
            if appleImage != nil { comparing = down }
        })
    }

    private var footer: some View {
        VStack(spacing: 14) {
            TCLabel(comparing ? "apple rendering" : (developed ? (saved ? "saved to photos" : "technichrome print") : stage.caption), size: 10,
                    color: developed ? Theme.ivory : Theme.ivoryDim)
                .frame(height: 16)
            HStack(spacing: 10) {
                PillButton(title: "Save", prominent: true) { save() }
                    .disabled(!developed || saved)
                    .opacity(developed ? 1 : 0.4)
                if developed {
                    ShareLink(item: model.store.developedURL(for: record)) {
                        TCLabel("Share", size: 11, color: Theme.ivory, tracking: 2)
                            .padding(.horizontal, 16).padding(.vertical, 9)
                            .background(Capsule().fill(Color.white.opacity(0.06)))
                            .overlay(Capsule().strokeBorder(Theme.ivoryFaint, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                PillButton(title: "Lab") {
                    model.selectedPhoto = record
                    model.showsLaboratory = true
                }
                .disabled(!developed)
                .opacity(developed ? 1 : 0.4)
            }
            if appleImage != nil {
                TCLabel("hold the image to compare with apple's rendering", size: 8, color: Theme.ivoryFaint, tracking: 1.5)
            }
        }
        .padding(.bottom, 30)
    }

    // MARK: - Work

    private func run() async {
        guard let dev = model.develop else { failure = model.engineError ?? "engine unavailable"; return }
        let params = model.parameters
        let store = model.store
        let rec = record
        // Quick preview stages at reduced scale
        let stages = await Task.detached(priority: .userInitiated) { () -> [Stage: CGImage] in
            do {
                let (linear, baseline) = try dev.linearSource(for: rec, store: store, scaleFactor: 0.25, draft: true)
                let longEdge = Double(max(linear.extent.width, linear.extent.height))
                var out: [Stage: CGImage] = [:]
                for s in [Stage.key, .yellow, .cyan, .magenta] {
                    let img = dev.makePrint(linear: linear, baselineEV: baseline, parameters: params, extraEV: rec.printExposureEV,
                                            fullLongEdge: longEdge, dyeMask: s.mask, spatial: false)
                    if let cg = dev.render(img) { out[s] = cg }
                }
                return out
            } catch {
                return [:]
            }
        }.value
        stageImages = stages
        // Play the reveal while the full-resolution develop runs
        let full = Task.detached(priority: .userInitiated) { () throws -> DevelopedImage in
            try dev.developToDisk(record: rec, store: store, parameters: params, extraEV: rec.printExposureEV)
        }
        for s in [Stage.yellow, .cyan, .magenta] {
            try? await Task.sleep(for: .milliseconds(520))
            stage = s
        }
        let appleURL = store.appleURL(for: rec)
        if FileManager.default.fileExists(atPath: appleURL.path) {
            appleImage = UIImage(contentsOfFile: appleURL.path)
        }
        do {
            let result = try await full.value
            finalImage = result.image
            var updated = rec
            updated.isDeveloped = true
            updated.baselineExposure = result.baselineExposure
            updated.parameters = params
            try? store.save(updated)
            developed = true
            Haptics.success()
        } catch {
            failure = error.localizedDescription
        }
    }

    private func save() {
        Task {
            do {
                try await ExportService.saveToPhotos(record: record, store: model.store, includeRAW: true)
                saved = true
                Haptics.success()
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
