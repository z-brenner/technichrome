//
//  TechnichromeApp.swift
//  Technichrome
//
//  A Technicolor-inspired RAW camera. Point, photograph, develop, keep.
//

import SwiftUI

@main
struct TechnichromeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
