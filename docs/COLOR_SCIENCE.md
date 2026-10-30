# Technichrome colour science

Technichrome does not apply a filter. It pushes scene-linear RAW data through a model of the
three-strip Technicolor process (Process No. IV, 1932–1955): three separation negatives exposed
through a beam-splitter camera, printed as gelatin relief matrices, and transferred as three dyes
onto a blank print, which is then projected. The model is called the *imbibition model* in the code.

Everything below is labelled **documented** (a property of the historical process with a source) or
**approximation** (our engineering choice, tuned by eye). We have no measurements of real Technicolor
prints or dyes; the numbers in `EngineParameters.technichromeV1` are a starting point for comparison
against reference frames, which is why every one of them is adjustable in the app's Laboratory.

## What the process was

**Documented.** From J. Arthur Ball's paper to the SMPE/Academy (1935), the Timeline of Historical
Film Colors (Flueckiger), Wikipedia's *Technicolor* and *Dye-transfer process* entries, and the
*Dye transfer* literature cited there:

* The camera split the light behind the lens with a prism block containing a sputtered gold mirror.
  One path went straight to a panchromatic negative behind a green filter "transmitting green light
  only" (the **green record**). The other path, reflected 90°, passed a magenta filter "transmitting
  red and blue light" into a **bipack**: a front film sensitive to blue carrying a surface coating of
  a blue-absorbing (red-orange) dye, and behind it a panchromatic film receiving the **red** image.
  (Ball 1935, Fig. 1.)
* The three strips "are developed to negatives of equal contrast and must always be considered and
  handled as a group". (Ball 1935.)
* From the negatives, matrices were printed by projection onto a special stock and processed to
  "positive relief images in hardened gelatine". Each matrix absorbed dye and transferred it by
  imbibition onto a blank film pressed into contact for "several minutes". (Ball 1935.)
* The dyes were the subtractive primaries: cyan from the red record, magenta from the green record,
  yellow from the blue record. Ball's demonstration reel built the print as sound track + yellow, then
  cyan, then magenta. (Ball 1935.) The develop animation in the app follows this order.
* Until about 1944 the blank carried, before the dye transfers, a weak ("50 %") black-and-white
  silver positive of the green record — the **key image** — which improved apparent sharpness and
  black density and covered fringing, at the cost of colourfulness. Sources disagree on the exact
  year it was dropped (Wikipedia: 1944; a CML discussion: "the 1930s").
* Pin registration was critical; misregistration showed as colour fringes.
* Projection contrast "from whitest white to blackest black" was "about 1 to 64". "All very full
  exposures tend to bleach out to white and all low exposures tend to drop into black." A bleached
  highlight on a face "will look blotchy". The brightest red "is obtained by full value of the magenta
  and yellow dyes without any cyan dye"; more red light only overexposes the red negative and begins
  to expose the green and blue negatives, so the print "tend[s] to bleach out to white". (Ball 1935.)
* The emulsions were slow (sources quote ASA ≈ 5) and daylight-balanced, hence carbon-arc lighting
  on set and the heat for which the process was notorious.
* Dye-transfer dyes are described as "very spectrally pure compared to normal coupler-induced
  photographic dyes, with the exception of the Kodak cyan" and as unusually stable.
* Blacks could show "unwanted color hues" and whites "obtrusive white blotches" (Flueckiger's summary
  of period sources).

## The model

```
scene-linear RGB (sRGB primaries, from CIRAWFilter at boost 0)
   │  exposure 2^(ev + baseline)                       [1]
   ▼
three-strip camera   S = M_sep · RGB                  [2]  three separation exposures
   ▼
negatives            Dn = H&D(log10 S)                [3]  three equal-contrast negatives
   ▼
matrices + dyes      Dd_i = H&D_mat(−Dn_i) · gain_i   [4]  dye density transferred per matrix
   │                 Dk   = H&D_key(−Dn_green) · key   [5]  silver key image (neutral density)
   ▼  (dye densities are blurred slightly: dye diffusion in the gelatin; the key stays sharp)
spectral print       T(λ) = 10^−(Σ Dd_i a_i(λ) + Dmin) [6]  three dye absorbances
   ▼
projection           XYZ = ∫ P(λ) T(λ) x̄ȳz̄ dλ         [7]  carbon-arc lamp, eye adapted to screen white
   ▼
display              P3 linear · 10^−Dk, ^surround, soft gamut clip   [8]
```

Steps 1–5 are analytic per-pixel maths in the Metal kernels. Steps 6–7 are baked into a 33³ lookup
table indexed by the three normalised dye densities (`LUTBuilder`); the key image is spectrally
neutral so it factors out as a multiplier after the table. `ReferencePipeline.swift` is the scalar
specification; `tools/colorscience/tcengine.py` is the prototype; the unit tests check that the two
agree to 1e-7.

### [2] Camera — approximation informed by the documented filters

The effective spectral sensitivities of the three records (filter × emulsion × splitter) were never
published. We assume flat-topped bands consistent with Ball's description: red 628 nm (σ 30/38),
green 545 nm (σ 32/30), blue 452 nm (σ 34/27), shape exponent 3. Because the engine receives
colorimetric RGB rather than spectra, the bands are turned into a 3×3 matrix by reconstructing
smooth reflectance spectra for the sRGB primaries and integrating (`derive_separation_matrix`).
Rows are normalised so a neutral gives equal records:

```
red record    0.847 R  0.116 G  0.037 B
green record  0.031 R  0.930 G  0.039 B
blue record   0.040 R  0.086 G  0.874 B
```

The crosstalk is what makes a saturated scene colour expose the "wrong" negatives a little, which
is exactly Ball's bleaching mechanism; it is also why pastel colours stay gentle while strong
colours become strong.

### [3]–[5] Characteristic curves — approximation

Density versus log exposure is modelled with a Richards (generalised logistic) curve
`g(x) = (1 + ν·e^−x)^(−1/ν)`. ν = 1 is a logistic; ν → 0 gives an abrupt toe and a long shoulder,
which is how print materials behave (short toe above diffuse white, steep straight line, long
roll-off into D-max). The negatives share one curve ("equal contrast"): γ 0.45, D-min 0.12, D-max 2.2,
ν 0.2. The matrix/dye curve has γ 3.22 and ν 0.025, with D-max 2.8 per dye. The overall tone scale
was fitted (`fit_tone.py`) to a projection-print target rendered for a phone: diffuse white at
~0.81 display-linear, mid grey at ~0.19, a slope of about 1.5 through the shadows, and blacks that
drop into density — Ball's "low exposures tend to drop into black".

Technicolor balanced prints so greys printed neutral. The engine has the two controls a laboratory
had: per-matrix **printer lights** (an exposure shift of each matrix curve, in stops) and per-matrix
**contrast** (a density multiplier, Technicolor's "colour control"). Balanced with lights alone, this
model reproduces the classic crossover — cyan highlights and reddish shadows — that period sources
describe as blacks with unwanted hues; so the shipped preset is balanced with the contrast multipliers
(`calibrate_neutral`: 1.196 / 0.915 / 0.888 for the chosen dyes) and the lights sit at zero, available
in the Laboratory.

The key image is on by default at 0.15 of the documented "50 %" strength — enough to deepen blacks
neutrally and sharpen edges, not enough to flatten the reds the way the full key did in the 1930s.
Three of the four films named in the brief (Black Narcissus 1947, The Red Shoes 1948, Singin' in the
Rain 1952) are post-key prints; set it to 0 for that era, 0.5–1.0 for a 1930s print.

### Print timing — a laboratory practice, modelled

A laboratory never printed every negative with the same light: a timer chose printer lights per
scene. A RAW file's absolute brightness depends on the camera's auto-exposure (iPhones protect
highlights, so RAW frames often sit low), so before printing, the engine measures the scene's
geometric-mean luminance (after the DNG baseline exposure) and moves the print exposure toward a
target key of 0.16, by 60 % of the distance and never more than ±1.25 stops. Strength 0 turns it
off; the measured value is stored with each photograph and shown in the Laboratory. The target and
strength are approximations to be checked on hardware against the LibRaw path used for tuning.

The photographer's exposure compensation is taken out of the measurement first: timing corrects the
camera's automatic placement only, so a deliberate −1 EV at capture prints a full stop darker rather
than being 60 % undone by the timer. The live preview is timed the same way — measured from the
frames about twice a second and smoothed — so what the preview shows is the timed print, not the
untimed one.

### [6] Dyes — approximation informed by the literature

No spectral curves of Technicolor's dyes are publicly tabulated as far as we know. We model each dye
as a flat-topped main absorption band plus the unwanted absorptions every real dye of the period had
(Hunt, *The Reproduction of Colour*; Evans, Hanson & Brewer):

* **Cyan** — peak 652 nm, broad (σ 52/62, shape 3), plus 22 % unwanted green absorption and 12 % blue.
  Deliberately the least pure dye, as the dye-transfer literature says. This is what makes blues deep
  and slightly purplish and greens forest-like rather than lime.
* **Magenta** — peak 545 nm (σ 42, shape 3.5), 22 % unwanted blue absorption, a trace in the red.
* **Yellow** — peak 445 nm (σ 45/40, shape 3.5), a small tail into the green. Nearly pure.

Flat-topped ("block") bands matter: Gaussian dyes leak light at the band edges and produce muddy,
desaturated prints (that was our first iteration). Block dyes give the pure, dense reds — full
magenta plus full yellow and no cyan — that Ball describes.

### [7] Projection — approximation

The lamp is a 5400 K Planckian radiator (carbon arcs were close to daylight; the exact figure varies
by carbon trim). The eye is assumed adapted to the screen white (projector through the clear base),
so the print white is mapped to the display white with a Bradford transform. After adaptation the
lamp's colour only produces second-order interactions with the dyes.

**Screen flare — a documented figure, off by default.** Ball gives the projected contrast "from
whitest white to blackest black" as "about 1 to 64": the print's own density, the projector's stray
light and the theatre's flare together left the deepest black near 1/64 of the screen white. The
engine's `screenFlare` adds that fraction of white after the key image, `(c + f) / (1 + f)`, before
the viewing-condition exponent, and the Laboratory offers the 1:64 figure as a one-tap setting. The
shipped look leaves it at 0: a phone is not a 1935 projection, an OLED shows the print's own density,
and a black lifted to 1/64 of white reads as haze on a small bright screen. It is there for anyone
matching a reference frame scanned from a projected or printed source, where it belongs.

### [8] Display — approximation

The print is rendered in Display P3 (Technicolor reds exceed sRGB). Colours outside P3 are brought
in by scaling chroma toward luminance, never by clipping channels. A theatrical print is designed for
a dark surround; viewed on a phone in daylight it reads too contrasty, so a mild viewing-condition
exponent (0.92) is applied — a small nod to Bartleson–Breneman, not a full appearance model.

### Spatial stages — approximation grounded in the process

* **Dye diffusion**: the dye images are blurred by σ ≈ 1.1 px (at a 4000 px long edge); the silver
  key is not. This is the "softness with striking contrast" of imbibition prints: dye bleeds slightly
  into the gelatin, the key keeps edges crisp.
* **Misregistration**: available (per-dye offsets at 120°), off by default. Fringing is documented,
  but as a fault.
* **Halation / glow**: available, off by default. We found no evidence that it is characteristic of
  three-strip prints rather than of individual cinematographers' diffusion.
* **Grain**: none. Dye images are grainless; adding grain would be a generic "vintage" gesture.

## What we observed while tuning

* Subtractive colour darkens as it saturates. A pure sRGB red prints at roughly a third of its
  input luminance, dense and velvety; a digital saturation boost would keep it bright and look
  plastic. That difference is the whole point.
* Highlights desaturate toward white (the dye toe) and shadows drop into neutral density (the
  shoulder and the key). Skin in direct light goes creamy; skin in shadow goes warm and dense.
* Greens print darker and bluer than the scene (cyan's green absorption, the blue record's green
  crosstalk). Period art direction painted foliage greener for the same reason.
* Neutral greys stay neutral to within 1 % only because the dye gains are calibrated; without that
  step the print is visibly cyan-deficient.

## How to refine it

1. Shoot a ColorChecker and a face under daylight; develop; export the parameters JSON from the
   Laboratory.
2. Compare against reference frames of known provenance (restorations scanned from dye-transfer
   prints, not telecine transfers of faded Eastmancolor dupes).
3. Adjust in this order: exposure → matrix γ / ν (contrast) → dye gains (balance) → cyan unwanted
   absorptions (blues and greens) → key strength (blacks and red density) → diffusion.
4. Paste the new numbers into `tools/colorscience/tcengine.py`, run `python3 sync_swift.py` and
   `python3 export_fixtures.py ../../Tests/TechnichromeCoreTests/Fixtures/parity.json`, then `swift test`.

## Sources

* J. A. Ball, "The Technicolor Process of Three-Color Cinematography", Academy Technicians Branch
  Technical Bulletin, 31 May 1935; also JSMPE 25(2), Aug 1935, pp. 127–138.
* B. Flueckiger, *Timeline of Historical Film Colors*, entry "Technicolor No. IV: Three-strip".
* Wikipedia, "Technicolor" and "Dye-transfer process".
* R. W. G. Hunt, *The Reproduction of Colour* (dye unwanted absorptions, subtractive reproduction).
* Apple, *CIRAWFilter* documentation; WWDC21 session 10160; *Capturing photos in RAW and Apple ProRAW formats*.
* C. Wyman, P.-P. Sloan, P. Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching
  Functions", JCGT 2(2), 2013 (observer curves used in the spectral integration).

## Figures

Synthetic charts rendered by `tools/colorscience/make_charts.py` with the shipped parameters (left: scene
values encoded as plain sRGB; right: the Technichrome print):

* `docs/figures/colorchecker_before_after.png` — the 24 ColorChecker patches.
* `docs/figures/hue_sweep_before_after.png` — hue × saturation × value sweep.
* `docs/figures/grey_ramp_before_after.png` — nine-stop grey ramp.
* `docs/figures/skin_ramp_before_after.png` — seven skin colours across a 4.5-stop exposure ramp.
* `docs/figures/iphone_xs_dng_plain_vs_technichrome.jpg` — a CC0 iPhone XS Bayer DNG (raw.pixls.us),
  LibRaw linear decode, plain rendering versus the Technichrome print.
