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
