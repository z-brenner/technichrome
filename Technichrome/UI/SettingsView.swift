//
//  SettingsView.swift
//  Technichrome
//
//  The few things that are settings rather than colour science.
//

import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selfTest: EngineSelfTestResult?
    @State private var testing = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    Toggle("Capture Apple's rendering alongside the RAW", isOn: $model.settings.captureCompanionHEIF)
                    Toggle("Save the DNG with the print", isOn: $model.settings.saveRAWWithPrint)
                } header: {
                    Text("Capture and export")
                } footer: {
                    Text("The companion HEIF is only used for the hold-to-compare view. The DNG is always kept inside Technichrome whether or not it is saved to Photos.")
                }
                Section {
                    if model.camera.facts.isEmpty {
                        Text("Open the camera first. This lists what the camera system reported on this iPhone.")
                            .font(Theme.body(13)).foregroundStyle(Theme.ivoryDim)
                    } else {
                        ForEach(model.camera.facts) { fact in
                            LabeledContent(fact.label) {
                                Text(fact.value).font(Theme.mono(11)).multilineTextAlignment(.trailing)
                            }
                        }
                    }
                } header: {
                    Text("Camera on this iPhone")
                } footer: {
                    Text("For the current lens: the RAW formats on offer, the photo sizes, the preview stream's colour space and HDR state, and whether the Camera Control button is present. See docs/HARDWARE_CHECKLIST.md.")
                }
                Section {
                    LabeledContent("Engine", value: model.engine == nil ? "unavailable" : "Core Image + Metal kernels")
                    LabeledContent("Look", value: model.parameters.name)
                    LabeledContent("Photographs", value: "\(model.store.records.count)")
                    Button(testing ? "Testing the engine…" : "Run engine self-test") { runSelfTest() }
                        .disabled(testing || model.engine == nil)
                    if let selfTest {
                        Text((selfTest.passed ? "Passed. " : "Failed. ") + selfTest.detail)
                            .font(Theme.mono(11)).foregroundStyle(selfTest.passed ? Theme.ivory : Theme.red)
                    }
                } header: {
                    Text("About")
                } footer: {
                    Text("Technichrome develops RAW data through a model of the three-strip Technicolor dye-transfer process: three separation negatives, gelatin matrices, three dyes, a silver key, a carbon-arc projector. Everything happens on this iPhone.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .tint(Theme.ivory)
        }
    }

    /// Renders known colours through this phone's GPU and compares with the CPU reference pipeline.
    private func runSelfTest() {
        guard let engine = model.engine else { return }
        let params = model.parameters
        testing = true
        Task.detached(priority: .userInitiated) {
            let result = EngineSelfTest.run(engine: engine, parameters: params)
            await MainActor.run { selfTest = result; testing = false }
        }
    }
}
