# Changelog

Each entry is one pull request, merged after CI (Linux core tests, Python prototype checks, an iOS
build and simulator GPU tests on a macOS runner) and a Codex review.

## Round 25 — the print model, closer to the evidence (#26)
- The observer is the CIE 1931 2° table itself (CIE 018:2019, its 1 nm data taken every 5 nm from 360 to 830 nm) instead of an analytic fit that was off by up to 1.4 % of peak over a range that stopped at 730 nm; equal-energy white integrates to xy (0.33331, 0.33329), checked in each language. The dye gains are re-balanced for it: 1.2022 / 0.9087 / 0.8892.
- Each dye's density is normalised by gain · D max, and the cube spans that range: cyan, whose gain is above 1, no longer reaches the cube's edge before magenta and yellow, so the deepest blacks keep the slight tint of the shadows above them (C*ab 0.6) instead of turning red (1.4). The gains are part of the cube and of its cache key now, and no longer a kernel argument.
- One sRGB print everywhere: the P3 print converted to sRGB, then soft-clipped with Rec. 709 weights, as the web's sRGB canvas already did. The prototype's sRGB mode and the documentation figures used another (a cube baked in sRGB), up to 0.69 ΔE00 away. The cube is always P3; the fixture carries every sample's sRGB print, which the Swift core, the web port and the WebGL canvas path reproduce. The figures are re-rendered (they dated from Round 1).
- Together these move the shipped look by ΔE00 mean 0.19, p99 0.61, max 1.1 on the eight Kodak test images and 0.25 / 0.61 / 1.1 on two iPhone DNGs.
- Dye sets: both Laboratories offer, next to the print era, Technichrome v1's own dyes (still the default), *US 1949* and *UK*, fitted to FilmColors' published absorbance spectra of Technicolor prints (a *Samson and Delilah* trailer; NSMM 12593, a British leader), each with the gains that keep greys neutral with it. `fit_dyes.py` fits them to the digitised curves (rms 0.007–0.018 of the peak) and `set_params.py --calibrate` re-balances them. The fixture carries the sets and a block for each, checked in all four implementations; COLOR_SCIENCE.md gives their sources and uncertainty.
- COLOR_SCIENCE.md follows the period evidence: the silver key was thin and could be printed from any record (the "50 %" and "1944" have no primary source), Ball's 1:64 is a remark (measured flare follows the picture), the negatives were developed to γ 0.65 and the matrices had a sharp shoulder, the arcs measured 5020–5620 K on the screen, and the screens were 7–14 fL. A new section lists the model changes the evidence argues for and this round did not make.

## Round 22 — engine correctness and a fast cube bake (#23)
- The GPU kernels (Metal and WebGL) gave all three dyes cyan's matrix-curve steepness, which depends on each dye's D max, so a look whose D max differ (the Laboratory's sliders, a pasted look) printed up to 0.2 linear, about 11 ΔE00, away from the specification. Each dye now has its own; the shipped look, whose three D max are equal, is bit-identical. The parity fixture carries two variants of the look besides it (unequal dye D max; printer lights, screen flare and no key), checked by the prototype, the Swift core, the web port, headless Chromium and the simulator; the on-device self-test also runs the look in use with unequal D max.
- The separation matrix applies to the scene as it arrives: a wide-gamut RAW colour (a negative component in extended linear sRGB) is no longer clipped to sRGB channel by channel before the three records see it; the record exposures are floored, as before. Colours inside sRGB print exactly as they did; the fixture gains two colours outside it.
- The dye cube is baked factorised per dye, three transmittance tables instead of a power per entry and wavelength: 33³ in about 3 ms instead of 29 (Swift, release build, x86) and 8 ms instead of 137 in the browser, the same cube to rounding. The app keeps the cubes of the last four print models, baked outside its lock, so the live preview and the Laboratory, or two looks in turn, no longer re-bake each other's.
- Tolerances follow the measured error: the browser's GPU check allows 5e-4 and 0.1 ΔE00 per colour (it measures 1.2e-4 and 0.018) instead of 0.02, the Swift core 1e-7 on densities and 1e-6 on the output (it measures 1e-15 and 1.6e-8) instead of 2e-3 and 4e-3. The simulator measures 2.2e-3 to 2.4e-3 on the three looks (Core Image's cube is most of it), so the app's tests and its on-device self-test now allow 7.5e-3 instead of 0.02.

## Round 21 — halation and misregistration on the web (#22)
- The web engine now runs the two spatial stages it lacked, so every slider of the app's Laboratory has its counterpart: the halation glow (highlights above a threshold, blurred over a percentage of the long edge, added to the scene before the separation negatives and the key, as `tc_bloom_threshold` and `tc_scene_exposure` do) and the misregistration (the three dyes pulled apart at 120° in the print pass, bilinearly, the key kept in register, as `misregister()` does). Both are off in the shipped look.
- The glow is one field per photograph, built from its preview (reduced so the blur's σ is at most 8 texels, then a Gaussian) and sampled in the image's normalised coordinates, so the preview, the 1:1 loupe and every export tile see the same glow; the misregistration reads the densities by integer texel plus a fixed offset, so tiles and crops stay bitwise identical to a whole-image render (checked in CI with both stages on). The glow itself is checked against a CPU reference, and the app's own test (a uniform image shifted against itself prints unchanged) runs on the web too.

## Round 20 — breathing room (#21)
- The page says less at once. The info line keeps the facts that change (counter, label, size, print timing, the crop, what is being compared); the camera model, exposure, decode time and the embedded JPEG's size moved to a *Details* line that opens on request; one-off messages (saved, copied, the look from a link, errors) have a line of their own that clears itself after a few seconds.
- Plain / A / Camera are one hold-to-compare control under the picture, lit while held; the hints over the picture fade after a few seconds (`?` keeps the full list); the Laboratory's sections collapse (only Exposure open at first, the choice remembered) and its look actions are text under the look's name; the header and footer are two calm rows on a phone, and while the sheet is open there the compare control and the status line sit inside it (the room under the picture follows the sheet's and the footer's size).
- A double-tap is timed from when the finger landed, not from when a busy main thread got to it, so two quick taps either side of a long render frame still open the loupe.

## Round 19 — the end-to-end test in CI (#20)
- Two small synthetic Bayer DNGs (`tools/colorscience/make_test_dng.py`) let the web smoke test run in CI on every push, desktop and as an iPhone: decode, set navigation, loupe and drag, A/B, saved print and zip, look links, the crafted-name check, readout, help. Screenshots are kept as a CI artifact.

## Round 18 — readout and help (#19)
- The Laboratory shows a histogram of what is on screen with the share of clipped highlights and crushed shadows, refreshed after every render; `?` lists the keys and gestures.
- The top-level README describes the web bench as it now is.

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
