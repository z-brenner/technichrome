# Technichrome on the web

The iPhone app's rendering engine in a browser tab, so the processing can be tested before the app
reaches a phone, and shared with anyone who has a DNG. It is the **same engine**, not a re-creation:

* The per-pixel maths (`src/engine/`) is a port of the Swift core, which is itself tested against the
  Python prototype. `npm test` runs the web port against the same 32-colour fixture
  (`Tests/TechnichromeCoreTests/Fixtures/parity.json`) and passes at 1.6e-8, the Swift core's figure.
* The GPU pipeline (`src/gl/`) is WebGL2 shaders mirroring the Metal kernels pass for pass: separate →
  dye diffusion → dye cube → silver key → screen flare → viewing exponent. `npm run test:gl` renders the
  fixture through the built site in headless Chromium and compares (worst error 1.2e-4; the app's
  simulator test allows 0.02).
* The shipped look is `src/engine/technichromeV1.json`, exported from the fixture; the parity test fails
  if it drifts from the prototype's parameters. The Laboratory exports and imports the same JSON the app
  and the Python tools use.

Nothing leaves the device: RAW decoding, the engine, and JPEG export all run in the tab.

## What it opens

* **DNG** (and any RAW LibRaw reads: CR2, NEF, ARW, RAF, …), decoded with [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm)
  using the settings the look was tuned on in `tools/colorscience/develop_dng.py`: camera white balance,
  no auto-brightening, AHD demosaic, sRGB primaries, 16 bit. That build applies LibRaw's default BT.709
  output curve whatever gamma is requested, so the page inverts it exactly (dcraw's own knee bisection,
  `dcrawGamma` in `src/engine/spectral.ts`); on the sample iPhone DNGs the result matches rawpy's linear
  decode to 0.02 %. A DNG is labelled **Bayer RAW**, **Apple ProRAW** or **Linear DNG** from LibRaw's
  colour-filter metadata, like the app's import. The DNG baseline exposure is applied like the app does.
  Lossy or floating-point DNGs are not supported by this build.
* **JPEG, PNG** (HEIC in Safari): linearised from sRGB and developed as display-referred data — the
  same thing the app does with a HEIF capture — and labelled **not RAW**.
* **The camera** (`getUserMedia`): a live preview through the engine, print-timed like the app's
  preview, and a *Photograph* button that takes a frame of the browser's processed stream. Browsers do
  not expose RAW sensor data, so this is labelled *not RAW* everywhere it appears; it is for seeing the
  look move, not for judging it.

## Working through a set

* **Several files or a folder.** Drop (or pick) any number of files, or a folder: they become a set,
  sorted by name, with ‹ › buttons and the ← → keys to step through it; the counter is in the info
  line. Decodes are kept up to about 700 MB so going back is instant; beyond that the least recently
  shown is decoded again on demand.
* **Hold to compare** the print with the plain decode: hold still on the picture (the hold starts after a
  short delay, so a tap does not flash) or hold *Plain* in the compare control under it. The same control
  holds *A* (once a look is pinned) and *Camera* (when the file carries the camera's JPEG); the button lights
  while it is held and the info line says what is being shown.
* **Facts, details, messages.** The info line keeps what changes as you work: the counter, the label, the
  size, the print timing, the crop, what is being compared. *Details* opens a second line with the camera
  model, ISO and shutter, baseline and print exposure, decode time and the embedded JPEG's size. One-off
  messages (saved, copied, the look from a link, errors) have a line of their own that clears after a few
  seconds; errors stay. The hints over the picture fade after a few seconds; `?` keeps the full list.
* **Double-tap for 1:1.** A double-tap or double-click opens a loupe: a crop of the *full* decode
  around that point, shown pixel for pixel on the display (device pixels, so a 2× screen gets a 2× larger
  crop), printed with the dye diffusion scaled to the whole image's long edge exactly as the saved JPEG
  will be. Drag to move the crop (the image around it is uploaded with a margin, so most drags only move
  the window), hold still to compare, double-tap or Escape to leave. Without it the on-screen preview is a
  1600 px copy, which cannot show the diffusion or the key image's fine structure.
* **The camera's own rendering.** Hold C (or *Camera* in the compare control) to see the JPEG the camera embedded
  in the file: for an Apple ProRAW that is Apple's full-size rendering of the same capture, for most Bayer DNGs
  a small preview, shown scaled and said so. It is decoded by the browser with its colour profile and shown as
  it is, never through the engine, so the print can be judged against what the phone would have given.
* **Readout.** The Laboratory shows a histogram of what is on screen (the print, the plain decode, look A, the
  camera's rendering, or the loupe's crop) with the share of clipped highlights and crushed shadows, refreshed
  after every render. The `?` key or button lists the keys and gestures. The Laboratory's sections collapse
  (Exposure is open at first; the choice is remembered in the browser) so one slider group is in view at a time.
* **Pin a look as A.** In the Laboratory, *Pin as A* keeps the current parameters and print exposure;
  then hold the A key (or *A* in the compare control) to see A against whatever the sliders say now, in
  the preview or in the loupe. A saved JPEG while holding A is the pinned look (`-A` in the file name).
* **Save JPEG** develops the full decode in 1024 px tiles, each uploaded with a halo as wide as the
  diffusion radius and printed through a window that leaves the halo out. `npm run test:gl` checks that
  the tiled result and a windowed crop are bitwise identical to a whole-image render (densities are
  fetched by integer texel, never filtered, so the sums are the same floats in the same order). GPU
  memory stays at one tile's worth whatever the image size; when a browser refuses a canvas of the full
  size (phones cap 2D canvases around 16 megapixels) the page halves the size and says so.
* **Save all** develops every photograph of the set with the look being shown (each with its own print
  timing, as the app would) and downloads one zip: the prints and the look as JSON (parameters plus the
  print exposure, which *Import JSON* restores), so a batch can be reproduced later. Escape stops it after
  the current file; files that fail to decode are skipped and named; prints whose names would collide (a
  RAW/JPEG pair, two folders) are numbered. The set is fixed when the batch starts. The zip is built in memory, so a set of fifty 12 MP prints is a
  few hundred megabytes before it downloads.
* **A look as a link.** *Copy link* in the Laboratory puts the current look (parameters and print exposure,
  deflated, about 1 KB) in the address bar and on the clipboard; opening that link anywhere applies the look,
  so a look tuned on a desk reaches a phone without a file. The JSON export remains the form the app reads.
* **Halation and misregistration.** The Spatial section of the Laboratory has the app's four other spatial
  sliders. *Halation* adds a glow of the highlights above *Halation threshold* (in the file's own linear units,
  before exposure and timing, as in the app) blurred over *Halation radius* percent of the long edge, to the scene
  the negatives and the key see. The glow is one field per photograph, computed from its preview (reduced so the
  blur stays small, then a Gaussian) and sampled in the image's own coordinates, so the preview, the loupe and
  every export tile show the same glow; the app blurs at full resolution, so the two agree to within the
  preview's resampling, not bit for bit. *Misregistration* pulls the three dyes apart at 120° (cyan to the right,
  magenta and yellow down and up to the left), bilinearly, with the key image kept in register, exactly as the
  app does; tiles and crops stay bitwise identical to a whole-image render with it on, which CI checks.
* **Memory.** The full decode is kept as LibRaw produced it (16-bit codes, 6 bytes per pixel) or as
  8-bit sRGB (3 bytes), linearised through a table region by region when the engine needs it, rather
  than as floats (12 bytes): a 12 MP DNG holds 72 MB, a 48 MP ProRAW 290 MB, plus the small float preview.
  Measured once in headless Chromium with software rendering on a 61 MP Sony ARW (117 MB): decoded in 18 s,
  about 400 MB held afterwards, the loupe in 0.6 s, the full 9568×6376 JPEG saved in 27 s (a real GPU is far
  quicker at the last step). A phone's limits remain untested.
* **Nothing from a file, a camera or a link is interpreted as markup.** Camera models, file names, look names
  and error messages are escaped before the info line shows them.

## Running it

```
cd web
npm install
npm run dev          # http://localhost:5173
npm test             # parity with the Python fixture, timing, transfer functions, JSON tolerance, tiling, stored images
npm run build        # type-check + production build into dist/
npm run test:gl      # GPU parity of the built site in headless Chromium, and tiled / windowed rendering against a
                     # whole-image render (needs `npx playwright install chromium`)
npm run test:smoke   # end to end in headless Chromium on two synthetic Bayer DNGs checked in under test/fixtures
npm run test:smoke:mobile   # the same as an iPhone (both run in CI; screenshots are kept as a CI artifact)
node test/smoke.cjs out.png a.dng b.dng   # end to end on real files: opens them as a set, steps through it, opens
                     # and drags the loupe, pins a look and holds A, saves a print (checks the JPEG's size) and the
                     # set as a zip (checks its contents), screenshots (not in CI: it needs DNGs)
MOBILE=1 node test/smoke.cjs out.png a.dng   # the same as an iPhone (touch double-tap, 3× display, the Laboratory sheet)
```

The synthetic DNGs (`test/fixtures/synthetic-a.dng`, landscape, and `synthetic-b.dng`, portrait with a −0.5 EV
baseline exposure) are plain uncompressed RGGB mosaics of a synthetic scene (an exposure sweep, an 18 % grey
patch, two colour discs, a clipping highlight) with the tags LibRaw needs, written by
`tools/colorscience/make_test_dng.py`; LibRaw returns their grey patch neutral at 0.18. They stand in for real
photographs in CI only: the look itself was tuned on, and is judged against, real DNGs.

```
```

The RAW decoder is a pthreads build and needs `SharedArrayBuffer`, so the page must be
cross-origin isolated. The dev server, the test servers and `public/_headers` (which Cloudflare Pages
applies to `dist/`) all send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Any other host must send the same two headers or the
decoder will not start (the page says so). Cross-origin resources on the page (the Google Fonts
stylesheet) carry `crossorigin` so they load under that policy.

## Deploying on every push (Cloudflare Pages)

Two ways to get push-to-deploy; both end with the site on `technichrome.pages.dev` (or a custom domain).

1. **Cloudflare's Git integration** (no secrets in GitHub): Cloudflare dashboard → *Workers & Pages →
   Create → Pages → Connect to Git* → `z-brenner/technichrome`. Settings: production branch `main`,
   **root directory** `web`, build command `npm run build`, build output directory `dist`. From then on
   every push to `main` is a production deployment and every other branch gets a preview URL. The
   `_headers` file in the output is picked up automatically.
2. **From GitHub Actions** (`.github/workflows/deploy-web.yml`): add the repository secrets
   `CLOUDFLARE_API_TOKEN` (a token with *Cloudflare Pages → Edit* on the account) and
   `CLOUDFLARE_ACCOUNT_ID` (on the dashboard's Workers & Pages overview). The workflow tests, builds and
   deploys `web/` on every push to `main`, creating the `technichrome` Pages project the first time.
   Without the secrets the job skips itself.

Output colour: the page renders in Display P3 when the browser's canvas supports it (Chrome, Safari),
otherwise it converts the print to sRGB with the same chroma-scaling soft clip the engine uses for
out-of-gamut colours. Saved JPEGs carry the P3 profile on P3-capable browsers.

## What it does not do (yet)

* No EXIF is written into the saved JPEG, and the DNG is not preserved alongside it (open it again from
  your files; nothing was uploaded in the first place).
* Full-resolution export is no longer bounded by the GPU's texture size (it is tiled), but it is by what
  the browser will hold: the decode itself (see *Memory* above) and, on phones, the 2D canvas the JPEG
  is encoded from. When that fails the page halves the size and says so in the info line.
* Save all holds the whole zip in memory before it downloads; very large sets should be saved in parts.
