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
   (before `startRunning()`, as Apple recommends) and the ProRAW format used.
3. `videoZoomFactor` is pinned to 1.0 (Bayer RAW throws with digital zoom).
4. `maxPhotoDimensions` is set to the largest value the active format supports.
5. `AVCapturePhotoSettings(rawPixelFormatType:processedFormat:)` requests the RAW plus an HEVC companion.
   The companion is Apple's rendering; it is stored only so the Laboratory can compare the Technichrome
   print against it (hold the image). It never feeds the engine.
6. `AVCapturePhoto.fileDataRepresentation()` on the RAW photo returns a DNG, written untouched to the
   photo's folder as `original.dng`. The DNG is the preserved original; it can be shared from the app
   or saved to Photos next to the print.

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

The Core Image context runs with `workingColorSpace = extendedLinearSRGB` and `workingFormat = RGBAh`,
so the engine's kernels receive scene-linear values with sRGB primaries, unclipped above 1.0 and
allowed to be negative for colours outside sRGB.

The companion test on Linux (`tools/colorscience/develop_dng.py`) uses LibRaw with the equivalent
settings (`gamma=(1,1)`, `no_auto_bright`, camera white balance, sRGB primaries) and feeds the same
engine maths, so the look can be judged on real iPhone DNGs without a device.

## Memory and resolution

Core Image tiles large images automatically, so a 12 MP Bayer develop and a 48 MP ProRAW develop
share one code path. Quick previews use `scaleFactor = 0.25` and draft mode. Full-resolution output is
written with `CIContext.writeJPEGRepresentation` in Display P3.

## Exposure

The RAW's absolute brightness depends on the camera's auto-exposure, the DNG `BaselineExposure` (iPhone
Bayer DNGs we inspected carry none; ProRAW files carry a value around −0.3 EV) and the user's exposure bias.
The engine applies `2^(parameters.exposureEV + baselineExposure + printExposureEV + printTimingEV)`, where
`printTimingEV` is measured per photograph by the print-timing step (geometric-mean luminance moved
toward a target key, partially and clamped; see `docs/COLOR_SCIENCE.md`). That step absorbs most of the
systematic difference between the camera's RAW placement and the LibRaw path used for tuning; the
remaining constant offset, if any, has to be calibrated on hardware (see "Untested" in README.md).

Noise reduction in the decoder rises with ISO (`RAWDeveloper.Options.adaptive(iso:)`): the print's
contrast amplifies shadow noise, and dye-transfer prints are grainless.

## A custom demosaic?

Not in v1. The Bayer `CVPixelBuffer` is available from `AVCapturePhoto.pixelBuffer` and the DNG tags
(`BlackLevel`, `WhiteLevel`, `ColorMatrix1/2`, `AsShotNeutral`, gain-map opcodes) are readable, so a
Metal demosaic that applies the three-strip model directly to sensor data is a natural next step for
the engine. The present pipeline keeps Apple's demosaic and lens corrections (which are excellent and
device-specific) and takes over at the first point where the data is scene-linear.
