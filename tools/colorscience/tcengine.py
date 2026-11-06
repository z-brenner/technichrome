"""
tcengine.py — reference implementation of the Technichrome "imbibition model".

Pipeline (per pixel, scene-linear sRGB-primaries RGB in, display-linear RGB out):

  1. exposure            E  = rgb * 2^ev                                 (scene-linear)
  2. three-strip camera  S  = M_sep @ E                                   (separation exposures, white = 1, floored at 1e-6)
  3. negatives           Dn = hd_curve(log10 S)                           (silver density, three B&W negatives)
  4. matrices + dyes     Dd = dye_curve(log10(10^-Dn))                    (dye density transferred per matrix)
  5. key image           Dk = key_curve(log10(10^-Dn_green)) * key        (silver positive from the green record)
  6. spectral print      T(λ) = 10^-(Σ Dd_i a_i(λ) + Dk + Dmin)           (transmittance of the dye-transfer print)
  7. projection          XYZ = ∫ P(λ) T(λ) cmf(λ) dλ, adapted to D65      (carbon-arc projector, eye adapted to screen white)
  8. display             P3 linear, surround compensation, soft gamut clip; an sRGB print is that P3 print
                         converted to sRGB and soft-clipped again with Rec. 709 weights (srgb_print)

Steps 1–5 are cheap analytic per-pixel maths (they live in the Metal kernels on device);
steps 6–7 are baked into a 3D LUT indexed by the three normalised dye densities (each dye's
density over the most of it the print can carry, gain · D max, so every axis of the cube spans
[0, gain · D max]); the key image is a neutral density so it factors out as a plain multiplier
applied after the LUT.

Every number in `DEFAULT_PARAMS` is either (a) a documented property of the process, or (b) an
artistic approximation. The docs/COLOR_SCIENCE.md file states which is which. Nothing here is
a measurement of a real Technicolor print.
"""
from __future__ import annotations
import json
import numpy as np
from dataclasses import dataclass, field, asdict
from scipy.optimize import minimize
import tcspectral as S

L = S.LAMBDA


# ----------------------------------------------------------------------------
# 1. Camera: three-strip separation sensitivities → 3x3 matrix
# ----------------------------------------------------------------------------
def asym_gauss(l, mu, s_left, s_right, p=2.0):
    """Asymmetric generalised Gaussian: exp(-0.5*|(l-mu)/s|^p). p = 2 is a Gaussian; p = 3-4 gives the
    flat-topped, sharp-edged ("block dye") absorption of real dye-transfer dyes and taking filters."""
    s = np.where(l < mu, s_left, s_right)
    return np.exp(-0.5 * np.abs((l - mu) / s) ** p)


@dataclass
class SeparationSensitivities:
    """Approximate effective spectral sensitivities (filter × emulsion × beam-splitter) of the
    three records. Ball (1935): green record = panchromatic negative behind a green filter
    'transmitting green light only'; the bipack sits behind a magenta filter 'transmitting red
    and blue'; its front film is blue-sensitive and carries a blue-absorbing dye coating so that
    the rear panchromatic film receives the red image. The exact curves were never published;
    these are plausible bands consistent with those descriptions (artistic approximation)."""
    red: tuple = (628.0, 30.0, 38.0, 3.0)     # mu, sigma_left, sigma_right (nm), shape exponent
    green: tuple = (545.0, 32.0, 30.0, 3.0)
    blue: tuple = (452.0, 34.0, 27.0, 3.0)

    def curves(self):
        return np.stack([asym_gauss(L, *self.red), asym_gauss(L, *self.green), asym_gauss(L, *self.blue)])


def reconstruct_primary_reflectances(illuminant, primaries_rgb_to_xyz=S.SRGB_TO_XYZ):
    """Find three smooth reflectance spectra in [0,1] whose colours under `illuminant` are the
    pure sRGB primaries, and which sum to a flat spectrum (so white = flat reflectance).
    Used only to derive the separation matrix from the assumed sensitivities."""
    n = len(L)
    cmf = S.CMF
    wxyz = S.spd_to_xyz(illuminant)
    k = 1.0 / wxyz[1]
    targets = [primaries_rgb_to_xyz[:, j] for j in range(3)]  # XYZ (relative to white Y=1) of each primary
    D2 = np.diff(np.eye(n), 2, axis=0)  # smoothness operator

    def loss(flat):
        R = flat.reshape(3, n)
        err = 0.0
        for j in range(3):
            xyz = k * S.spd_to_xyz(illuminant, R[j], cmf)
            err += np.sum((xyz - targets[j]) ** 2) * 200.0
        err += np.sum((R.sum(0) - 1.0) ** 2) * 50.0
        err += np.sum((D2 @ R.T) ** 2) * 0.6
        return err

    x0 = np.stack([asym_gauss(L, 610, 40, 60), asym_gauss(L, 545, 40, 40), asym_gauss(L, 450, 40, 40)]).ravel()
    res = minimize(loss, x0, method='L-BFGS-B', bounds=[(0.0, 1.0)] * (3 * n), options={'maxiter': 3000})
    return res.x.reshape(3, n)


_SEP_CACHE = {}


def derive_separation_matrix(sens: SeparationSensitivities, illuminant=None, verbose=False):
    """M[i, j] = response of record i to sRGB primary j, rows normalised so white → (1,1,1)."""
    if illuminant is None:
        illuminant = S.planck(L, 6504.0)
    key = (sens.red, sens.green, sens.blue, float(illuminant.sum()))
    if key in _SEP_CACHE and not verbose:
        return _SEP_CACHE[key]
    R = reconstruct_primary_reflectances(illuminant)
    C = sens.curves()
    M = np.zeros((3, 3))
    for i in range(3):
        for j in range(3):
            M[i, j] = np.sum(C[i] * illuminant * R[j])
    M /= M.sum(axis=1, keepdims=True)
    _SEP_CACHE[key] = (M, R)
    if verbose:
        for j, name in enumerate('RGB'):
            xyz = S.spd_to_xyz(illuminant, R[j]) / S.spd_to_xyz(illuminant)[1]
            print(f"  primary {name}: reconstructed sRGB = {np.round(S.XYZ_TO_SRGB @ xyz, 3)}")
    return M, R


# ----------------------------------------------------------------------------
# 2. Characteristic curves (negative and matrix/dye)
# ----------------------------------------------------------------------------
def logistic(x):
    return 1.0 / (1.0 + np.exp(-x))


@dataclass
class HDCurve:
    """Generalised H&D curve in density vs log10(exposure): a Richards (generalised logistic) curve.

        g(x) = (1 + nu * exp(-x)) ** (-1/nu),   x = a * (log_e - log_e0) + x_half

    `nu` sets the asymmetry: nu = 1 is the plain logistic; nu -> 0 approaches a Gompertz curve, whose
    toe (low-density end) starts abruptly and whose shoulder approaches D_max slowly. Print materials
    behave like that: a short toe above diffuse white, a steep straight line, a long roll-off into
    maximum density. `log_e0` is the log exposure at half density and `gamma` the slope there."""
    d_min: float
    d_max: float
    gamma: float
    log_e0: float
    nu: float = 1.0

    def __post_init__(self):
        nu = max(self.nu, 1e-4)
        self.x_half = -np.log((2.0 ** nu - 1.0) / nu)
        slope_half = 0.5 * (2.0 ** nu - 1.0) / (nu * 2.0 ** nu)
        span = self.d_max - self.d_min
        self.a = self.gamma / (span * slope_half) if span > 0 else 0.0

    def density(self, log_e):
        nu = max(self.nu, 1e-4)
        x = self.a * (np.asarray(log_e, dtype=np.float64) - self.log_e0) + self.x_half
        g = np.power(1.0 + nu * np.exp(-x), -1.0 / nu)
        return self.d_min + (self.d_max - self.d_min) * g


# ----------------------------------------------------------------------------
# 3. Dyes
# ----------------------------------------------------------------------------
@dataclass
class Dye:
    """Normalised spectral absorbance (peak = 1) as a sum of asymmetric generalised Gaussians:
    (mu, sigma_left, sigma_right, amplitude, shape). The first lobe is the main absorption band — flat-
    topped (shape 3-4) like the acid dyes of imbibition printing, which the dye-transfer literature
    describes as spectrally pure compared with coupler dyes, cyan excepted. The other lobes are the
    'unwanted absorptions' every real dye has (Hunt, The Reproduction of Colour)."""
    lobes: list

    def absorbance(self):
        a = np.zeros_like(L)
        for lobe in self.lobes:
            mu, sl, sr, amp = lobe[:4]
            p = lobe[4] if len(lobe) > 4 else 2.0
            a += amp * asym_gauss(L, mu, sl, sr, p)
        return a / a.max()


@dataclass
class DyeSet:
    cyan: Dye
    magenta: Dye
    yellow: Dye

    def absorbances(self):
        return np.stack([self.cyan.absorbance(), self.magenta.absorbance(), self.yellow.absorbance()])


DEFAULT_DYES = DyeSet(
    cyan=Dye([(652.0, 52.0, 62.0, 1.00, 3.0), (540.0, 45.0, 40.0, 0.22, 2.0), (440.0, 35.0, 35.0, 0.12, 2.0)]),
    magenta=Dye([(545.0, 42.0, 42.0, 1.00, 3.5), (440.0, 40.0, 35.0, 0.22, 2.0), (640.0, 25.0, 40.0, 0.04, 2.0)]),
    yellow=Dye([(445.0, 45.0, 40.0, 1.00, 3.5), (505.0, 15.0, 30.0, 0.08, 2.0)]),
)


# ----------------------------------------------------------------------------
# 4. Parameters
# ----------------------------------------------------------------------------
@dataclass
class EngineParams:
    # exposure
    exposure_ev: float = 0.0
    # camera: the separation matrix is a frozen constant (derived once by derive_separation.py from the
    # assumed sensitivities below; re-deriving at run time is a numerical optimisation whose last digits
    # differ between machines). Rows: red, green, blue record; columns: linear sRGB R, G, B.
    separation_matrix: tuple = ((0.8473, 0.1158, 0.0369), (0.0310, 0.9297, 0.0393), (0.0398, 0.0864, 0.8738))
    sensitivities: SeparationSensitivities = field(default_factory=SeparationSensitivities)
    # negatives (three B&W separation negatives 'developed to equal contrast' — Ball 1935)
    neg_dmin: float = 0.12
    neg_dmax: float = 2.20
    neg_gamma: float = 0.45
    neg_log_e0: float = -1.0539
    neg_nu: float = 0.2001
    # matrices + dye transfer (per dye peak density at full transfer)
    dye_dmax: tuple = (2.8, 2.8, 2.8)
    # Technicolor's per-matrix 'colour control': a density (contrast) multiplier per dye, calibrated so that
    # greys print neutral through the whole scale, plus printer lights (stops) that shift each matrix curve.
    # Lights alone cannot neutralise every grey level: balanced by lights only, this model shows the classic
    # crossover (cyan highlights, red shadows) that period sources describe as blacks with unwanted hues.
    dye_gain: tuple = (1.2022, 0.9087, 0.8892)
    dye_light_ev: tuple = (0.0, 0.0, 0.0)
    mat_gamma: float = 3.2176
    mat_log_e0: float = -1.0621# log10 printing exposure at half density
    mat_nu: float = 0.0253
    # silver key image printed from the green record (used c. 1932–1944)
    key_strength: float = 0.15                 # 0 = none (post-1944 print), 1 = full documented '50 %' image
    key_dmax: float = 1.10
    key_gamma: float = 0.9
    key_log_e0: float = -1.05
    key_nu: float = 0.5
    key_nu: float = 0.5
    # print stock
    print_dmin: float = 0.06                   # clear base + stain, neutral
    # viewing
    projector_cct: float = 5400.0              # carbon arc ~ daylight-ish; adapted away, only 2nd-order effects remain
    surround_exponent: float = 0.92            # dark-surround print viewed on a bright-surround phone
    # Screen flare: stray light added to the projected image as a fraction of screen white. Ball (1935)
    # gives the projected contrast 'from whitest white to blackest black' as about 1 to 64, i.e. 1/64.
    # Off by default: a phone is not a 1935 projection (see docs/COLOR_SCIENCE.md).
    screen_flare: float = 0.0
    # print timing: nudge the printer light so the scene's geometric-mean luminance approaches the target
    timing_strength: float = 0.6
    timing_target: float = 0.16
    timing_limit: float = 1.25
    display: str = 'p3'                        # 'p3', or 'srgb': the P3 print converted by srgb_print
    # spatial (not part of the per-pixel maths; documented here so the preset is complete)
    diffusion_sigma_px_at_4k: float = 1.1      # dye bleed in the gelatin, σ in px for a 4000 px long edge
    bloom_amount: float = 0.0                  # optional negative halation / highlight glow
    bloom_threshold: float = 0.85
    bloom_radius_pct: float = 1.5

    def to_json(self):
        d = asdict(self)
        return json.dumps(d, indent=2)


# ----------------------------------------------------------------------------
# 5. The engine
# ----------------------------------------------------------------------------
class Engine:
    def __init__(self, params: EngineParams | None = None, dyes: DyeSet = DEFAULT_DYES, lut_size=33):
        self.p = params or EngineParams()
        self.dyes = dyes
        self.M_sep = np.array(self.p.separation_matrix, dtype=np.float64)
        self.neg = HDCurve(self.p.neg_dmin, self.p.neg_dmax, self.p.neg_gamma, self.p.neg_log_e0, self.p.neg_nu)
        self.key = HDCurve(0.0, self.p.key_dmax, self.p.key_gamma, self.p.key_log_e0, self.p.key_nu)
        self.mats = [HDCurve(0.0, self.p.dye_dmax[i], self.p.mat_gamma, self.p.mat_log_e0, self.p.mat_nu) for i in range(3)]
        self._build_print_model()
        self.lut_size = lut_size
        self.lut = self.build_lut(lut_size)

    # --- print / projection model --------------------------------------------------------
    def _build_print_model(self):
        p = self.p
        self.A = self.dyes.absorbances()                         # (3, N) normalised absorbances
        self.P = S.planck(L, p.projector_cct)                    # projector SPD
        base_T = 10.0 ** (-p.print_dmin)
        white_xyz = S.spd_to_xyz(self.P * base_T)
        self.white_scale = 1.0 / white_xyz[1]
        src_white = white_xyz * self.white_scale
        self.cat = S.bradford_cat(src_white, S.xy_to_xyz(S.D65_xy))
        # The print, and so the cube, is always Display P3: an sRGB print is the finished P3 print converted
        # (srgb_print), never a cube baked in sRGB, so the key, flare and surround act on the same channels either way.
        self.xyz_to_display = S.XYZ_TO_P3 @ self.cat

    def print_xyz(self, dye_density):
        """dye_density: (..., 3) absolute peak densities of cyan, magenta, yellow → XYZ relative to print white (Y_white = 1)."""
        D = np.einsum('...i,in->...n', dye_density, self.A) + self.p.print_dmin
        T = 10.0 ** (-D)
        xyz = np.einsum('...n,nk->...k', T * self.P, S.CMF) * self.white_scale
        return xyz

    def display_linear_from_densities(self, dye_density):
        xyz = self.print_xyz(dye_density)
        rgb = S.apply_matrix(self.xyz_to_display, xyz)
        return rgb

    # --- LUT ---------------------------------------------------------------------------------
    def dye_ceiling(self):
        """The most of each dye the print carries, gain · D max (absolute peak density): a normalised density of 1.
        Normalising by D max alone let a gain above 1 (cyan's) reach the cube's edge before the other dyes, so the
        deepest blacks lost cyan and turned red; with the gain in the ceiling every dye reaches its edge together."""
        return np.array(self.p.dye_dmax, dtype=np.float64) * np.array(self.p.dye_gain, dtype=np.float64)

    def lut_node_densities(self, n):
        """Absolute dye densities at the nodes of an n³ cube, (n, n, n, 3) indexed [c, m, y]: node j of axis i is
        j/(n−1) · D max_i · gain_i."""
        g = np.linspace(0.0, 1.0, n)
        c, m, y = np.meshgrid(g, g, g, indexing='ij')
        p = self.p
        return np.stack([c * p.dye_dmax[0] * p.dye_gain[0], m * p.dye_dmax[1] * p.dye_gain[1], y * p.dye_dmax[2] * p.dye_gain[2]], axis=-1)

    def build_lut(self, n):
        """The cube, factorised per dye: 10^-(Σ d_i a_i(λ) + Dmin) = T_c(λ) T_m(λ) T_y(λ) 10^-Dmin, so three
        tables of n × wavelengths transmittances replace a power per entry and wavelength (LUTBuilder.swift and
        printModel.ts bake the same way). Equal at every node to soft_clip_gamut(display_linear_from_densities(d)),
        which check_prototype.py asserts."""
        g = np.linspace(0.0, 1.0, n)
        T = [10.0 ** (-np.outer(g * self.p.dye_dmax[i] * self.p.dye_gain[i], self.A[i])) for i in range(3)]   # (n, wavelengths) per dye
        w = (self.P * 10.0 ** (-self.p.print_dmin))[:, None] * S.CMF * self.white_scale   # lamp · base · observer
        xyz = np.einsum('cl,ml,yl,lk->cmyk', T[0], T[1], T[2], w, optimize=True)
        return soft_clip_gamut(S.apply_matrix(self.xyz_to_display, xyz))  # (n, n, n, 3), indexed [c, m, y]

    def lut_lookup(self, norm_dens):
        """Trilinear lookup, norm_dens in [0,1]^3 (..., 3)."""
        n = self.lut_size
        v = np.clip(norm_dens, 0.0, 1.0) * (n - 1)
        i0 = np.floor(v).astype(int)
        i0 = np.clip(i0, 0, n - 2)
        f = v - i0
        out = np.zeros(norm_dens.shape[:-1] + (3,))
        for dc in (0, 1):
            for dm in (0, 1):
                for dy in (0, 1):
                    w = (f[..., 0] if dc else 1 - f[..., 0]) * (f[..., 1] if dm else 1 - f[..., 1]) * (f[..., 2] if dy else 1 - f[..., 2])
                    out += w[..., None] * self.lut[i0[..., 0] + dc, i0[..., 1] + dm, i0[..., 2] + dy]
        return out

    # --- calibration -------------------------------------------------------------------------
    def calibrate_neutral(self, greys=(0.6, 0.18, 0.05), iterations=12):
        """Balance the print so that greys print neutral through the scale, using the per-matrix density
        (contrast) multipliers. Returns the gains."""
        gains = np.array(self.p.dye_gain, dtype=np.float64)
        for _ in range(iterations):
            self.p.dye_gain = tuple(gains)
            errs = []
            for g in greys:
                out = self.develop(np.array([[g, g, g]]), use_lut=False)[0]
                errs.append(out / out.mean() - 1.0)   # +ve = channel too bright = too little of the dye that absorbs it
            e = np.mean(errs, axis=0)
            gains = gains * (1.0 + 0.6 * e)
            gains = gains / gains.mean()
        self.p.dye_gain = tuple(float(x) for x in gains)
        self.lut = self.build_lut(self.lut_size)   # the cube spans gain · D max, so it follows the new gains
        return self.p.dye_gain

    def calibrate_neutral_lights(self, greys=(0.6, 0.18, 0.05), iterations=16):
        """Balance with the printer lights only (an experiment that shows the crossover). Returns the lights."""
        lights = np.array(self.p.dye_light_ev, dtype=np.float64)
        for _ in range(iterations):
            self.p.dye_light_ev = tuple(lights)
            errs = []
            for g in greys:
                out = self.develop(np.array([[g, g, g]]), use_lut=False)[0]
                errs.append(np.log2(np.maximum(out, 1e-6)) - np.log2(max(out.mean(), 1e-6)))
            e = np.mean(errs, axis=0)
            lights = lights + 0.5 * e
            lights = lights - lights.mean()
        self.p.dye_light_ev = tuple(float(x) for x in lights)
        return self.p.dye_light_ev

    # --- per-pixel analytic part ---------------------------------------------------------
    def densities(self, rgb_linear):
        """Scene-linear sRGB-primaries RGB → (dye densities normalised to [0,1] (...,3), key density (...)).

        The separation matrix applies to the scene as it is: a negative component only means the colour lies
        outside sRGB (a wide-gamut RAW colour), not that it is impossible. The record exposures, which cannot be
        negative, are floored before the log; clamping each scene channel first would clip the colour to sRGB.

        Each dye's density, matrix curve × gain, is normalised by gain · D max (`dye_ceiling`), the most of that dye
        the print carries; the gain cancels, so the normalised density is the matrix curve over its own D max, and
        the gain lives in the cube, whose axes span [0, gain · D max]."""
        p = self.p
        E = np.asarray(rgb_linear, dtype=np.float64) * (2.0 ** p.exposure_ev)
        Ssep = S.apply_matrix(self.M_sep, E)
        log_s = np.log10(np.maximum(Ssep, 1e-6))
        Dn = self.neg.density(log_s)
        log_print = -Dn                                  # printing exposure through the negative
        light = np.array(p.dye_light_ev) * np.log10(2.0)
        mat = np.stack([self.mats[i].density(log_print[..., i] + light[i]) for i in range(3)], axis=-1)
        norm = mat / np.array(p.dye_dmax)
        key = self.key.density(log_print[..., 1]) * p.key_strength
        return np.clip(norm, 0.0, 1.0), key

    def develop(self, rgb_linear, use_lut=True):
        """Full per-pixel develop (no spatial stages). Returns display-linear RGB in the chosen display space, [0,1]."""
        norm, key = self.densities(rgb_linear)
        return self.print_densities(norm, key, use_lut)

    def print_densities(self, norm, key, use_lut=True):
        """Normalised dye densities and key density → the print: the cube (or, without it, the print model evaluated
        directly), the key, the screen flare and the viewing exponent, in Display P3; with display='srgb' that print is
        then converted by srgb_print. develop() is densities() and this; develop_dng.develop_image blurs in between."""
        if use_lut:
            rgb = self.lut_lookup(norm)
        else:
            rgb = soft_clip_gamut(self.display_linear_from_densities(norm * self.dye_ceiling()))
        rgb = rgb * (10.0 ** (-key))[..., None]
        if self.p.screen_flare > 0:
            f = self.p.screen_flare
            rgb = (rgb + f) / (1.0 + f)             # projection flare: white stays white, black lifts to f/(1+f)
        rgb = np.power(np.clip(rgb, 0.0, 1.0), self.p.surround_exponent)
        return srgb_print(rgb) if self.p.display == 'srgb' else rgb


def timing_exposure_ev(geometric_mean, target, strength, limit, camera_bias_ev=0.0):
    """Print timing: exposure correction (stops) moving the geometric-mean luminance toward `target`,
    scaled by `strength` and clamped to ±`limit`. The photographer's exposure compensation
    (`camera_bias_ev`) is taken out first so only the camera's automatic placement is corrected.
    Mirrors PrintTiming.swift."""
    if geometric_mean <= 0 or target <= 0 or strength <= 0:
        return 0.0
    placement = geometric_mean / (2.0 ** camera_bias_ev)
    full = np.log2(target / placement)
    return float(np.clip(full * min(max(strength, 0.0), 1.0), -limit, limit))


def geometric_mean_luminance(rgb_linear):
    y = S.luminance_srgb(np.asarray(rgb_linear, dtype=np.float64))
    return float(2.0 ** np.mean(np.log2(np.maximum(y, 1e-6))))


# Luminance weights of the soft clip, rounded as every implementation writes them: the Y row of Display P3 → XYZ, and
# of sRGB (Rec. 709 primaries) → XYZ, both D65.
P3_LUMA = (0.2290, 0.6917, 0.0793)
REC709_LUMA = (0.2126, 0.7152, 0.0722)


def soft_clip_gamut(rgb, luma=P3_LUMA):
    """Bring out-of-gamut colours inside [0,1]: negative components are lifted by desaturating toward
    the pixel's luminance (chroma scaling), then values > 1 are compressed with a soft knee. `luma` are the
    luminance weights of the space `rgb` is in (P3 for the cube, Rec. 709 for the sRGB print)."""
    Y = rgb @ np.array(luma)
    Y = Y[..., None]
    mn = rgb.min(axis=-1, keepdims=True)
    # chroma scale factor so that min component reaches 0 (only where negative)
    t = np.where(mn < 0, Y / np.maximum(Y - mn, 1e-9), 1.0)
    rgb = Y + (rgb - Y) * t
    # soft knee above 0.95
    k = 0.95
    over = rgb > k
    rgb = np.where(over, k + (1 - k) * np.tanh((rgb - k) / (1 - k)), rgb)
    return np.clip(rgb, 0.0, 1.0)


def srgb_print(p3):
    """The sRGB print, one definition for every place that shows one (the web's sRGB canvas, the documentation
    figures, display='srgb', PrintModel's sRGB space in the app and the web): the finished display-linear Display P3
    print (after key, flare and the viewing exponent) converted to linear sRGB, then brought into sRGB with the same
    soft clip, weighted by Rec. 709 luminance."""
    return soft_clip_gamut(S.apply_matrix(S.P3_TO_SRGB, np.asarray(p3, dtype=np.float64)), REC709_LUMA)


if __name__ == '__main__':
    e = Engine()
    print("Separation matrix (rows: red, green, blue record; cols: sRGB R,G,B):")
    print(np.round(e.M_sep, 4))
    greys = np.array([[1.0, 1.0, 1.0], [0.5] * 3, [0.18] * 3, [0.09] * 3, [0.045] * 3, [0.02] * 3, [0.01] * 3, [0.005] * 3, [2.0] * 3, [4.0] * 3])
    out = e.develop(greys)
    for g, o in zip(greys, out):
        print(f"scene {g[0]:6.3f} -> display linear {np.round(o, 4)}  sRGB8 {np.round(S.srgb_encode(o) * 255).astype(int)}")
