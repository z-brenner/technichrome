// swift-tools-version:5.9
// This package exposes the platform-independent colour-science core of Technichrome
// (Technichrome/Engine/Core) so it can be built and unit-tested with `swift test` on
// macOS or Linux, without Xcode. The iOS app target compiles the same source files directly.
import PackageDescription

let package = Package(
    name: "TechnichromeCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TechnichromeCore", targets: ["TechnichromeCore"]),
    ],
    targets: [
        .target(
            name: "TechnichromeCore",
            path: "Technichrome/Engine/Core"
        ),
        .testTarget(
            name: "TechnichromeCoreTests",
            dependencies: ["TechnichromeCore"],
            path: "Tests/TechnichromeCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
