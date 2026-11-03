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

## Running it

```
cd web
npm install
npm run dev          # http://localhost:5173
npm test             # parity with the Python fixture, timing, transfer functions, JSON tolerance
npm run build        # type-check + production build into dist/
npm run test:gl      # GPU parity of the built site in headless Chromium (needs `npx playwright install chromium`)
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

* Misregistration and halation are not rendered (both are off in the shipped look).
* No EXIF is written into the saved JPEG, and the DNG is not preserved alongside it (open it again from
  your files; nothing was uploaded in the first place).
* Full-resolution export is limited by the GPU's maximum texture size (16384 px on most desktops, often
  4096–8192 px on phones); larger images are reduced and the page says by how much.
