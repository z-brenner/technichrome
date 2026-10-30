//
//  RootView.swift
//  Technichrome
//

import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ZStack {
            Theme.background.ignoresSafeArea()
            switch model.screen {
            case .camera:
                CameraView()
                    .transition(.opacity)
            case .gallery:
                GalleryView()
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.screen)
        .fullScreenCover(item: $model.developing) { record in
            DevelopView(record: record)
                .environment(model)
        }
        .sheet(isPresented: $model.showsSettings) {
            SettingsView()
                .environment(model)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $model.showsLaboratory) {
            LaboratoryView(record: model.selectedPhoto ?? model.store.records.first)
                .environment(model)
                .presentationDetents([.large])
        }
        .alert("Engine unavailable", isPresented: Binding(get: { model.engineError != nil },
                                                           set: { if !$0 { model.engineError = nil } })) {
            Button("OK") {}
        } message: {
            Text(model.engineError ?? "")
        }
    }
}
