# RAW pipeline

Technichrome never applies its look to an already-rendered JPEG. Every photograph is captured as
RAW data and developed from scene-linear values by the engine. This document explains what the
app captures, what Apple's decoder does for us, what it is told *not* to do, and where the limits are.

## Bayer RAW versus Apple ProRAW

| | Bayer RAW (DNG) | Apple ProRAW (linear DNG) |
|---|---|---|
| What it is | The sensor's colour-filter-array samples, one value per photosite, black level and white level as recorded, plus the camera's colour matrices and as-shot neutral in DNG tags. | A demosaiced, 12-bit linear RGB image ("linear DNG") that Apple's image pipeline produced by fusing several frames (Deep Fusion / Smart HDR style processing), with semantic mattes optionally embedded. |
| Processing applied before the file | Lens shading map and distortion are described by opcodes but not baked in; no noise reduction, no demosaic, no tone mapping. | Demosaic, multi-frame fusion, noise reduction and local detail processing are baked in. Still *scene-referred* (no tone curve), so it remains a valid input for our engine. |
| Availability | iOS 10+, physical single cameras only (wide, ultra-wide, telephoto). Not on virtual multi-camera devices and not with digital zoom. | iOS 14.3+, iPhone 12 Pro and later Pro models; also virtual devices. |
| Resolution on 48 MP sensors | To our knowledge 12 MP (binned) on current Pro phones through AVFoundation; 48 MP is only offered through ProRAW/HEIF. Needs confirmation on hardware. | 12 or 48 MP. |
| Technichrome policy | **Preferred.** Closest to the photons; the three-strip model is applied to the least-processed data available. | **Fallback** when the selected camera offers no Bayer format (and the device supports ProRAW). |
| Last resort | — | HEIF. The engine still runs, but on display-referred data (Apple's tone mapping is inverted approximately). The UI labels the result "developed from HEIF". |

Sources: Apple, *Capturing photos in RAW and Apple ProRAW formats*; `AVCapturePhotoOutput.isAppleProRAWEnabled`
("Compared to photos taken in Bayer RAW format, the system demosaics and partially processes Apple ProRAW
photos. They're still scene-referred"); WWDC21 session 10160.

## Capture (CameraService.swift)

1. Session preset `.photo`; physical back cameras discovered with `AVCaptureDevice.DiscoverySession`
   (`builtInUltraWideCamera`, `builtInWideAngleCamera`, `builtInTelephotoCamera`). Virtual devices are
   never used, because they cannot deliver Bayer RAW.
2. After the photo output is attached, `availableRawPhotoPixelFormatTypes` is filtered with
   `AVCapturePhotoOutput.isBayerRAWPixelFormat(_:)`. If a Bayer format exists it is used.
   Only when none exists and `isAppleProRAWSupported` is true is `isAppleProRAWEnabled` switched on
   (before `startRunning()`, as Apple recommends) and the ProRAW format used. Back on a lens with a Bayer
   format, ProRAW is switched off again, so the pipeline is not left in its ProRAW configuration.
3. `videoZoomFactor` is pinned to 1.0 (Bayer RAW throws with digital zoom).
4. `maxPhotoDimensions` is set to the 12 MP size by default — the size every lens offers to Bayer RAW and the
   binned readout of 48 MP sensors — or to the largest size the format offers when *Request full sensor
   resolution* is on in Settings. It is chosen after the configuration is committed, from the active
   format (Apple: the size must be one of the *current* active format's), next to the RAW policy and before
   `startRunning()` on the first start. Whether Bayer RAW is delivered at 48 MP, or only ProRAW and HEIF, is
   untested; the Settings diagnostics show what was asked for.
   A lens change is one configuration of the running session: the new input is made first, the old one is
   removed, and it is put back if the session refuses the new one (Apple's AVCam does the same), so the
   session is never left without a camera.
5. `AVCapturePhotoSettings(rawPixelFormatType:processedFormat:)` requests the RAW plus an HEVC companion.
   The companion is Apple's rendering; it is stored only so the Laboratory can compare the Technichrome
   print against it (hold the image). It never feeds the engine.
6. `AVCapturePhoto.fileDataRepresentation()` on the RAW photo returns a DNG, written untouched to the
   photo's folder as `original.dng`. The DNG is the preserved original; it can be shared from the app
   or saved to Photos next to the print.

The session's state is observed, not assumed: its running and interrupted flags (KVO), its runtime-error
and interruption notifications, and the device's system-pressure level. A media-services reset restarts
the session once per start, and only if the camera is meant to be running; other errors and interruptions
are shown over the preview and the shutter waits. From `.serious` pressure the preview stream is throttled
to 15–20 fps (Apple's recommendation and AVCam's values) and from `.critical` the preview is drawn plain;
photographs are unaffected. The camera is stopped while the develop screen or a sheet covers it.

The live preview receives frames in the sensor's native orientation (the video connection's rotation
angle is 0, as Apple advises for apps that rotate buffers themselves) and turns them upright in Core Image
with `oriented(.right)`, the rotation the connection used to apply to every buffer.

## Importing files (PhotoImporter.swift, DNGInspector.swift)

The gallery imports a file from Photos or Files. The file is stored untouched and labelled from its own
tags, read by a small TIFF/DNG parser (`DNGInspector`, unit-tested on Linux): the main image's
`PhotometricInterpretation` is 32803 (colour filter array) for genuine sensor data — labelled **Bayer
RAW** — or 34892 (linear, already demosaiced) — labelled **Apple ProRAW** when the maker tags say Apple,
**Linear DNG** otherwise. A DNG of either kind goes through the same linear decoder as a capture. Any
other image (HEIF, JPEG, TIFF) is accepted too and developed as display-referred data, like the HEIF
fallback of a capture, and the record says so. A file from Files is mapped for the inspection and copied by
the file system, never read whole into memory; one from Photos still arrives as data.

## What the print carries

The developed JPEG carries the original's camera, exposure, lens and date EXIF tags and a
`Software = Technichrome` tag, so Photos shows the provenance of the print. Location tags are never
copied; orientation is not copied either, because the print is rendered upright. The simulator test
`DevelopEndToEndTests` checks this on the synthetic DNGs (the Software and camera-model tags, no GPS, no
orientation, a Display P3 profile), along with the print's size and the thumbnail's.

## Linear decode (RAWDeveloper.swift)

Apple's RAW decoder (`CIRAWFilter`) is used for black-level subtraction, linearisation, lens-shading
and distortion correction, demosaicing, noise reduction, as-shot white balance and the camera matrix.
Every stage that imposes a *look* is disabled:

| Property | Value | Why |
|---|---|---|
| `boostAmount` | 0 | Apple: "A value of 0 indicates no global tone curve (linear response)." |
| `boostShadowAmount` | 0 | No shadow lift. |
| `localToneMapAmount` | 0 | No local tone mapping. |
| `isGamutMappingEnabled` | false | Out-of-sRGB colours are kept (negative/extended components in the working space); the engine decides gamut handling in P3. |
| `extendedDynamicRangeAmount` | 0 | No HDR styling. |
| `baselineExposure`, `exposure` | 0 | The DNG `BaselineExposure` is read first and applied by the engine as a plain multiplier, so highlight headroom above 1.0 survives into the negative's shoulder. |
| `sharpnessAmount`, `detailAmount` | 0 | Texture comes from the model: diffused dye layers, sharp silver key. |
| `colorNoiseReductionAmount` | 0.6 | Chroma noise would print as coloured dye grain after the matrix contrast; dye-transfer prints are grainless. |
| `luminanceNoiseReductionAmount` | 0.25 | Mild. |
| `isHighlightRecoveryEnabled` | true | Set explicitly where the filter offers it (iOS 26 and later, in an app built with the iOS 26 SDK) instead of left at an undocumented default; elsewhere the decoder's default applies. Recorded with the print; whether it should stay on is a hardware measurement (checklist step 11). |
| `decoderVersion` | the record's | Set first. A new filter uses the newest decoder on the running iOS, and an update may change demosaic or noise reduction; a re-develop asks for the version the print was developed with, if `supportedDecoderVersions` still holds it (any other gives a nil image), and the record stores the version used. |

The Core Image context runs with `workingColorSpace = extendedLinearSRGB` and `workingFormat = RGBAh`,
so the engine's kernels receive scene-linear values with sRGB primaries, unclipped above 1.0 and
allowed to be negative for colours outside sRGB.

The companion test on Linux (`tools/colorscience/develop_dng.py`) uses LibRaw with the equivalent
settings (`gamma=(1,1)`, `no_auto_bright`, camera white balance, sRGB primaries) and feeds the same
engine maths, so the look can be judged on real iPhone DNGs without a device.

## Memory and resolution

Core Image tiles large images automatically, so a 12 MP Bayer develop and a 48 MP ProRAW develop
share one code path. Quick previews use `scaleFactor = 0.25` (at most a 1024 px long edge) and draft
mode, and are rendered once into a half-float buffer in the working space: a decoder image is a recipe,
so the develop reveal and every Laboratory slider movement would otherwise run demosaic and noise
reduction again. Full-resolution output is streamed to the JPEG with `CIContext.writeJPEGRepresentation`
(Display P3, the provenance tags attached to the image), on a context of its own at low GPU priority so
the interface keeps its frame rate; whether the whole print is really never held in memory is Apple's
undocumented behaviour, unmeasured. The gallery thumbnail and the display image are then decoded from
that file at reduced size by ImageIO, and the detail screen decodes the print at most 4096 px wide, off
the main thread.

## Exposure

The RAW's absolute brightness depends on the camera's auto-exposure, the DNG `BaselineExposure` (iPhone
Bayer DNGs we inspected carry none; ProRAW files carry a value around −0.3 EV) and the user's exposure bias.
The engine applies `2^(parameters.exposureEV + baselineExposure + printExposureEV + printTimingEV)`, where
`printTimingEV` is measured per photograph by the print-timing step (geometric-mean luminance moved
toward a target key, partially and clamped, with the photographer's exposure compensation excluded from
the correction; see `docs/COLOR_SCIENCE.md`). That step absorbs most of the
systematic difference between the camera's RAW placement and the LibRaw path used for tuning; the
remaining constant offset, if any, has to be calibrated on hardware (see "Untested" in README.md).
The timing is measured on the quick decode with the parameters of the develop. In the Laboratory it is
kept while the parameters it depends on (print exposure, timing strength, target and limit) are those,
and measured again when they move; a re-develop stores the value it used.

Noise reduction in the decoder rises with ISO (`RAWDeveloper.Options.adaptive(iso:)`): the print's
contrast amplifies shadow noise, and dye-transfer prints are grainless.

## A custom demosaic?

Not in v1. The Bayer `CVPixelBuffer` is available from `AVCapturePhoto.pixelBuffer` and the DNG tags
(`BlackLevel`, `WhiteLevel`, `ColorMatrix1/2`, `AsShotNeutral`, gain-map opcodes) are readable, so a
Metal demosaic that applies the three-strip model directly to sensor data is a natural next step for
the engine. The present pipeline keeps Apple's demosaic and lens corrections (which are excellent and
device-specific) and takes over at the first point where the data is scene-linear.
