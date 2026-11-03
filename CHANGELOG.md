# Changelog

Each entry is one pull request, merged after CI (Linux core tests, Python prototype checks, an iOS
build and simulator GPU tests on a macOS runner) and a Codex review.

## Round 17 — the camera's own rendering (#18)
- Hold C or the *Camera's JPEG* button to see the JPEG the camera embedded in the file (Apple's full-size rendering for a ProRAW; a small preview, scaled, for most Bayer DNGs), in the preview or the loupe, so the print can be judged against the phone's own processing.

## Round 16 — a look as a link (#17)
- *Copy link* in the Laboratory encodes the look (parameters and print exposure) into the page's hash and copies the address; opening it anywhere applies the look.

## Round 15 — the phone layout (#16)
- On narrow screens the Laboratory is a sheet over the lower part of the screen (the picture stays visible), the header is compact, the hints are short and say nothing about keys on touch devices.
- `MOBILE=1 node test/smoke.cjs` runs the smoke test as an iPhone: touch double-tap for the loupe, 1:1 in device pixels, the sheet's position.

## Round 14 — drag the loupe, save the set (#15)
- Drag inside the loupe to move the crop; the image around it is uploaded with a margin so most drags only move the window.
- *Save all*: every photograph of the set developed with the look being shown, each with its own print timing, downloaded as one zip with the look's JSON; Escape stops it; undecodable files are skipped and named.
- The smoke test now also saves a print and checks the JPEG's size, and saves the set and checks the zip.

## Round 13 — the web bench: 1:1 loupe, tiled export, sets, looks A/B (#14)
- Double-tap the preview for a loupe: a crop of the full decode at 1:1 on the display, printed with the dye diffusion scaled to the whole image, so the spatial look can be judged before anything is saved.
- *Save JPEG* develops any size in 1024 px tiles with a blur halo; `test:gl` checks the tiled result and a windowed crop are bitwise identical to a whole-image render (densities fetched by integer texel in the blur and print passes).
- Drop several files or a folder: a set with ← → and a counter, recent decodes cached up to a memory budget.
- *Pin as A* in the Laboratory, hold A to compare the pinned look with the current sliders, in the preview or the loupe.
- The full decode is kept as 16-bit (RAW) or 8-bit (JPEG) codes with a linearisation table instead of floats: half to a quarter of the memory, which is what a 48 MP ProRAW needs to open on a phone.

## Round 12 — the web version, and the app without Xcode (#12)
- `web/`: the engine in a browser tab — a TypeScript port of the core tested against the Python fixture, WebGL2 shaders mirroring the Metal kernels (GPU parity checked in headless Chromium in CI), DNGs decoded on the device with LibRaw-wasm using the tuning settings, a camera mode labelled *not RAW*, the Laboratory, JPEG export. Deploys to Cloudflare Pages on every push (`_headers` carries the isolation headers).
- `.github/workflows/testflight.yml` + `docs/TESTFLIGHT.md`: the app archived, signed and uploaded to TestFlight from CI once four Apple secrets exist.

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
