"""CI check for the Python prototype: the engine's defaults must reproduce the committed Swift parity
fixture (so the shipped Swift numbers equal the prototype's), and a few look invariants must hold."""
import json, os, sys
import numpy as np
import tcengine as T
import tcspectral as S
from export_fixtures import VARIANTS, dye_set_json, params_to_swift_json, variant_engine, variant_name

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
FIXTURE = os.path.join(ROOT, 'Tests', 'TechnichromeCoreTests', 'Fixtures', 'parity.json')


def check_parameters(current, fixture_parameters):
    for k, v in current.items():
        fv = fixture_parameters[k]
        if isinstance(v, (float, int)):
            assert abs(float(v) - float(fv)) < 1e-9, f"parameter {k} drifted: fixture {fv} vs prototype {v}"
        elif isinstance(v, list) and v and isinstance(v[0], (float, int)):
            assert np.allclose(v, fv, atol=1e-9), f"parameter {k} drifted: fixture {fv} vs prototype {v}"
        else:
            assert v == fv, f"parameter {k} drifted: fixture {fv} vs prototype {v}"


def worst_output_error(eng, samples):
    """Worst error over the fixture's P3 outputs and its sRGB prints; the sRGB print through display='srgb' must be
    the same as srgb_print of the P3 print (one definition)."""
    srgb_engine = T.Engine(T.EngineParams(**{**eng.p.__dict__, 'display': 'srgb'}), dyes=eng.dyes, lut_size=eng.lut_size)
    worst = 0.0
    for s in samples:
        a = np.array([s['input']])
        out = eng.develop(a)[0]
        srgb = srgb_engine.develop(a)[0]
        worst = max(worst, float(np.max(np.abs(out - np.array(s['output'])))), float(np.max(np.abs(srgb - np.array(s['outputSRGB'])))))
        assert np.array_equal(srgb, T.srgb_print(out)), "display='srgb' is not srgb_print of the P3 print"
    return worst


def lab_of_p3(rgb):
    """CIELAB (D65, white Y = 1) of display-linear Display P3."""
    t = S.apply_matrix(S.P3_TO_XYZ, np.asarray(rgb, dtype=np.float64)) / (S.P3_TO_XYZ @ np.ones(3))
    f = np.where(t > 216 / 24389, np.cbrt(t), (24389 / 27 * t + 16) / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def check_observer():
    """The observer is the CIE 1931 2° table (CIE 018:2019) at 5 nm from 360 to 830 nm: equal-energy white sits at
    xy (1/3, 1/3) and ȳ integrates to the CIE's sum."""
    assert S.LAMBDA[0] == 360.0 and S.LAMBDA[-1] == 830.0 and len(S.LAMBDA) == 95 == len(S.CMF)
    xyz = S.CMF.sum(axis=0)
    x, y = xyz[0] / xyz.sum(), xyz[1] / xyz.sum()
    assert abs(x - 1 / 3) < 1e-4 and abs(y - 1 / 3) < 1e-4, f"equal-energy white at xy ({x:.5f}, {y:.5f})"
    assert abs(xyz[1] * 5.0 - 106.857) < 0.01, xyz[1] * 5.0
    assert tuple(S.CMF[39]) == (0.5120501, 1.0, 0.005749999), "555 nm row"
    return x, y


def main():
    ee = check_observer()
    eng = T.Engine(lut_size=17)
    fx = json.load(open(FIXTURE))
    # 1. parameters in the fixture == current defaults (and the variants == the defaults with their overrides)
    check_parameters(params_to_swift_json(eng), fx['parameters'])
    assert [b['name'] for b in fx['variants']] == [name for name, _ in VARIANTS], "fixture variants differ from export_fixtures.VARIANTS"
    engines = [(eng, fx['samples'])]
    for (name, overrides), block in zip(VARIANTS, fx['variants']):
        ve = variant_engine(overrides)
        check_parameters(params_to_swift_json(ve, name=variant_name(name)), block['parameters'])
        engines.append((ve, block['samples']))
    # 1b. the dye sets: the fixture's are the prototype's (the Swift and web presets are checked against the fixture's),
    # "Technichrome v1" is the shipped dyes and gains, and every set's gains still print greys neutral, i.e. they are
    # what calibrate_neutral gives with the current look (to the four decimals they carry)
    assert fx['dyeSets'] == [dye_set_json(ds) for ds in T.DYE_SETS.values()], "fixture dye sets differ from tcengine.DYE_SETS"
    v1 = T.DYE_SETS['Technichrome v1']
    assert v1.dyes is T.DEFAULT_DYES and tuple(v1.gains) == tuple(T.EngineParams().dye_gain)
    assert {o.get('dye_set') for _, o in VARIANTS} >= {n for n in T.DYE_SETS if n != 'Technichrome v1'}, "a measured dye set has no fixture block"
    for name, ds in T.DYE_SETS.items():
        g = T.Engine(T.EngineParams(dye_gain=ds.gains), dyes=ds.dyes, lut_size=5).calibrate_neutral()
        assert np.max(np.abs(np.array(g) - np.array(ds.gains))) < 1e-4, f"{name}: gains {ds.gains} no longer balance greys ({np.round(g, 4)}); run set_params.py --calibrate"
    # 2. outputs reproduce, for the shipped look and every variant
    worst = max(worst_output_error(e, samples) for e, samples in engines)
    assert worst < 1e-6, f"fixture outputs drifted by {worst}"
    # 2b. the factorised cube equals the print model evaluated directly at every node (+ the soft clip)
    for p, n in ((T.EngineParams(), 33), (T.EngineParams(dye_dmax=(3.1, 2.6, 2.3), projector_cct=4800.0), 17)):
        e = T.Engine(p, lut_size=n)
        direct = T.soft_clip_gamut(e.display_linear_from_densities(e.lut_node_densities(n)))
        cube_err = float(np.max(np.abs(e.lut - direct)))
        assert cube_err < 1e-6, f"factorised cube differs from direct evaluation by {cube_err} at {n}³"
    # 3. invariants: neutral stays neutral and monotonic (with every dye set); saturated red stays red and dark
    for name, ds in T.DYE_SETS.items():
        e = eng if name == 'Technichrome v1' else T.Engine(T.EngineParams(dye_gain=ds.gains), dyes=ds.dyes, lut_size=17)
        last = 1e9
        for stop in np.arange(2.0, -8.0, -0.5):
            g = 2.0 ** stop
            out = e.develop(np.array([[g, g, g]]))[0]
            y = out.mean()
            assert y <= last + 1e-9, f"{name}: grey scale not monotonic at {stop}"
            if y > 0.01:
                assert abs(out[0] - out[1]) / y < 0.12 and abs(out[2] - out[1]) / y < 0.12, f"{name}: grey not neutral at {stop}: {out}"
            last = y
    # 3b. the deepest blacks keep the hue of the shadows: every dye reaches the edge of its cube together (each axis
    # spans gain · D max), so cyan does not run out first and turn the blacks red (C*ab was 1.4 at 2^-14 when the
    # cube stopped at D max)
    for stop in np.arange(-7.0, -14.5, -1.0):
        g = 2.0 ** stop
        chroma = float(np.hypot(*lab_of_p3(eng.develop(np.array([[g, g, g]]))[0])[1:]))
        assert chroma < 1.0, f"black not neutral at {stop}: C*ab {chroma:.2f}"
    red = eng.develop(np.array([[0.42, 0.04, 0.045]]))[0]
    assert red[0] > 2.5 * red[1] and red[0] > 2.5 * red[2], f"red not red: {red}"
    assert red[0] < 0.42, f"red should print darker than the scene (subtractive): {red}"
    # 4. timing: a half-stop-dark scene gets a positive, clamped correction
    ev = T.timing_exposure_ev(geometric_mean=0.09, target=0.16, strength=0.6, limit=1.25)
    assert 0.4 < ev < 0.6, ev
    assert T.timing_exposure_ev(0.001, 0.16, 1.0, 1.25) == 1.25
    # the photographer's -1 EV halves the RAW but must not change the timing
    assert abs(T.timing_exposure_ev(0.045, 0.16, 0.6, 1.25, camera_bias_ev=-1.0) - T.timing_exposure_ev(0.09, 0.16, 0.6, 1.25)) < 1e-12
    # 5. screen flare: Ball's 1:64 lifts the deepest black to about 1/64 of white and leaves white alone
    assert eng.p.screen_flare == 0.0, "the shipped look has no screen flare"
    pf = T.EngineParams(screen_flare=1.0 / 64.0)
    ef = T.Engine(pf, lut_size=17)
    b = ef.develop(np.array([[0.0, 0.0, 0.0]]))[0]
    w = ef.develop(np.array([[4.0, 4.0, 4.0]]))[0]
    assert b.min() > (1.0 / 65.0) ** pf.surround_exponent * 0.98, f"flare floor missing: {b}"
    assert w.min() > 0.9, f"flare must not dim white: {w}"
    print(f"prototype OK: fixture reproduced (max err {worst:.2e}), invariants hold, equal-energy white at xy ({ee[0]:.5f}, {ee[1]:.5f})")


if __name__ == '__main__':
    main()
