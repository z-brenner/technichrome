//
//  GalleryView.swift
//  Technichrome
//

import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct GalleryView: View {
    @Environment(AppModel.self) private var model
    @State private var selected: PhotoRecord?
    @State private var choosingImport = false
    @State private var showsPhotosPicker = false
    @State private var showsFileImporter = false
    @State private var pickedItem: PhotosPickerItem?
    @State private var importError: String?

    private let columns = [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    model.screen = .camera
                } label: {
                    Image(systemName: "chevron.left").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivory)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to camera")
                Spacer()
                VStack(spacing: 3) {
                    Wordmark(size: 12)
                    TCLabel("\(model.store.records.count) photographs", size: 9)
                }
                Spacer()
                HStack(spacing: 0) {
                    Button {
                        choosingImport = true
                    } label: {
                        Image(systemName: "square.and.arrow.down").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivoryDim)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Import a photograph")
                    Button {
                        model.showsSettings = true
                    } label: {
                        Image(systemName: "gearshape").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivoryDim)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Settings")
                    Button {
                        model.selectedPhoto = model.store.records.first
                        model.showsLaboratory = true
                    } label: {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivoryDim)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Laboratory")
                    .disabled(model.store.records.isEmpty)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)

            if model.store.records.isEmpty {
                Spacer()
                VStack(spacing: 10) {
                    TCLabel("no photographs yet", size: 12, color: Theme.ivory)
                    Text("Photographs you take live here, with their original RAW files. A DNG from Photos or Files can be imported and developed too.")
                        .font(Theme.body(14)).foregroundStyle(Theme.ivoryDim).multilineTextAlignment(.center)
                }
                .padding(40)
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(model.store.records) { r in
                            Thumbnail(record: r)
                                .onTapGesture { selected = r }
                        }
                    }
                    .padding(.top, 8)
                }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .fullScreenCover(item: $selected) { r in
            PhotoDetailView(record: r)
                .environment(model)
        }
        .onAppear { model.store.reload() }
        .confirmationDialog("Import a photograph", isPresented: $choosingImport, titleVisibility: .visible) {
            Button("From Photos") { showsPhotosPicker = true }
            Button("From Files") { showsFileImporter = true }
        } message: {
            Text("A DNG keeps its RAW data and is labelled from its own tags (Bayer, ProRAW or linear). Any other image is developed as display-referred data.")
        }
        .photosPicker(isPresented: $showsPhotosPicker, selection: $pickedItem, matching: .images)
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            pickedItem = nil
            importPicked(item)
        }
        .fileImporter(isPresented: $showsFileImporter, allowedContentTypes: [.rawImage, .image]) { result in
            importFile(result)
        }
        .alert("Import failed", isPresented: Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })) {
            Button("OK") {}
        } message: { Text(importError ?? "") }
    }

    // MARK: - Import

    private func importPicked(_ item: PhotosPickerItem) {
        Task {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { throw ImportError.notAnImage }
                try await importData(data)
            } catch {
                importError = error.localizedDescription
            }
        }
    }

    private func importFile(_ result: Result<URL, Error>) {
        Task {
            do {
                let url = try result.get()
                let data = try await Task.detached(priority: .userInitiated) { () throws -> Data in
                    let secured = url.startAccessingSecurityScopedResource()
                    defer { if secured { url.stopAccessingSecurityScopedResource() } }
                    return try Data(contentsOf: url)
                }.value
                try await importData(data)
            } catch {
                importError = error.localizedDescription
            }
        }
    }

    private func importData(_ data: Data) async throws {
        let record = try await model.store.add(importedData: data)
        Haptics.tick()
        model.developing = record
    }
}

struct Thumbnail: View {
    @Environment(AppModel.self) private var model
    let record: PhotoRecord

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color(white: 0.06)
                if let ui = UIImage(contentsOfFile: model.store.thumbnailURL(for: record).path) {
                    Image(uiImage: ui).resizable().scaledToFill()
                } else {
                    TCLabel("undeveloped", size: 8)
                }
            }
            .frame(width: geo.size.width, height: geo.size.width)
            .clipped()
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
