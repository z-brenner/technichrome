# First run on an iPhone — checklist

This repository was written and tested without a Mac or an iPhone. CI compiles the app and runs the
engine's GPU tests on a simulator; everything that needs a camera, a RAW decoder with real files, or a
hardware button is still unverified. This is the order in which to check it, and what to note so that a
failure can be fixed from a description.

Before anything else: Xcode 16 or later, an iPhone on iOS 17.2 or later (iOS 18 for Camera Control), your
own signing team on the `Technichrome` target.

1. **Launch.** Grant camera access. The live preview should show the look within a second. If an
   "Engine unavailable" alert appears, note its text: it means the Metal kernels could not be loaded from
   the app bundle, which is a build problem, not a device problem.

2. **Settings → Camera on this iPhone.** This section lists what AVFoundation reported for the current
   lens. Expected on an iPhone 12 or later, 1× lens: a RAW format marked *Bayer*, Video HDR *off*,
   preview colour space *sRGB*, zoom factor 1.00. Note the photo sizes line: on 48 MP sensors it says
   which sizes the format offers; *Max photo* is what was asked for (12 MP unless *Request full sensor
   resolution* is on in Settings). With that setting on, take a Bayer RAW and check the DNG's size in
   the photo information: whether Bayer RAW arrives at 48 MP or the camera delivers 12 MP anyway is
   unknown. Switch to 0.5× and the telephoto and read the section again; the RAW badge in the camera's
   top bar says the same thing in one word.

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

5. **Hardware shutter.** Press a volume button: the shutter should fire on release and the flash overlay
   blink. Open the develop screen (take a picture) and press a volume button again: it should change the
   volume, not take a picture. On an iPhone 16, a light press of the Camera Control should show the
   *Exposure* slider and the *Lens* picker; both must move the on-screen controls, and the on-screen
   controls must move them.

6. **Capture and develop.** Photograph a grey card or a ColorChecker in daylight. The develop screen
   should show the silver key, then yellow, cyan and magenta, then the print. Hold the image to compare
   with Apple's rendering. Open the Laboratory: the *timed* value is the print-timing correction the
   engine measured for this frame. On a correctly exposed 18 % grey card the print should be neutral and
   the timing within about ±0.3 EV; a consistent offset across several frames is the constant between
   Apple's linear decode and the LibRaw path used for tuning (see `docs/RAW_PIPELINE.md`, "Exposure").
   Report that offset: it belongs in the preset.

7. **Export.** *Save* on the develop screen: Photos should show two assets, the print and the DNG (with a
   RAW badge). The print's info panel in Photos should show the camera, exposure and lens, and no
   location. *Share* the print and the DNG to Files and confirm both open.

8. **Import.** Gallery → import a ProRAW from Photos: it should be labelled *Apple ProRAW*. Import a DNG
   from another camera or a converter from Files: *Bayer RAW* if it holds sensor data, *Linear DNG* if
   it was demosaiced. Import a JPEG: it should develop and the record should say *No RAW*.

9. **Load.** Ten captures in a row; a full-resolution develop of a 48 MP ProRAW if the phone has one.
   Note develop times and whether the phone gets hot or the app is killed for memory.

10. **Report.** For anything that fails: the step number, the phone and iOS version, the *Camera on this
    iPhone* section as shown, and the self-test line. For the look itself: a developed print, the DNG,
    and the Laboratory's exported parameters JSON.
