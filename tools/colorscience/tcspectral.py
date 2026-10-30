"""
tcspectral.py — spectral colour toolkit for the Technichrome colour-science prototype.

Everything here is plain numpy. It is the reference implementation that the Swift
engine (Technichrome/Engine/Core) mirrors; the Swift unit tests check against the
numbers produced by this file.

Conventions
-----------
* Wavelength grid: 380–730 nm in 5 nm steps (71 samples).
* XYZ are CIE 1931 2° observer values, computed with the multi-lobe Gaussian
  fit of Wyman, Sloan & Shirley (2013), "Simple Analytic Approximations to the
  CIE XYZ Color Matching Functions", JCGT 2(2). Max error of that fit is well
  under 1 % of peak, which is far below the uncertainties of the dye model.
* All RGB spaces are linear unless the function name says otherwise.
"""
from __future__ import annotations
import numpy as np

LAMBDA = np.arange(380.0, 730.0 + 1e-6, 5.0)  # 71 samples


# ----------------------------------------------------------------------------
# Colour-matching functions (Wyman–Sloan–Shirley 2013 multi-lobe fit)
# ----------------------------------------------------------------------------
def _lobe(l, mu, s1, s2):
    s = np.where(l < mu, s1, s2)
    return np.exp(-0.5 * ((l - mu) / s) ** 2)


def cie1931_xyz_bar(l=LAMBDA):
    l = np.asarray(l, dtype=np.float64)
    x = 1.056 * _lobe(l, 599.8, 37.9, 31.0) + 0.362 * _lobe(l, 442.0, 16.0, 26.7) - 0.065 * _lobe(l, 501.1, 20.4, 26.2)
    y = 0.821 * _lobe(l, 568.8, 46.9, 40.5) + 0.286 * _lobe(l, 530.9, 16.3, 31.1)
    z = 1.217 * _lobe(l, 437.0, 11.8, 36.0) + 0.681 * _lobe(l, 459.0, 26.0, 13.8)
    return np.stack([x, y, z], axis=-1)  # (N, 3)


CMF = cie1931_xyz_bar()


# ----------------------------------------------------------------------------
# Illuminants
# ----------------------------------------------------------------------------
def planck(l_nm, T):
    """Relative spectral radiance of a black body at temperature T (K), peak-normalised."""
    l = np.asarray(l_nm, dtype=np.float64) * 1e-9
    c1 = 3.741771e-16
    c2 = 1.438776e-2
    B = c1 / (l ** 5) / (np.exp(c2 / (l * T)) - 1.0)
    return B / B.max()


def spd_to_xyz(spd, reflectance=None, cmf=CMF):
    """Integrate an SPD (optionally multiplied by a reflectance/transmittance) against the CMFs.
    Returns un-normalised XYZ (caller normalises against the illuminant white)."""
    s = np.asarray(spd, dtype=np.float64)
    if reflectance is not None:
        s = s * reflectance
    return s @ cmf


def xyz_of_illuminant(spd, cmf=CMF):
    xyz = spd_to_xyz(spd, cmf=cmf)
    return xyz / xyz[1]


# ----------------------------------------------------------------------------
# Chromaticities and RGB colour spaces
# ----------------------------------------------------------------------------
D65_xy = (0.3127, 0.3290)
SRGB_PRIMARIES = ((0.64, 0.33), (0.30, 0.60), (0.15, 0.06))
P3_PRIMARIES = ((0.680, 0.320), (0.265, 0.690), (0.150, 0.060))


def xy_to_xyz(xy, Y=1.0):
    x, y = xy
    return np.array([x * Y / y, Y, (1.0 - x - y) * Y / y])


def rgb_to_xyz_matrix(primaries, white_xy):
    """Standard derivation: columns are the XYZ of the primaries scaled so that RGB=(1,1,1) → white."""
    cols = []
    for (x, y) in primaries:
        cols.append([x / y, 1.0, (1.0 - x - y) / y])
    M = np.array(cols).T  # 3x3, columns = primaries
    W = xy_to_xyz(white_xy)
    S = np.linalg.solve(M, W)
    return M * S[None, :]


SRGB_TO_XYZ = rgb_to_xyz_matrix(SRGB_PRIMARIES, D65_xy)
XYZ_TO_SRGB = np.linalg.inv(SRGB_TO_XYZ)
P3_TO_XYZ = rgb_to_xyz_matrix(P3_PRIMARIES, D65_xy)
XYZ_TO_P3 = np.linalg.inv(P3_TO_XYZ)
SRGB_TO_P3 = XYZ_TO_P3 @ SRGB_TO_XYZ
P3_TO_SRGB = np.linalg.inv(SRGB_TO_P3)

BRADFORD = np.array([[0.8951, 0.2664, -0.1614],
                     [-0.7502, 1.7135, 0.0367],
                     [0.0389, -0.0685, 1.0296]])


def bradford_cat(src_white_xyz, dst_white_xyz):
    """3x3 matrix adapting XYZ from src white to dst white (both Y=1)."""
    src = BRADFORD @ src_white_xyz
    dst = BRADFORD @ dst_white_xyz
    D = np.diag(dst / src)
    return np.linalg.inv(BRADFORD) @ D @ BRADFORD


# ----------------------------------------------------------------------------
# Transfer functions
# ----------------------------------------------------------------------------
def srgb_encode(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, 12.92 * v, 1.055 * np.power(v, 1 / 2.4) - 0.055)


def srgb_decode(v):
    v = np.asarray(v, dtype=np.float64)
    return np.where(v <= 0.04045, v / 12.92, np.power((v + 0.055) / 1.055, 2.4))


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def apply_matrix(M, img):
    """Apply a 3x3 matrix to an (..., 3) array."""
    return np.einsum('ij,...j->...i', M, img)


def luminance_srgb(rgb_lin):
    return apply_matrix(SRGB_TO_XYZ, rgb_lin)[..., 1]
