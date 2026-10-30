//
//  ShutterButton.swift
//  Technichrome
//

import SwiftUI

struct ShutterButton: View {
    var isBusy: Bool
    let action: () -> Void
    @State private var pressed = false

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(Theme.ivory.opacity(0.75), lineWidth: 2)
                .frame(width: 78, height: 78)
            // The three-strip motif: three faint arcs in the dye colours, only while the camera works.
            if isBusy {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .trim(from: 0.05, to: 0.28)
                        .stroke([Theme.cyan, Theme.magenta, Theme.yellow][i].opacity(0.9), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .frame(width: 78, height: 78)
                        .rotationEffect(.degrees(Double(i) * 120))
                }
                .rotationEffect(.degrees(pressed ? 360 : 0))
                .animation(.linear(duration: 1.6).repeatForever(autoreverses: false), value: pressed)
                .onAppear { pressed = true }
                .onDisappear { pressed = false }
            }
            Circle()
                .fill(Theme.red)
                .frame(width: 60, height: 60)
                .scaleEffect(pressed && !isBusy ? 0.86 : 1.0)
                .opacity(isBusy ? 0.35 : 1.0)
        }
        .contentShape(Circle())
        .onTapGesture {
            guard !isBusy else { return }
            action()
        }
        .onLongPressGesture(minimumDuration: 0.0, maximumDistance: 40, perform: {}, onPressingChanged: { down in
            guard !isBusy else { return }
            withAnimation(.spring(response: 0.18, dampingFraction: 0.7)) { pressed = down }
        })
        .accessibilityLabel("Shutter")
    }
}
