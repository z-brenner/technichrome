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
                    LabeledContent("Engine", value: model.engine == nil ? "unavailable" : "Core Image + Metal kernels")
                    LabeledContent("Look", value: model.parameters.name)
                    LabeledContent("Photographs", value: "\(model.store.records.count)")
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
}
