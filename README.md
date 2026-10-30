# Technichrome

A native iPhone camera that captures RAW and develops it through a model of the three-strip
Technicolor dye-transfer process. One look, built from the physics of the process rather than from a
filter: separation negatives, gelatin matrices, three dyes, a silver key, a carbon-arc projector.

* `docs/COLOR_SCIENCE.md` — the rendering model, what is historically documented and what is our approximation, and how to keep refining it.
* `docs/RAW_PIPELINE.md` — Bayer RAW versus Apple ProRAW, what the decoder is allowed to do, capture policy, limits.
* `docs/HARDWARE_CHECKLIST.md` — what to check, in order, on the first run on a real iPhone, and what to report back.
* `CHANGELOG.md` — what each round of work added.

## What it does

1. Open Technichrome. The live preview already shows the look (an approximation, computed from the video feed).
2. Point. Tap to focus and expose, long-press to lock both, drag vertically for exposure compensation (it reaches the print in full; print timing corrects only the camera's own placement), double-tap to reset. Choose a lens (0.5×, 1×, telephoto).
   On an iPhone 16 the Camera Control button offers the same two settings (exposure in thirds of a stop, lens).
3. Photograph, on screen or with a volume button or the Camera Control button (iOS 17.2 and later). The app captures **Bayer RAW** (DNG) on any physical back camera that offers it, Apple ProRAW where Bayer is unavailable, HEIF as a last resort. The RAW is preserved untouched.
4. Develop. The RAW is decoded to scene-linear data with every Apple "look" stage disabled, then printed by the engine on the GPU — you watch the silver key, then yellow, cyan and magenta go down in the order Ball described in 1935.
5. Keep. Save the print (Display P3 JPEG, carrying the original's camera and exposure tags) and the DNG to Photos, share either, or open the Laboratory to adjust every engine parameter on the photograph and re-develop.
6. Import. A DNG from Photos or Files (a ProRAW, a file from another camera) is developed the same way; its own tags say whether it holds Bayer sensor data or already-demosaiced linear data, and the record says which.

Everything runs on the phone. No accounts, no network, no presets — one meticulously tuned look, adjustable internally.

## Repository layout

```
Technichrome.xcodeproj/        Xcode 16 project (file-system-synchronised; add files by dropping them in)
Config/Info.plist              camera + photo-library usage strings, portrait only
Technichrome/
  App/                         app entry, model, root navigation
  Capture/                     AVFoundation session, RAW policy, Metal/Core Image live preview
  Engine/
    Core/                      platform-independent colour science (also a SwiftPM package for `swift test`)
    Kernels/Technichrome.metal Core Image kernels (per-pixel maths of the model)
    TechnichromeEngine.swift   Core Image graph: separation → densities → diffusion → dye cube → print
    RAWDeveloper.swift         CIRAWFilter configured for a linear decode
    DevelopService.swift       quick previews, full-resolution develop, JPEG/thumbnail writing
  Library/                     on-device photo store (DNG + print + metadata), Photos export
  UI/                          SwiftUI screens: camera, develop reveal, gallery, detail, laboratory
  Resources/                   asset catalogue, app icon
Tests/TechnichromeCoreTests/   unit tests incl. parity against the Python prototype (fixture JSON)
tools/colorscience/            Python prototype of the engine, charts, fitting and calibration tools
docs/                          colour science and RAW pipeline notes
```

## Building

Requirements: Xcode 16 or later, iOS 17 or later, a physical iPhone (the simulator has no camera and
no RAW; the app still launches and shows the gallery/laboratory).

1. Open `Technichrome.xcodeproj`.
2. Select the `Technichrome` target, set your Team under *Signing & Capabilities* (bundle id `com.technichrome.camera`, change as needed).
3. Build and run on the phone.

The Metal file is compiled as a Core Image kernel library (`MTL_COMPILER_FLAGS = -fcikernel`,
`MTLLINKER_FLAGS = -cikernel`, already set in the project). If you add ordinary Metal compute shaders,
put them in a second target.

### Continuous integration

`.github/workflows/ci.yml` runs three jobs: the Swift core tests on Linux, the Python prototype checks
(the committed parity fixture must reproduce from the prototype's defaults, and the look invariants must
hold), and, on pull requests and manual dispatch only, an unsigned `xcodebuild` of the iOS target on a
macOS runner. The macOS job is the first real compile of the iOS sources; it is gated to pull requests
because macOS minutes are billed at 10× on private repositories.

### Testing the colour science without Xcode

The engine core is plain Swift. On macOS or Linux with a Swift 5.9+ toolchain:

```
swift test
```

runs 13 tests, including a parity check of the Swift engine against the Python prototype
(`Tests/TechnichromeCoreTests/Fixtures/parity.json`, generated by `tools/colorscience/export_fixtures.py`).

The Python tools need `numpy scipy pillow rawpy`:

```
cd tools/colorscience
python3 make_charts.py out/                      # ColorChecker, hue sweep, grey and skin ramps
python3 develop_dng.py photo.dng out/photo --autoexpose   # real iPhone DNG → print (LibRaw linear decode)
python3 develop_png.py out/ image.png            # display-referred test images
python3 fit_tone.py                              # refit the tone scale to the target grey scale
python3 check_prototype.py                       # what CI runs: fixture reproduction + invariants
python3 set_params.py mat_gamma=3.2 --calibrate  # edit defaults, recalibrate neutral dye gains
python3 sync_swift.py                            # push the defaults into EngineParameters.swift
```

## What CI verifies

Every pull request compiles the iOS app on a macOS runner and runs the app's own unit tests on an iPhone
simulator: the Core Image/Metal engine is rendered on known scene-linear values and compared pixel by
pixel with the CPU reference pipeline (worst error 0.0023 in display-linear units), the misregistration
path is checked on a uniform image, the develop reveal's dye order is checked, and the timing measurement
is checked against its formula. The Linux job runs the 27 core tests, including parity with the Python
prototype and the DNG tag parser; the Python job checks that the committed fixture reproduces from the prototype's defaults.

## Design

Black laboratory, ivory serif type with wide tracking, one red. The shutter is a red disc in an ivory
ring; while the camera works, three thin arcs in cyan, magenta and yellow turn around it. The develop
screen builds the print in dye order. Nothing else competes with the photograph.

## Status and what is untested

This repository was produced without access to a Mac, Xcode or an iPhone. What has been verified:

* The colour-science core compiles and its tests pass on Linux (Swift 6.1 toolchain, Swift 5 language mode): 27 tests.
* The iOS app compiles on a macOS runner (Xcode 16, iOS 18 SDK) and its GPU parity tests pass on an iPhone simulator.
* Review passes (ours and Codex's) found and fixed: a `swift test` failure masked by a pipe, print timing
  measured before the preset was loaded in the Python developer, and the items below.
* A self-review pass found and fixed: alpha summing in the misregistration path, RAW formats queried before the
  session configuration was committed, a capture continuation that could lock the shutter, a triple full-resolution
  render in the develop step, main-thread file writes, and an undismissable alert.
* The Swift engine matches the Python prototype to 1e-7 on 32 sample colours.
* The look was developed on real iPhone Bayer DNGs (LibRaw decode) and on standard test images; charts and
  renders live in `tools/colorscience` outputs.
* The Xcode project file is structurally valid (balanced, all references resolve) and uses Xcode 16's
  synchronised folders, so no file list can go stale.

What has **not** been verified and needs a device:

* Running on a physical iPhone. The app compiles and its engine tests pass on the simulator, but the camera,
  the hardware buttons (volume, Camera Control) and the RAW decoder have only been exercised in code review.
* That `CIRAWFilter` at `boostAmount = 0` places diffuse white where the engine expects it. The Python
  path uses LibRaw; Apple's decoder may differ by a constant exposure offset. Print timing absorbs most of
  it; adjust `exposureEV` in the Laboratory for the rest and make it the default.
* Bayer RAW availability per device/lens, 12 MP vs 48 MP behaviour, and ProRAW fallback.
* Live-preview performance (Core Image graph on 1080p frames at 30 fps) and full-resolution develop time/memory.
* The Photos export pairing (print JPEG + DNG as separate assets).
* Tap-to-focus coordinate mapping with the rotated preview.
* Camera Control: that the exposure slider and the lens picker appear and stay in step with the on-screen
  controls (the session queue is the controls' action queue, as the API requires).

## Roadmap for the engine

* Own Metal demosaic from the Bayer buffer, applying the separation model before any camera matrix.
* Spectral upsampling of the camera data instead of a 3×3 separation matrix.
* Measured dye spectra, if access to a dye-transfer print and a spectrophotometer can be arranged.
* Calibration of the shipped parameters against reference frames of known provenance, using the
  Laboratory's split-screen comparison against a scanned frame.
