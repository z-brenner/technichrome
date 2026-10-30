//
//  AppModel.swift
//  Technichrome
//
//  Application state: the engine, the library, the camera, the current parameters and navigation.
//

import SwiftUI
import Observation
import CoreImage

@MainActor
@Observable
final class AppModel {
    enum Screen: Equatable {
        case camera
        case gallery
    }

    let engine: TechnichromeEngine?
    let develop: DevelopService?
    let store = PhotoStore()
    let camera = CameraService()
    var parameters: EngineParameters
    var engineError: String?
    var screen: Screen = .camera
    /// A capture that is being developed / reviewed.
    var developing: PhotoRecord?
    var selectedPhoto: PhotoRecord?
    var showsLaboratory = false
    var showsSettings = false
    var settings = AppSettings.load() {
        didSet {
            settings.save()
            camera.captureCompanionHEIF = settings.captureCompanionHEIF
        }
    }

    private static let parametersKey = "technichrome.parameters.v1"

    init() {
        do {
            let e = try TechnichromeEngine(lutDimension: 33)
            engine = e
            develop = DevelopService(engine: e)
        } catch {
            engine = nil
            develop = nil
            engineError = error.localizedDescription
        }
        if let data = UserDefaults.standard.data(forKey: Self.parametersKey), let p = try? EngineParameters.fromJSON(data) {
            parameters = p
        } else {
            parameters = .default
        }
        camera.captureCompanionHEIF = settings.captureCompanionHEIF
    }

    func saveParametersAsDefault(_ p: EngineParameters) {
        parameters = p
        if let data = try? p.jsonData() { UserDefaults.standard.set(data, forKey: Self.parametersKey) }
    }

    func resetParameters() {
        parameters = .default
        UserDefaults.standard.removeObject(forKey: Self.parametersKey)
    }
}

struct AppSettings: Codable, Equatable {
    var captureCompanionHEIF = true
    var saveRAWWithPrint = true

    private static let key = "technichrome.settings.v1"

    static func load() -> AppSettings {
        if let data = UserDefaults.standard.data(forKey: key), let s = try? JSONDecoder().decode(AppSettings.self, from: data) {
            return s
        }
        return AppSettings()
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
