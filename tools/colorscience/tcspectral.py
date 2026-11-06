"""
tcspectral.py — spectral colour toolkit for the Technichrome colour-science prototype.

Everything here is plain numpy. It is the reference implementation that the Swift
engine (Technichrome/Engine/Core) mirrors; the Swift unit tests check against the
numbers produced by this file.

Conventions
-----------
* Wavelength grid: 360–830 nm in 5 nm steps (95 samples), the range of the CIE
  tables (ISO/CIE 11664-3 asks for at least 380–780 nm at 5 nm or finer).
* XYZ are CIE 1931 2° standard observer values: the CIE's own table (CIE 018:2019,
  Table 6; the CIE data set DOI 10.25039/CIE.DS.xvudnb9b, at 1 nm), taken at every
  5 nm, digits as published. Until Round 25 the engine used the multi-lobe fit of
  Wyman, Sloan & Shirley (2013), which is off the table by up to 1.4 % of peak.
* All RGB spaces are linear unless the function name says otherwise.
"""
from __future__ import annotations
import numpy as np

LAMBDA = np.arange(360.0, 830.0 + 1e-6, 5.0)  # 95 samples


# ----------------------------------------------------------------------------
# Colour-matching functions: the CIE 1931 2° standard observer, tabulated
# ----------------------------------------------------------------------------
# The engine integrates against the CIE's own table (equal-energy white comes out at xy (0.33331, 0.33329));
# SpectralMath.swift and web/src/engine/spectral.ts carry the same rows in the same kind of block.

# BEGIN DATA: CIE 1931 2° colour-matching functions ================================================
# Source: CIE 2019, "Colour-matching functions of CIE 1931 standard colorimetric observer", International
#   Commission on Illumination (CIE), Vienna. DOI 10.25039/CIE.DS.xvudnb9b,
#   https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer (file CIE_xyz_1931_2deg.csv;
#   original source CIE 018:2019, The Basis of Physical Photometry, Table 6).
# Licence: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0),
#   https://creativecommons.org/licenses/by-sa/4.0/
# Changes: values unchanged, sampled every 5 nm. The CIE tabulates 360-830 nm at 1 nm; this block keeps its rows at
#   360, 365, ..., 830 nm (95 rows), digits as published (trailing zeros dropped).
CIE1931_2DEG = (   # (x̄, ȳ, z̄) at 360, 365, …, 830 nm
    (0.0001299, 0.000003917, 0.0006061),  # 360
    (0.0002321, 0.000006965, 0.001086),  # 365
    (0.0004149, 0.00001239, 0.001946),  # 370
    (0.0007416, 0.00002202, 0.003486),  # 375
    (0.001368, 0.000039, 0.006450001),  # 380
    (0.002236, 0.000064, 0.01054999),  # 385
    (0.004243, 0.00012, 0.02005001),  # 390
    (0.00765, 0.000217, 0.03621),  # 395
    (0.01431, 0.000396, 0.06785001),  # 400
    (0.02319, 0.00064, 0.1102),  # 405
    (0.04351, 0.00121, 0.2074),  # 410
    (0.07763, 0.00218, 0.3713),  # 415
    (0.13438, 0.004, 0.6456),  # 420
    (0.21477, 0.0073, 1.0390501),  # 425
    (0.2839, 0.0116, 1.3856),  # 430
    (0.3285, 0.01684, 1.62296),  # 435
    (0.34828, 0.023, 1.74706),  # 440
    (0.34806, 0.0298, 1.7826),  # 445
    (0.3362, 0.038, 1.77211),  # 450
    (0.3187, 0.048, 1.7441),  # 455
    (0.2908, 0.06, 1.6692),  # 460
    (0.2511, 0.0739, 1.5281),  # 465
    (0.19536, 0.09098, 1.28764),  # 470
    (0.1421, 0.1126, 1.0419),  # 475
    (0.09564, 0.13902, 0.8129501),  # 480
    (0.05795001, 0.1693, 0.6162),  # 485
    (0.03201, 0.20802, 0.46518),  # 490
    (0.0147, 0.2586, 0.3533),  # 495
    (0.0049, 0.323, 0.272),  # 500
    (0.0024, 0.4073, 0.2123),  # 505
    (0.0093, 0.503, 0.1582),  # 510
    (0.0291, 0.6082, 0.1117),  # 515
    (0.06327, 0.71, 0.07824999),  # 520
    (0.1096, 0.7932, 0.05725001),  # 525
    (0.1655, 0.862, 0.04216),  # 530
    (0.2257499, 0.9148501, 0.02984),  # 535
    (0.2904, 0.954, 0.0203),  # 540
    (0.3597, 0.9803, 0.0134),  # 545
    (0.4334499, 0.9949501, 0.008749999),  # 550
    (0.5120501, 1.0, 0.005749999),  # 555
    (0.5945, 0.995, 0.0039),  # 560
    (0.6784, 0.9786, 0.002749999),  # 565
    (0.7621, 0.952, 0.0021),  # 570
    (0.8425, 0.9154, 0.0018),  # 575
    (0.9163, 0.87, 0.001650001),  # 580
    (0.9786, 0.8163, 0.0014),  # 585
    (1.0263, 0.757, 0.0011),  # 590
    (1.0567, 0.6949, 0.001),  # 595
    (1.0622, 0.631, 0.0008),  # 600
    (1.0456, 0.5668, 0.0006),  # 605
    (1.0026, 0.503, 0.00034),  # 610
    (0.9384, 0.4412, 0.00024),  # 615
    (0.8544499, 0.381, 0.00019),  # 620
    (0.7514, 0.321, 0.0001),  # 625
    (0.6424, 0.265, 0.00004999999),  # 630
    (0.5419, 0.217, 0.00003),  # 635
    (0.4479, 0.175, 0.00002),  # 640
    (0.3608, 0.1382, 0.00001),  # 645
    (0.2835, 0.107, 0.0),  # 650
    (0.2187, 0.0816, 0.0),  # 655
    (0.1649, 0.061, 0.0),  # 660
    (0.1212, 0.04458, 0.0),  # 665
    (0.0874, 0.032, 0.0),  # 670
    (0.0636, 0.0232, 0.0),  # 675
    (0.04677, 0.017, 0.0),  # 680
    (0.0329, 0.01192, 0.0),  # 685
    (0.0227, 0.00821, 0.0),  # 690
    (0.01584, 0.005723, 0.0),  # 695
    (0.01135916, 0.004102, 0.0),  # 700
    (0.008110916, 0.002929, 0.0),  # 705
    (0.005790346, 0.002091, 0.0),  # 710
    (0.004109457, 0.001484, 0.0),  # 715
    (0.002899327, 0.001047, 0.0),  # 720
    (0.00204919, 0.00074, 0.0),  # 725
    (0.001439971, 0.00052, 0.0),  # 730
    (0.0009999493, 0.0003611, 0.0),  # 735
    (0.0006900786, 0.0002492, 0.0),  # 740
    (0.0004760213, 0.0001719, 0.0),  # 745
    (0.0003323011, 0.00012, 0.0),  # 750
    (0.0002348261, 0.0000848, 0.0),  # 755
    (0.0001661505, 0.00006, 0.0),  # 760
    (0.000117413, 0.0000424, 0.0),  # 765
    (0.00008307527, 0.00003, 0.0),  # 770
    (0.00005870652, 0.0000212, 0.0),  # 775
    (0.00004150994, 0.00001499, 0.0),  # 780
    (0.00002935326, 0.0000106, 0.0),  # 785
    (0.00002067383, 0.0000074657, 0.0),  # 790
    (0.00001455977, 0.0000052578, 0.0),  # 795
    (0.00001025398, 0.0000037029, 0.0),  # 800
    (0.000007221456, 0.0000026078, 0.0),  # 805
    (0.000005085868, 0.0000018366, 0.0),  # 810
    (0.000003581652, 0.0000012934, 0.0),  # 815
    (0.000002522525, 0.00000091093, 0.0),  # 820
    (0.000001776509, 0.00000064153, 0.0),  # 825
    (0.000001251141, 0.00000045181, 0.0),  # 830
)
# END DATA: CIE 1931 2° colour-matching functions ==================================================

CMF = np.array(CIE1931_2DEG, dtype=np.float64)  # (N, 3)
assert CMF.shape == (len(LAMBDA), 3)


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
