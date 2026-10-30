"""Export (a) the engine parameters in the Swift EngineParameters JSON schema and (b) a parity fixture
(inputs → dye densities, key density, outputs) so the Swift unit tests can verify the port.

usage: python3 export_fixtures.py ../../Tests/TechnichromeCoreTests/Fixtures/parity.json
"""
import sys, json
import numpy as np
import tcengine as T


def curve_json(dmin, dmax, gamma, log_e0, nu):
    return {"dMin": dmin, "dMax": dmax, "gamma": gamma, "logE0": log_e0, "nu": nu}


def dye_json(dye):
    return {"lobes": [{"mu": l[0], "sigmaLeft": l[1], "sigmaRight": l[2], "amplitude": l[3], "shape": (l[4] if len(l) > 4 else 2.0)} for l in dye.lobes]}


def params_to_swift_json(eng: T.Engine, name="Technichrome v1"):
    p = eng.p
    return {
        "exposureEV": p.exposure_ev,
        "separationMatrix": [float(v) for v in eng.M_sep.ravel()],
        "negative": curve_json(p.neg_dmin, p.neg_dmax, p.neg_gamma, p.neg_log_e0, p.neg_nu),
        "dyeDMax": list(p.dye_dmax), "dyeGain": list(p.dye_gain), "dyeLightEV": list(p.dye_light_ev),
        "matrixGamma": p.mat_gamma, "matrixLogE0": p.mat_log_e0, "matrixNu": p.mat_nu,
        "keyStrength": p.key_strength,
        "key": curve_json(0.0, p.key_dmax, p.key_gamma, p.key_log_e0, p.key_nu),
        "printDMin": p.print_dmin, "projectorCCT": p.projector_cct,
        "cyan": dye_json(eng.dyes.cyan), "magenta": dye_json(eng.dyes.magenta), "yellow": dye_json(eng.dyes.yellow),
        "surroundExponent": p.surround_exponent, "screenFlare": p.screen_flare,
        "timingStrength": p.timing_strength, "timingTarget": p.timing_target, "timingLimit": p.timing_limit,
        "diffusionSigmaAt4K": p.diffusion_sigma_px_at_4k, "misregistrationAt4K": 0.0,
        "bloomAmount": p.bloom_amount, "bloomThreshold": p.bloom_threshold, "bloomRadiusPercent": p.bloom_radius_pct,
        "name": name,
    }


def swift_literal(eng: T.Engine):
    """Print the Swift source for EngineParameters.technichromeV1's numeric fields."""
    p = eng.p
    m = eng.M_sep
    out = []
    out.append(f"        separationMatrix: [{m[0,0]:.4f}, {m[0,1]:.4f}, {m[0,2]:.4f},\n                           {m[1,0]:.4f}, {m[1,1]:.4f}, {m[1,2]:.4f},\n                           {m[2,0]:.4f}, {m[2,1]:.4f}, {m[2,2]:.4f}],")
    out.append(f"        negative: CurveParameters(dMin: {p.neg_dmin}, dMax: {p.neg_dmax}, gamma: {p.neg_gamma:.4f}, logE0: {p.neg_log_e0:.4f}, nu: {p.neg_nu:.4f}),")
    out.append(f"        dyeDMax: [{p.dye_dmax[0]}, {p.dye_dmax[1]}, {p.dye_dmax[2]}],")
    out.append(f"        dyeGain: [{p.dye_gain[0]:.4f}, {p.dye_gain[1]:.4f}, {p.dye_gain[2]:.4f}],")
    out.append(f"        dyeLightEV: [{p.dye_light_ev[0]:.4f}, {p.dye_light_ev[1]:.4f}, {p.dye_light_ev[2]:.4f}],")
    out.append(f"        matrixGamma: {p.mat_gamma:.4f}, matrixLogE0: {p.mat_log_e0:.4f}, matrixNu: {p.mat_nu:.4f},")
    out.append(f"        keyStrength: {p.key_strength},")
    out.append(f"        key: CurveParameters(dMin: 0, dMax: {p.key_dmax}, gamma: {p.key_gamma}, logE0: {p.key_log_e0}, nu: {p.key_nu}),")
    out.append(f"        printDMin: {p.print_dmin},")
    out.append(f"        projectorCCT: {p.projector_cct},")
    for name, dye in (("cyan", eng.dyes.cyan), ("magenta", eng.dyes.magenta), ("yellow", eng.dyes.yellow)):
        lobes = ",\n                                  ".join(f"DyeLobe(mu: {l[0]}, sigmaLeft: {l[1]}, sigmaRight: {l[2]}, amplitude: {l[3]:.2f}, shape: {(l[4] if len(l) > 4 else 2.0)})" for l in dye.lobes)
        out.append(f"        {name}: DyeSpectrum(lobes: [{lobes}]),")
    out.append(f"        surroundExponent: {p.surround_exponent}, screenFlare: {p.screen_flare},")
    out.append(f"        timingStrength: {p.timing_strength}, timingTarget: {p.timing_target}, timingLimit: {p.timing_limit},")
    out.append(f"        diffusionSigmaAt4K: {p.diffusion_sigma_px_at_4k},")
    return "\n".join(out)


if __name__ == '__main__':
    eng = T.Engine(lut_size=17)
    rng = np.random.default_rng(3)
    inputs = [[1, 1, 1], [0.18, 0.18, 0.18], [0.02, 0.02, 0.02], [3.0, 3.0, 3.0], [0.42, 0.04, 0.045], [0.05, 0.3, 0.06],
              [0.04, 0.05, 0.5], [0.6, 0.5, 0.1], [0.5, 0.3, 0.2], [0.2, 0.12, 0.09], [0.0, 0.0, 0.0], [0.9, 0.02, 0.6]]
    inputs += (rng.random((20, 3)) ** 2 * 1.5).tolist()
    samples = []
    for inp in inputs:
        a = np.array([inp], dtype=np.float64)
        norm, key = eng.densities(a)
        out = eng.develop(a)
        samples.append({"input": [float(v) for v in inp], "dye": [float(v) for v in norm[0]], "key": float(key[0]), "output": [float(v) for v in out[0]]})
    fixture = {"parameters": params_to_swift_json(eng), "lutDimension": 17, "displaySpace": eng.p.display, "samples": samples}
    path = sys.argv[1] if len(sys.argv) > 1 else 'parity.json'
    json.dump(fixture, open(path, 'w'), indent=1)
    print('wrote', path, len(samples), 'samples')
    if '--swift' in sys.argv:
        print(swift_literal(eng))
