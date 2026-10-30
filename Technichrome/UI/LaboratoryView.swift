//
//  LaboratoryView.swift
//  Technichrome
//
//  The colour laboratory: every engine parameter, live on the current photograph. This is the
//  internal tool for refining the look against reference material; it is deliberately plain.
//

import SwiftUI
import CoreImage

struct LaboratoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let record: PhotoRecord?

    @State private var params: EngineParameters = .default
    @State private var preview: CGImage?
    @State private var linearCache: (CIImage, Double, Double)?   // image, baseline, long edge
    @State private var renderTask: Task<Void, Never>?
    @State private var busy = false
    @State private var message: String?
    @State private var exportURL: URL?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                previewArea
                Form {
                    exposureSection
                    cameraSection
                    negativeSection
                    matrixSection
                    keySection
                    printSection
                    spatialSection
                    actionsSection
                }
                .scrollContentBackground(.hidden)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Laboratory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Set as default") { model.saveParametersAsDefault(params); Haptics.success(); message = "These parameters are now the default for new photographs and the live preview." }
                }
            }
            .tint(Theme.ivory)
        }
        .onAppear { params = model.parameters; loadSource() }
        .onChange(of: params) { _, _ in scheduleRender() }
        .alert("Laboratory", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) { Button("OK") {} } message: { Text(message ?? "") }
    }

    // MARK: - Preview

    private var previewArea: some View {
        ZStack {
            Color(white: 0.04)
            if let preview {
                Image(decorative: preview, scale: 1, orientation: .up).resizable().scaledToFit()
            } else {
                TCLabel(record == nil ? "take a photograph to see it here" : "rendering", size: 10)
            }
            if busy {
                VStack { Spacer(); HStack { Spacer(); ProgressView().tint(Theme.ivory).padding(10) } }
            }
        }
        .frame(height: 260)
    }

    private func loadSource() {
        guard let record, let dev = model.develop else { return }
        let store = model.store
        Task.detached(priority: .userInitiated) {
            if let (img, baseline) = try? dev.linearSource(for: record, store: store, scaleFactor: 0.25, draft: true) {
                let longEdge = Double(max(img.extent.width, img.extent.height))
                await MainActor.run {
                    linearCache = (img, baseline, longEdge)
                    scheduleRender()
                }
            }
        }
    }

    private func scheduleRender() {
        renderTask?.cancel()
        guard let (img, baseline, longEdge) = linearCache, let dev = model.develop, let record else { return }
        let p = params
        busy = true
        renderTask = Task.detached(priority: .userInitiated) {
            try? await Task.sleep(for: .milliseconds(60))
            if Task.isCancelled { return }
            let out = dev.makePrint(linear: img, baselineEV: baseline, parameters: p, extraEV: record.totalPrintEV, fullLongEdge: longEdge)
            let cg = dev.render(out)
            if Task.isCancelled { return }
            await MainActor.run { preview = cg; busy = false }
        }
    }

    // MARK: - Sections

    private var exposureSection: some View {
        Section("Exposure") {
            slider("Print exposure", $params.exposureEV, -2...2, step: 0.05, format: "%+.2f EV")
            slider("Viewing compensation", $params.surroundExponent, 0.7...1.1, step: 0.01, format: "γ %.2f")
            slider("Timing strength", $params.timingStrength, 0...1, step: 0.05, format: "%.2f")
            slider("Timing target (scene key)", $params.timingTarget, 0.08...0.3, step: 0.005, format: "%.3f")
            if let record {
                Text(String(format: "This photograph was timed %+.2f EV at develop time; the preview uses that value.", record.printTimingEV))
                    .font(.footnote).foregroundStyle(Theme.ivoryDim)
            }
        }
    }

    private var cameraSection: some View {
        Section("Three-strip camera") {
            matrixRow("Red record", 0)
            matrixRow("Green record", 1)
            matrixRow("Blue record", 2)
            Text("Rows are the response of each separation record to linear sRGB R, G, B. Derived from assumed filter/emulsion sensitivities; rows should sum to 1.")
                .font(.footnote).foregroundStyle(Theme.ivoryDim)
        }
    }

    private func matrixRow(_ title: String, _ r: Int) -> some View {
        HStack {
            TCLabel(title, size: 9).frame(width: 90, alignment: .leading)
            ForEach(0..<3, id: \.self) { c in
                TextField("", value: Binding(get: { params.separationMatrix[r * 3 + c] },
                                              set: { params.separationMatrix[r * 3 + c] = $0 }), format: .number.precision(.fractionLength(4)))
                    .keyboardType(.decimalPad)
                    .font(Theme.mono(12))
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private var negativeSection: some View {
        Section("Separation negatives") {
            slider("Gamma", $params.negative.gamma, 0.3...1.2, step: 0.01, format: "%.2f")
            slider("Speed point (log E)", $params.negative.logE0, -2.5...0.5, step: 0.01, format: "%.2f")
            slider("Asymmetry ν", $params.negative.nu, 0.05...3, step: 0.01, format: "%.2f")
            slider("D min", $params.negative.dMin, 0...0.5, step: 0.01, format: "%.2f")
            slider("D max", $params.negative.dMax, 1...3.5, step: 0.05, format: "%.2f")
        }
    }

    private var matrixSection: some View {
        Section("Matrices and dye transfer") {
            slider("Matrix gamma", $params.matrixGamma, 1...6, step: 0.01, format: "%.2f")
            slider("Printing light (log E)", $params.matrixLogE0, -2.5...0, step: 0.01, format: "%.2f")
            slider("Asymmetry ν", $params.matrixNu, 0.05...3, step: 0.01, format: "%.2f")
            dyeRow("Cyan D max", $params.dyeDMax[0]); dyeRow("Magenta D max", $params.dyeDMax[1]); dyeRow("Yellow D max", $params.dyeDMax[2])
            gainRow("Cyan gain", $params.dyeGain[0]); gainRow("Magenta gain", $params.dyeGain[1]); gainRow("Yellow gain", $params.dyeGain[2])
        }
    }

    private func dyeRow(_ t: String, _ b: Binding<Double>) -> some View { slider(t, b, 1...3.5, step: 0.05, format: "%.2f") }
    private func gainRow(_ t: String, _ b: Binding<Double>) -> some View { slider(t, b, 0.5...1.5, step: 0.005, format: "%.3f") }

    private var keySection: some View {
        Section("Silver key image (1932–c.1944)") {
            slider("Key strength", $params.keyStrength, 0...1, step: 0.01, format: "%.2f")
            slider("Key gamma", $params.key.gamma, 0.2...2, step: 0.01, format: "%.2f")
            slider("Key printing light", $params.key.logE0, -2.5...0, step: 0.01, format: "%.2f")
            slider("Key D max", $params.key.dMax, 0.2...2.5, step: 0.05, format: "%.2f")
        }
    }

    private var printSection: some View {
        Section("Print and projection") {
            slider("Projector colour temperature", $params.projectorCCT, 3200...7000, step: 50, format: "%.0f K")
            slider("Base density", $params.printDMin, 0...0.3, step: 0.005, format: "%.3f")
            dyeLobeRow("Cyan peak", lobeBinding(\.cyan, 0, \.mu), 580...700)
            dyeLobeRow("Cyan green absorption", lobeBinding(\.cyan, 1, \.amplitude), 0...0.6)
            dyeLobeRow("Cyan blue absorption", lobeBinding(\.cyan, 2, \.amplitude), 0...0.6)
            dyeLobeRow("Magenta peak", lobeBinding(\.magenta, 0, \.mu), 500...600)
            dyeLobeRow("Magenta blue absorption", lobeBinding(\.magenta, 1, \.amplitude), 0...0.6)
            dyeLobeRow("Yellow peak", lobeBinding(\.yellow, 0, \.mu), 400...490)
            dyeLobeRow("Yellow green tail", lobeBinding(\.yellow, 1, \.amplitude), 0...0.4)
        }
    }

    private func lobeBinding(_ dye: WritableKeyPath<EngineParameters, DyeSpectrum>, _ index: Int, _ field: WritableKeyPath<DyeLobe, Double>) -> Binding<Double> {
        Binding(get: { params[keyPath: dye].lobes.indices.contains(index) ? params[keyPath: dye].lobes[index][keyPath: field] : 0 },
                set: { v in if params[keyPath: dye].lobes.indices.contains(index) { params[keyPath: dye].lobes[index][keyPath: field] = v } })
    }

    private func dyeLobeRow(_ t: String, _ b: Binding<Double>, _ range: ClosedRange<Double>) -> some View {
        slider(t, b, range, step: range.upperBound > 10 ? 1 : 0.01, format: range.upperBound > 10 ? "%.0f nm" : "%.2f")
    }

    private var spatialSection: some View {
        Section("Spatial") {
            slider("Dye diffusion (px @ 4K)", $params.diffusionSigmaAt4K, 0...4, step: 0.05, format: "%.2f px")
            slider("Misregistration (px @ 4K)", $params.misregistrationAt4K, 0...3, step: 0.05, format: "%.2f px")
            slider("Halation", $params.bloomAmount, 0...0.5, step: 0.005, format: "%.3f")
            slider("Halation threshold", $params.bloomThreshold, 0.3...1.5, step: 0.01, format: "%.2f")
            slider("Halation radius (% of edge)", $params.bloomRadiusPercent, 0.2...5, step: 0.1, format: "%.1f %%")
        }
    }

    private var actionsSection: some View {
        Section {
            Button("Reset to Technichrome v1") { params = .default; model.resetParameters() }
            if let record {
                Button("Re-develop this photograph with these parameters") { redevelop(record) }
            }
            if let url = exportURL {
                ShareLink("Share parameters as JSON", item: url)
            } else {
                Button("Export parameters as JSON") { exportJSON() }
            }
        } footer: {
            Text("Parameters marked as approximations in docs/COLOR_SCIENCE.md are starting points for comparison against reference frames, not measurements.")
        }
    }

    // MARK: - Helpers

    private func slider(_ title: String, _ value: Binding<Double>, _ range: ClosedRange<Double>, step: Double, format: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(Theme.body(13)).foregroundStyle(Theme.ivory)
                Spacer()
                Text(String(format: format, value.wrappedValue)).font(Theme.mono(12)).foregroundStyle(Theme.ivoryDim)
            }
            Slider(value: value, in: range, step: step)
        }
    }

    private func redevelop(_ record: PhotoRecord) {
        guard let dev = model.develop else { return }
        let p = params
        let store = model.store
        busy = true
        Task.detached(priority: .userInitiated) {
            do {
                let result = try dev.developToDisk(record: record, store: store, parameters: p, extraEV: record.totalPrintEV)
                await MainActor.run {
                    var r = record
                    r.parameters = p; r.isDeveloped = true; r.baselineExposure = result.baselineExposure
                    try? store.save(r)
                    busy = false
                    message = "Re-developed at full resolution."
                    Haptics.success()
                }
            } catch {
                await MainActor.run { busy = false; message = error.localizedDescription }
            }
        }
    }

    private func exportJSON() {
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Technichrome-parameters.json")
            try params.jsonData().write(to: url, options: .atomic)
            exportURL = url
        } catch {
            message = error.localizedDescription
        }
    }
}
