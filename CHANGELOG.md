# Changelog

Each entry is one pull request, merged after CI (Linux core tests, Python prototype checks, an iOS
build and simulator GPU tests on a macOS runner) and a Codex review.

## Round 11 — full-resolution develop streamed to disk (#11)
- The print is written in tiles straight from the Core Image graph and the thumbnail and display image are decoded from the file, so a 48 MP develop never holds the whole image in memory.

## Round 10 — AE/AF lock, RAW resolution policy (#10)
- Long press locks focus and exposure at a point until the next tap; a tapped focus returns to continuous mode when the subject area changes.
- RAW requests 12 MP by default (what every lens offers to Bayer RAW); full sensor resolution is a setting.

## Round 9 — timing respects the EV dial, timed preview (#9)
- Print timing excludes the photographer's exposure compensation, so −1 EV at capture prints a stop darker.
- The live preview is print-timed like the develop step, measured from the frames and smoothed.

## Round 8 — diagnostics for the first run on hardware (#8)
- Settings lists what the camera system reported for the current lens; hardware checklist; this changelog.

## Round 7 — import, honest labelling, provenance (#7)
- Import a DNG or any image from Photos or Files; developed exactly like a capture.
- `DNGInspector` reads the DNG's own tags to label an import *Bayer RAW*, *Apple ProRAW* or *Linear DNG*.
- The developed JPEG carries the original's camera, exposure, lens and date tags (never location).

## Round 6 — screen flare, preview cost (#6)
- `screenFlare` engine parameter: Ball's documented 1:64 projected contrast, off by default, one tap in the Laboratory.
- Live preview frames are scaled to the screen before the engine runs.

## Round 5 — physical controls (#5)
- Volume buttons and the Camera Control button take the photograph.
- Camera Control (iPhone 16): exposure slider in thirds of a stop and a lens picker, kept in step with the screen.
- Lens labels from the real fields of view; export-compliance key.

## Round 4 — self-test, privacy manifest (#4)
- On-device engine self-test in Settings (GPU versus the CPU reference, the same exposure on both sides).
- Privacy manifest; parameter JSON import in the Laboratory; accessibility labels.

## Round 3 — printer lights, preview fidelity (#3)
- Per-matrix printer lights alongside the per-dye contrast multipliers; the lights-only balance reproduces the historical crossover, documented.
- Preview stream with video HDR off and sRGB colour space; key-era picker.

## Round 2 — CI, print timing, adaptive noise reduction (#2)
- GitHub Actions: Linux core tests, Python prototype check, iOS compile and simulator GPU parity tests.
- Print timing (geometric-mean luminance moved toward a target key, clamped), ISO-adaptive noise reduction, settings.

## Round 1 — Technichrome (#1)
- RAW camera (Bayer first, ProRAW fallback), the imbibition-model engine in Python, Swift and Metal, the Laboratory, the library, the docs.
