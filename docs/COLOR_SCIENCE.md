# Technichrome colour science

Technichrome does not apply a filter. It pushes scene-linear RAW data through a model of the
three-strip Technicolor process (Process No. IV, 1932–1955): three separation negatives exposed
through a beam-splitter camera, printed as gelatin relief matrices, and transferred as three dyes
onto a blank print, which is then projected. The model is called the *imbibition model* in the code.

Everything below is labelled **documented** (a property of the historical process with a source),
**measured** (fitted to a published measurement of real prints) or **approximation** (our engineering
choice, tuned by eye). The only measurements are published absorbance spectra of the dyes of two
Technicolor prints, digitised from figures, behind two of the Laboratory's three dye sets ([6]); the
shipped look keeps its own dyes for now. The numbers in `EngineParameters.technichromeV1` are a
starting point for comparison against reference frames, which is why every one of them is adjustable
in the app's Laboratory.

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
three-strip camera   S = max(M_sep · RGB, 10^−6)      [2]  three separation exposures
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
neutral so it factors out as a multiplier after the table. Each dye's density Dd_i is normalised by
gain_i · D max_i, the most of that dye the print carries, so each axis of the table spans
[0, gain · D max] and the three dyes reach its edge together. Until Round 25 the axes stopped at D max:
cyan, whose gain is above 1, reached the edge while magenta and yellow still rose, and the deepest
blacks (scene greys below about 2^−8, under L* 2) lost cyan and turned red, C*ab 1.4 at 2^−14 against
0.6 now. The gains are therefore part of the table, and changing one re-bakes it.

`ReferencePipeline.swift` is the scalar specification; `tools/colorscience/tcengine.py` is the
prototype; the unit tests check that the two agree to 1e-7 on the densities and 1e-6 on the output
(they measure about 1e-15 and 2e-8, the latter the table's float32 storage), on a fixture that covers
the shipped look and four variants of it (three different dye D max; printer lights with screen flare
and no key; each measured dye set of [6]), each output both as the P3 print and as the sRGB print.
The fixture also carries the dye sets themselves, which the app's and the web's presets must equal.

**The bake.** The print's transmittance factorises per dye, 10^−(Σ dᵢ·aᵢ(λ) + Dmin) =
T_c(λ)·T_m(λ)·T_y(λ)·10^−Dmin, so the table is baked from three tables of 33 × 95 transmittances
(one per node and wavelength), computed once, and every entry is a sum of products rather than 95
powers: 33³ takes about 4 ms in a release build of the Swift core and 9 ms in the web page's JavaScript
on a shared x86 machine (evaluating every node directly took 29 ms and 137 ms on the 71-wavelength grid
used before Round 25). The result is the same to rounding (1.4e-17), and each implementation tests it
against direct evaluation at every node. The app keeps the cubes of the last four print models it was
asked for, so the live preview and the Laboratory, or two looks compared in turn, never re-bake; only a
change to the dyes, their D max or gains, the base density or the lamp does.

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

The matrix applies to the scene-linear RGB as it arrives, negative components included. In extended
linear sRGB a colour outside the sRGB gamut has a negative component (the app develops with
CIRAWFilter's gamut mapping off, so such colours can reach the engine; the web's 16-bit LibRaw decode
has already clipped them). Such a colour is not impossible, only beyond what sRGB can express, and the
separation is a linear model of the camera's records, so it applies to the colour as it is. Only a
record exposure cannot be negative: the three exposures are floored (at 10^−6, before the log). Until
Round 22 the engine clamped each RGB channel at 0 before the matrix instead, which clipped a wide-gamut
RAW colour to sRGB channel by channel, shifting its hue and dropping the saturation it held: on the
real surface colours of Pointer's gamut that lie outside sRGB the two orders differ by 4.5 ΔE00 on
average and up to 18 at a normal exposure. The halation glow, the print-timing measurement and the
plain comparison view still clamp at 0.

### [3]–[5] Characteristic curves — approximation

Density versus log exposure is modelled with a Richards (generalised logistic) curve
`g(x) = (1 + ν·e^−x)^(−1/ν)`. ν = 1 is a logistic; ν → 0 gives an abrupt toe and a long shoulder,
which is how print materials behave (short toe above diffuse white, steep straight line, long
roll-off into D-max). The negatives share one curve ("equal contrast"): γ 0.45, D-min 0.12, D-max 2.2,
ν 0.2. The matrix/dye curve has γ 3.22 and ν 0.025, with D-max 2.8 per dye. Each dye's curve keeps the
slope γ at half density whatever its D-max, so dyes given different D-max in the Laboratory differ in
steepness as well as in height; the kernels take the steepness per dye. The overall tone scale
was fitted (`fit_tone.py`) to a projection-print target rendered for a phone: diffuse white at
~0.81 display-linear, mid grey at ~0.19, a slope of about 1.5 through the shadows, and blacks that
drop into density — Ball's "low exposures tend to drop into black".

Technicolor balanced prints so greys printed neutral. The engine has the two controls a laboratory
had: per-matrix **printer lights** (an exposure shift of each matrix curve, in stops) and per-matrix
**contrast** (a density multiplier, Technicolor's "colour control"). Balanced with lights alone, this
model reproduces the classic crossover — cyan highlights and reddish shadows — that period sources
describe as blacks with unwanted hues; so the shipped preset is balanced with the contrast multipliers
(`calibrate_neutral`: 1.202 / 0.909 / 0.889 for the chosen dyes) and the lights sit at zero, available
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

### [6] Dyes — three sets: the engine's own (approximation) and two measured

Each dye is a main absorption band, an asymmetric generalised Gaussian exp(−½·|(λ−μ)/σ|^shape) whose
shape exponent sets how flat its top is (2 is a Gaussian, 3–4 a flat-topped "block"), plus smaller
lobes for the unwanted absorptions every real dye has (Hunt, *The Reproduction of Colour*). The
Laboratory offers three dye sets, next to the print era. Each carries its own dye gains, the contrast
multipliers that print greys neutral with those dyes and the rest of the shipped look
(`calibrate_neutral`; `set_params.py --calibrate` re-balances them all), so choosing a set keeps greys
grey. The shipped look uses Technichrome v1's. There was no single Technicolor dye set to model:
each dye was a blend of several (Cornwell-Clyne, *Colour Cinematography*, 3rd ed. 1951, pp. 466–467,
whose recipes he calls "schematic only"; George Eastman Museum), the blends were "regularly modified"
and differed between London and Hollywood (Ruivo, *Film Atlas*), and FilmColors' authors write that
their development "has not been documented to date".

**Technichrome v1 — approximation (the default).** Our own dyes, from before any measurement was at
hand; gains 1.202 / 0.909 / 0.889.

* **Cyan** — peak 652 nm, broad (σ 52/62, shape 3), plus 22 % unwanted green absorption and 12 % blue.
  Deliberately the least pure dye, as the dye-transfer literature says. This is what makes blues deep
  and slightly purplish and greens forest-like rather than lime.
* **Magenta** — peak 545 nm (σ 42, shape 3.5), 22 % unwanted blue absorption, a trace in the red.
* **Yellow** — peak 445 nm (σ 45/40, shape 3.5), a small tail into the green. Nearly pure.

We chose flat-topped bands because Gaussian dyes printed muddy, desaturated colour in our first
iteration, and block dyes give the pure, dense reds (full magenta plus full yellow and no cyan) that
Ball describes. The measurements below support the peaks (cyan 640–660 nm, magenta 530–545 nm) but not
the shape: fitted to measured curves, the main bands of cyan, magenta and the US yellow have shape
exponents of 2.0 to 2.8, not 3 to 3.5, and spectrophotometer curves show edges 1.5 to 2 times wider. Magenta is broader (σ 45–51) and still absorbs 0.17–0.29 of its peak
at 620 nm, where v1's absorbs 0.05. The muddiness we removed may be what the real dyes did.

**US 1949 — measured (FilmColors, *Samson and Delilah*).** Fitted to the absorbances FilmColors
extracted "with a statistical method from multispectral image capture" of the trailer of *Samson and
Delilah* (USA 1949) (filmcolors.org, Technicolor No. IV timeline entry; figure credit Giorgio Trumpy).
Cyan peaks at 647 nm and stays high into the far red (0.84 of its peak at 710 nm); magenta peaks at
544 nm (shape 2.8) with little blue absorption (0.06 at 420 nm) and 0.22 at 620 nm; yellow peaks at
457 nm (shape 2.3) and is pure (0.04 at 540 nm). Gains 1.086 / 0.961 / 0.953. With
these dyes greys print the most neutral of the three (C*ab at most 0.1 down to the deepest black).
Uncertainty:

* The curve has no y scale, so each dye's lowest value between 400 and 710 nm is taken as zero
  absorbance. The extraction depends on its statistical model (Ohta's method rotated toward block
  dyes).
* The extracted magenta rises again above 660 nm and the yellow above 570 nm. Spectrophotometer
  eigenspectra of the same trailer (Flueckiger et al. 2018, Fig. 16) show almost nothing there, so
  those ranges are left out of the fit as extraction artefacts.
* Those eigenspectra disagree with the extracted curves elsewhere, most in cyan's green absorption
  (0.29 of the peak at 540 nm against 0.06): rms 0.14 (cyan), 0.08 (magenta), 0.07 (yellow) between
  the two, normalised alike. The same lobes fitted to the eigenspectra (read at only 14 wavelengths)
  print the Kodak test images 4.5 ΔE00 away on average and up to 22. This is the largest uncertainty
  of any set.
* Fit: rms 0.009 / 0.018 / 0.015 of the peak (cyan / magenta / yellow), at most 0.044. Printed through
  the engine, the fitted lobes and the digitised curves differ by 0.3 ΔE00 on average, at most 0.9.

**UK — measured (FilmColors, NSMM 12593).** Fitted to FilmColors' "absorbances measured with a
multispectral imaging system from film areas with pure dyes" on a British leader in the National
Science and Media Museum, Bradford (NSMM 12593; date and production not stated). The figure is in
absolute absorbance, so one neutral base density is taken out of all three dyes: 0.08, the lowest
reading in the figure (magenta at 710 nm), which bounds base plus stain from above (the engine adds its
own base density, 0.06). Each dye keeps what it absorbs above that, unwanted absorptions included.
Cyan peaks at 642 nm and falls to half by 685 nm; magenta peaks at 536 nm (main band shape 2.4) and
keeps 0.30 of its peak in the blue (420–440 nm) and 0.23 at 620 nm; yellow peaks at or below 400 nm,
consistent with the "brilliant yellow" direct dyes of the British recipe, and keeps 0.12 at 540 nm. Gains 1.123 / 0.939 / 0.938. With these dyes the deepest shadows (L* under
8) keep a slight tint (C*ab 1.5 to 1.7) that three contrast multipliers cannot balance, a mild case of
the "unwanted hues" in blacks that period sources describe. Uncertainty:

* Whether the absorbance is relative to air or to clear film is not stated. Taking each dye's own
  minimum as its zero instead, as for the extracted curves, moves the print by 1.4 ΔE00 on average on
  a ColorChecker, at most 4.3.
* One sample: the same fit to FilmColors' extracted curves of another British print (NSMM 12484)
  prints 1.8 ΔE00 away on average on the Kodak images, at most 4.5.
* The yellow below 400 nm, where nothing was measured, is an extrapolation (a symmetric band peaking
  at 390 nm); the eye barely sees that range.
* Multispectral bands about 16 nm wide smooth the edges; the spectrophotometer data agree on their
  width.
* Fit: rms 0.008 / 0.007 / 0.010 of the peak, at most 0.030. The fitted lobes and the digitised curves
  print 0.1 ΔE00 apart on average, at most 0.4.

Both measured sets come from a digitisation of the published JPEG figures by colour mask, about ±0.02
absorbance (`tools/colorscience/data/technicolor_dyes_digitised.csv`, with the provenance of every
column); `fit_dyes.py` fits and checks them. Technicolor dyes are reported not to fade in dark storage
(Haines, *Film Atlas*), but the samples' ages are partly unknown.

### [7] Projection — approximation

The lamp is a 5400 K Planckian radiator (carbon arcs were close to daylight; the exact figure varies
by carbon trim). The eye is the CIE 1931 2° standard observer, as tabulated by the CIE (CIE 018:2019)
at 5 nm from 360 to 830 nm, so equal-energy white integrates to xy (0.33331, 0.33329). It is assumed
adapted to the screen white (projector through the clear base), so the print white is mapped to the
display white with a Bradford transform. After adaptation the lamp's colour only produces second-order
interactions with the dyes.

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

**The sRGB print.** Where a print has to be shown in sRGB (a browser without a P3 canvas, the
figures below), it is the finished P3 print (key, flare and exponent applied) converted to sRGB and
brought into sRGB by the same chroma-toward-luminance clip, weighted by Rec. 709 luminance
(`srgb_print` in the prototype, `PrintModel.sRGBPrint`, `srgbPrint`, the web's sRGB canvas). Until
Round 25 there were two: the prototype's sRGB mode, used for the figures, baked the cube in sRGB,
clipped it with P3 weights and applied key and exponent to sRGB channels, while the web's sRGB canvas
did as above. A power per channel does not commute with the matrix, so they differed by up to 0.67
ΔE00. The cube is now always P3, and the fixture carries the sRGB print of every sample, which the
Swift core, the web port and the WebGL canvas path reproduce.

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
* CIE 2019, "Colour-matching functions of CIE 1931 standard colorimetric observer", International
  Commission on Illumination, Vienna, DOI 10.25039/CIE.DS.xvudnb9b (CIE 018:2019, Table 6; CC BY-SA 4.0):
  the observer used in the spectral integration, its 1 nm table taken at every 5 nm from 360 to 830 nm.
  Until Round 25 the engine used the analytic fit of C. Wyman, P.-P. Sloan, P. Shirley, "Simple Analytic
  Approximations to the CIE XYZ Color Matching Functions", JCGT 2(2), 2013, over 380–730 nm; that fit is
  off the table by up to 1.4 % of peak (x̄ at 631 nm), and ISO/CIE 11664-3 asks for at least 380–780 nm.

## Figures

Synthetic charts rendered by `tools/colorscience/make_charts.py` with the shipped parameters (left: scene
values encoded as plain sRGB; right: the Technichrome print, as the sRGB print), regenerated in Round 25:

* `docs/figures/colorchecker_before_after.png` — the 24 ColorChecker patches.
* `docs/figures/hue_sweep_before_after.png` — hue × saturation × value sweep.
* `docs/figures/grey_ramp_before_after.png` — nine-stop grey ramp.
* `docs/figures/skin_ramp_before_after.png` — seven skin colours across a 4.5-stop exposure ramp.
* `docs/figures/iphone_xs_dng_plain_vs_technichrome.jpg` — a CC0 iPhone XS Bayer DNG (raw.pixls.us),
  LibRaw linear decode, plain rendering versus the Technichrome print.
