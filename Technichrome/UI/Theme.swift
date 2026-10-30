//
//  Theme.swift
//  Technichrome
//
//  Visual identity: a dark laboratory, ivory type, one red. Restraint everywhere else.
//

import SwiftUI
import UIKit

enum Theme {
    static let background = Color.black
    static let ivory = Color(red: 0.93, green: 0.89, blue: 0.82)
    static let ivoryDim = Color(red: 0.93, green: 0.89, blue: 0.82).opacity(0.55)
    static let ivoryFaint = Color(red: 0.93, green: 0.89, blue: 0.82).opacity(0.22)
    static let red = Color(red: 0.80, green: 0.10, blue: 0.14)
    static let cyan = Color(red: 0.0, green: 0.62, blue: 0.74)
    static let magenta = Color(red: 0.80, green: 0.18, blue: 0.50)
    static let yellow = Color(red: 0.93, green: 0.78, blue: 0.20)
    static let panel = Color(white: 0.08)

    static func label(_ size: CGFloat = 11) -> Font { .system(size: size, weight: .medium, design: .serif) }
    static func wordmark(_ size: CGFloat = 15) -> Font { .system(size: size, weight: .light, design: .serif) }
    static func body(_ size: CGFloat = 15) -> Font { .system(size: size, weight: .regular, design: .serif) }
    static func mono(_ size: CGFloat = 12) -> Font { .system(size: size, weight: .regular, design: .monospaced) }
}

/// Small-caps tracking label used for every piece of chrome in the app.
struct TCLabel: View {
    let text: String
    var size: CGFloat = 11
    var color: Color = Theme.ivoryDim
    var tracking: CGFloat = 2.5

    init(_ text: String, size: CGFloat = 11, color: Color = Theme.ivoryDim, tracking: CGFloat = 2.5) {
        self.text = text; self.size = size; self.color = color; self.tracking = tracking
    }

    var body: some View {
        Text(text.uppercased())
            .font(Theme.label(size))
            .tracking(tracking)
            .foregroundStyle(color)
    }
}

struct Wordmark: View {
    var size: CGFloat = 15
    var body: some View {
        Text("TECHNICHROME")
            .font(Theme.wordmark(size))
            .tracking(size * 0.45)
            .foregroundStyle(Theme.ivory)
    }
}

enum Haptics {
    static func shutter() { UIImpactFeedbackGenerator(style: .rigid).impactOccurred() }
    static func tick() { UISelectionFeedbackGenerator().selectionChanged() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

/// A thin pill button used in toolbars.
struct PillButton: View {
    let title: String
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            TCLabel(title, size: 11, color: prominent ? Color.black : Theme.ivory, tracking: 2)
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(
                    Capsule().fill(prominent ? Theme.ivory : Color.white.opacity(0.06))
                )
                .overlay(Capsule().strokeBorder(Theme.ivoryFaint, lineWidth: prominent ? 0 : 1))
        }
        .buttonStyle(.plain)
    }
}
