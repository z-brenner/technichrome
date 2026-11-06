# First run on an iPhone — checklist

This repository was written and tested without a Mac or an iPhone. CI compiles the app and runs, on a
simulator, the engine's GPU tests and the develop path end to end on two synthetic DNGs; everything that
needs a camera, Apple's RAW decoder on real files, or a hardware button is still unverified. This is the
order in which to check it, and what to note so that a failure can be fixed from a description.

Before anything else: Xcode 16 or later, an iPhone on iOS 17.2 or later (iOS 18 for Camera Control), your
own signing team on the `Technichrome` target.

1. **Launch.** Grant camera access. The live preview should show the look within a second. If an
   "Engine unavailable" alert appears, note its text: it means the Metal kernels could not be loaded from
   the app bundle, which is a build problem, not a device problem.

2. **Settings → Camera on this iPhone.** This section lists what AVFoundation reported for the current
   lens. Expected on an iPhone 12 or later, 1× lens: a RAW format marked *Bayer*, Video HDR *off*,
   preview colour space *sRGB*, zoom factor 1.00, *Session* running. Note the photo sizes line: on 48 MP
   sensors it says which sizes the format offers; *Max photo* is what was asked for (12 MP unless *Request
   full sensor resolution* is on in Settings). With that setting on, take a Bayer RAW and check the DNG's
   size in the photo information: whether Bayer RAW arrives at 48 MP or the camera delivers 12 MP anyway
   is unknown. Switch to 0.5× and the telephoto and read the section again; the RAW badge in the camera's
   top bar says the same thing in one word.
   Since Round 24 a lens change is one configuration of the running session, and the photo size is chosen
   after it is committed. Switch lenses a few times: the change should be quick, with no black frame longer
   than an instant. After each switch, and after toggling full resolution, *Max photo* must be one of that
   lens's *Photo sizes*. *Apple ProRAW* must read *supported, off* on a lens with a Bayer format, also after
   visiting one without (where it reads *supported, enabled*).

3. **Settings → Run engine self-test.** Expected: *Passed*, worst error around 0.002 (CI measures 0.0023
   on the simulator). A failure here means this phone's GPU disagrees with the CPU reference — report the
   number and the sample index.

4. **Preview.** Toggle *look / plain*. Tap: the reticle should land where you tapped and the camera
   should focus there (the mapping from the rotated preview to sensor coordinates is untested). Drag
   vertically: the EV readout should move in thirds of a stop and the preview brightness follow. Long
   press: *ae · af locked* should appear and the exposure must not change when you point at a brighter
   area; a tap unlocks. Recompose after a tap-to-focus: the focus should return to continuous mode on
   its own. Double tap resets. Watch for dropped frames when panning; note the phone model if the
   preview stutters.
   Since Round 24 the frames are turned upright in Core Image instead of by AVFoundation, and drawn as they
   arrive instead of on a display timer. With each lens: the preview must be upright and not mirrored, and
   stay so while the phone turns through all four orientations (the interface is portrait only, so it
   should behave exactly as before); a tap must still focus where tapped. Panning should be at least as
   smooth as before. Go to the gallery and back a few times: the preview should return without a stutter
   (the renderer is no longer rebuilt).

5. **Hardware shutter.** Press a volume button: the shutter should fire on release and the flash overlay
   blink. Open the develop screen (take a picture) and press a volume button again: it should change the
   volume, not take a picture. On an iPhone 16, a light press of the Camera Control should show the
   *Exposure* slider and the *Lens* picker; both must move the on-screen controls, and the on-screen
   controls must move them.

6. **Interruptions.** With the camera open: take or place a phone call, trigger Siri, and return to
   Technichrome during a FaceTime video call kept in Picture in Picture. Expected each time: *camera
   interrupted* over the preview with the reason, the shutter dimmed and the volume buttons changing the
   volume; when the interruption ends the preview returns by itself. Settings → *Last interruption* shows
   the reason: note it. With Developer Mode on, Settings → Developer → *Reset Media Services* while the
   camera is open: the camera should restart by itself, once; if it shows *camera stopped* and *Restart
   camera*, press it and note that it was needed. A black preview with no message, or a shutter that
   fires into nothing, is a failure.

7. **Capture and develop.** Photograph a grey card or a ColorChecker in daylight. The develop screen
   should show the silver key, then yellow, cyan and magenta, then the print. Hold the image to compare
   with Apple's rendering. Open the Laboratory: the *timed* value is the print-timing correction the
   engine measured for this frame. On a correctly exposed 18 % grey card the print should be neutral and
   the timing within about ±0.3 EV; a consistent offset across several frames is the constant between
   Apple's linear decode and the LibRaw path used for tuning (see `docs/RAW_PIPELINE.md`, "Exposure").
   Report that offset: it belongs in the preset.
   Since Round 24: the camera is stopped while the develop screen is open, and when it closes the preview
   should be back within about half a second (note the delay). *Lab* on the develop screen opens the
   Laboratory over it (before, the button did nothing). Move *Timing strength*: the preview and the timing
   note must change; *Re-develop*, then the photo's information panel must show that timing on its *Print*
   line, and *Decoder* the CIRAWFilter version. Do the same from a photograph in the gallery (detail →
   *Lab*): the print shown should be the re-developed one when the Laboratory closes. Sliders should follow
   the finger closely (the Laboratory no longer re-runs the RAW decoder on every movement).

8. **Export.** *Save* on the develop screen: Photos should show two assets, the print and the DNG (with a
   RAW badge). The print's info panel in Photos should show the camera, exposure and lens, and no
   location. *Share* the print and the DNG to Files and confirm both open. Then deny Photos access in the
   system Settings and press *Save* again: a *Could not save to Photos* alert, and the develop screen stays.

9. **Import.** Gallery → import a ProRAW from Photos: it should be labelled *Apple ProRAW*. Import a DNG
   from another camera or a converter from Files: *Bayer RAW* if it holds sensor data, *Linear DNG* if
   it was demosaiced. Import a JPEG: it should develop and the record should say *No RAW*.

10. **Load and heat.** Ten captures in a row; a full-resolution develop of a 48 MP ProRAW if the phone has
    one. Note develop times and whether the phone gets hot or the app is killed for memory. The dye-order
    reveal should stay smooth during the 48 MP develop (which now runs at low GPU priority). Then leave the
    camera running with the look for ten minutes and read Settings → *System pressure*; note the highest
    level seen. From *serious* the preview should show *warm · preview slowed* (15–20 fps); from
    *critical*, *hot · plain preview*; if the camera stops for heat, the preview says so and resumes when
    the phone cools. None of these thresholds has been seen on a device yet.

11. **Decode measurement (debug build).** Import the two sample DNGs of the decode-fidelity review (the
    iPhone XS Bayer DNG and the iPhone 12 Pro ProRAW), open each one's information panel and press *Write
    linear decodes (TIFF)*. It writes CIRAWFilter's linear output at full resolution, noise reduction 0,
    with lens correction on and off and highlight recovery on and off (settable from iOS 26 with an
    Xcode 26 build; otherwise one decode, marked `hr-default`), as half-float TIFFs in extended linear sRGB
    without the baseline exposure. Share them with the report: compared with the review's reference DNG
    pipeline (corner falloff, colour error, clipped-area chroma, the shadow floor), they replace its
    inferences about Apple's decoder with numbers. Note the decoder version and highlight-recovery line of
    the panel.

12. **Report.** For anything that fails: the step number, the phone and iOS version, the *Camera on this
    iPhone* section as shown (with its *Session*, *System pressure* and *Last interruption* lines), and the
    self-test line. For the look itself: a developed print, the DNG, the photo's *Decoder* line, and the
    Laboratory's exported parameters JSON.
