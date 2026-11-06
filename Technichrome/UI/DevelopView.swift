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
    /// A failed save (Photos access denied, for example) keeps the develop screen open, unlike `failure`.
    @State private var saveError: String?
    @State private var saved = false
    @State private var comparing = false
    @State private var appleImage: UIImage?
    @State private var showsLab = false

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
        .alert("Could not save to Photos", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("OK") {}
        } message: { Text(saveError ?? "") }
        // Presented from this cover, not from RootView: RootView is already presenting the cover and UIKit lets a
        // view controller present one modal at a time, so a sheet requested there is dropped.
        .sheet(isPresented: $showsLab) {
            // The stored record, which carries the print timing and parameters this develop wrote.
            LaboratoryView(record: model.store.record(id: record.id) ?? record)
                .environment(model)
                .presentationDetents([.large])
        }
    }

    private var header: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivory)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            Spacer()
            VStack(spacing: 3) {
                Wordmark(size: 12)
                TCLabel(record.rawKind == .none ? "developed without raw" : "developed from \(record.rawKind.rawValue)", size: 9)
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
                PillButton(title: "Lab") { showsLab = true }
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
        // One quick decode, materialised (see DevelopService.quickSource), gives the print timing and the four
        // stages of the reveal. If it fails, the full develop below reports why.
        let quick = await Task.detached(priority: .userInitiated) { () -> (CIImage, Double, Double)? in
            guard let source = try? dev.quickSource(for: rec, store: store) else { return nil }
            let (linear, baseline) = source
            let timing = dev.measureTiming(linear: linear, baselineEV: baseline, parameters: params, cameraBiasEV: Double(rec.exposureBias))
            return (linear, baseline, timing)
        }.value
        var timed = rec
        timed.printTimingEV = quick?.2 ?? 0
        try? store.save(timed)
        let timedRecord = timed
        // The full-resolution develop needs only the timing, so it starts now, while the stages are rendered.
        let full = Task.detached(priority: .userInitiated) { () throws -> DevelopedImage in
            try dev.developToDisk(record: timedRecord, store: store, parameters: params, extraEV: timedRecord.totalPrintEV)
        }
        if let quick {
            let (linear, baseline, timing) = quick
            stageImages = await Task.detached(priority: .userInitiated) { () -> [Stage: CGImage] in
                let longEdge = Double(max(linear.extent.width, linear.extent.height))
                var out: [Stage: CGImage] = [:]
                for s in [Stage.key, .yellow, .cyan, .magenta] {
                    let img = dev.makePrint(linear: linear, baselineEV: baseline, parameters: params, extraEV: rec.printExposureEV + timing,
                                            fullLongEdge: longEdge, dyeMask: s.mask, spatial: false)
                    if let cg = dev.render(img) { out[s] = cg }
                }
                return out
            }.value
        }
        // Play the reveal while the full-resolution develop runs
        for s in [Stage.yellow, .cyan, .magenta] {
            try? await Task.sleep(for: .milliseconds(520))
            stage = s
        }
        // Apple's rendering, decoded off the main thread at screen size (it is only compared on screen; at full
        // size a 48 MP companion would be a 195 MB bitmap decoded on the main thread when first drawn).
        let appleURL = store.appleURL(for: rec)
        if FileManager.default.fileExists(atPath: appleURL.path),
           let companion = await Task.detached(priority: .utility, operation: { DevelopService.decodeDownscaled(appleURL, maxPixelSize: 2048) }).value {
            appleImage = UIImage(cgImage: companion)
        }
        do {
            let result = try await full.value
            finalImage = result.image
            var updated = timedRecord
            updated.isDeveloped = true
            updated.baselineExposure = result.baselineExposure
            updated.parameters = params
            updated.decoderVersion = result.decoderVersion     // pinned for re-develops (RAWDeveloper.configure)
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
                try await ExportService.saveToPhotos(record: record, store: model.store, includeRAW: model.settings.saveRAWWithPrint)
                saved = true
                Haptics.success()
            } catch {
                saveError = error.localizedDescription
                Haptics.error()
            }
        }
    }
}
