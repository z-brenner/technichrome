//
//  GalleryView.swift
//  Technichrome
//

import SwiftUI

struct GalleryView: View {
    @Environment(AppModel.self) private var model
    @State private var selected: PhotoRecord?

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
                Spacer()
                VStack(spacing: 3) {
                    Wordmark(size: 12)
                    TCLabel("\(model.store.records.count) photographs", size: 9)
                }
                Spacer()
                Button {
                    model.selectedPhoto = model.store.records.first
                    model.showsLaboratory = true
                } label: {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 15, weight: .light)).foregroundStyle(Theme.ivoryDim)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .disabled(model.store.records.isEmpty)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)

            if model.store.records.isEmpty {
                Spacer()
                VStack(spacing: 10) {
                    TCLabel("no photographs yet", size: 12, color: Theme.ivory)
                    Text("Photographs you take live here, with their original RAW files.")
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
