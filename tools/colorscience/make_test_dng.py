#!/usr/bin/env python3
"""Writes small synthetic Bayer DNGs for the web smoke test, so the end-to-end path (LibRaw in the browser, the
engine, the loupe, the export) runs in CI without any real photograph in the repository.

Each file is a plain uncompressed 16-bit RGGB mosaic of a synthetic scene (a horizontal exposure sweep, a grey
patch, a colour disc, a near-clipping highlight), with the DNG tags LibRaw needs: a colour matrix that makes the
camera space sRGB-linear, an as-shot neutral, white and black levels, and an optional baseline exposure. One file
is landscape, one portrait with a baseline exposure, which exercises that path of the decoder.

    python3 tools/colorscience/make_test_dng.py web/test/fixtures
"""
import struct
import sys
from pathlib import Path

import numpy as np

# TIFF tag types
BYTE, ASCII, SHORT, LONG, RATIONAL, SBYTE, UNDEFINED, SSHORT, SLONG, SRATIONAL = 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
SIZES = {BYTE: 1, ASCII: 1, SHORT: 2, LONG: 4, RATIONAL: 8, SBYTE: 1, UNDEFINED: 1, SSHORT: 2, SLONG: 4, SRATIONAL: 8}


def scene(width, height, seed):
    """A scene-linear sRGB image in [0, 1.2]: exposure sweep, grey patch, colour disc, highlight, a little noise."""
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 1, width)[None, :]
    y = np.linspace(0, 1, height)[:, None]
    base = 0.02 * np.power(60.0, x)                       # about 6 stops across the width
    img = np.repeat(base[:, :, None], 3, axis=2) * np.ones((height, width, 3))
    img *= (0.85 + 0.3 * y)[:, :, None]
    # a grey patch at 18 %
    img[int(height * 0.1):int(height * 0.3), int(width * 0.1):int(width * 0.3)] = 0.18
    # a saturated red disc and a blue-green one
    yy, xx = np.mgrid[0:height, 0:width]
    disc = (xx - width * 0.65) ** 2 + (yy - height * 0.4) ** 2 < (min(width, height) * 0.15) ** 2
    img[disc] = [0.45, 0.04, 0.05]
    disc2 = (xx - width * 0.35) ** 2 + (yy - height * 0.7) ** 2 < (min(width, height) * 0.12) ** 2
    img[disc2] = [0.05, 0.3, 0.4]
    # a highlight that clips
    img[int(height * 0.75):int(height * 0.9), int(width * 0.8):int(width * 0.95)] = 1.2
    img *= 1 + 0.01 * rng.standard_normal(img.shape)
    return np.clip(img, 0, 1.2)


def mosaic(rgb, neutral, white):
    """RGGB Bayer samples: camera = scene × neutral (the as-shot neutral undoes it), quantised to `white`."""
    h, w, _ = rgb.shape
    cam = rgb * np.array(neutral)[None, None, :]
    raw = np.zeros((h, w), dtype=np.float64)
    raw[0::2, 0::2] = cam[0::2, 0::2, 0]
    raw[0::2, 1::2] = cam[0::2, 1::2, 1]
    raw[1::2, 0::2] = cam[1::2, 0::2, 1]
    raw[1::2, 1::2] = cam[1::2, 1::2, 2]
    return np.clip(np.round(raw * white), 0, white).astype('<u2')


def rational(v, den=10000):
    return (int(round(v * den)), den)


def write_dng(path, raw, neutral, white, model, baseline_ev=None):
    h, w = raw.shape
    data = raw.tobytes()
    # XYZ (D65) → camera, with camera = linear sRGB: the sRGB matrix.
    cm = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570]
    entries = [
        (254, LONG, [0]),                      # NewSubfileType: the main image
        (256, LONG, [w]), (257, LONG, [h]),
        (258, SHORT, [16]), (259, SHORT, [1]),
        (262, SHORT, [32803]),                 # PhotometricInterpretation: CFA
        (271, ASCII, b'Technichrome\0'), (272, ASCII, (model + '\0').encode()),
        (273, LONG, [0]),                      # StripOffsets, patched below
        (274, SHORT, [1]), (277, SHORT, [1]), (278, LONG, [h]), (279, LONG, [len(data)]),
        (284, SHORT, [1]),
        (33421, SHORT, [2, 2]), (33422, BYTE, [0, 1, 1, 2]),   # RGGB
        (50706, BYTE, [1, 4, 0, 0]), (50707, BYTE, [1, 1, 0, 0]),
        (50708, ASCII, (model + '\0').encode()),
        (50714, LONG, [0]), (50717, LONG, [white]),
        (50721, SRATIONAL, [rational(v) for v in cm]),
        (50728, RATIONAL, [rational(v) for v in neutral]),
        (50778, SHORT, [21]),                  # CalibrationIlluminant1: D65
    ]
    if baseline_ev is not None:
        entries.append((50730, SRATIONAL, [rational(baseline_ev, 100)]))
    entries.sort(key=lambda e: e[0])
    # Layout: header (8) | IFD | out-of-line values | pixel data
    ifd_size = 2 + 12 * len(entries) + 4
    values_offset = 8 + ifd_size
    blobs = []
    offset = values_offset
    packed = []
    for tag, typ, vals in entries:
        if typ == ASCII:
            payload = vals
            count = len(vals)
        elif typ in (RATIONAL, SRATIONAL):
            fmt = '<' + ('II' if typ == RATIONAL else 'ii') * len(vals)
            payload = struct.pack(fmt, *[c for pair in vals for c in pair])
            count = len(vals)
        else:
            fmt = {BYTE: 'B', SHORT: 'H', LONG: 'I'}[typ]
            payload = struct.pack('<' + fmt * len(vals), *vals)
            count = len(vals)
        if len(payload) <= 4:
            packed.append((tag, typ, count, payload.ljust(4, b'\0'), None))
        else:
            packed.append((tag, typ, count, None, offset))
            blobs.append(payload)
            offset += len(payload) + (len(payload) & 1)
    data_offset = offset
    out = bytearray(b'II*\0' + struct.pack('<I', 8))
    out += struct.pack('<H', len(packed))
    for tag, typ, count, inline, off in packed:
        if tag == 273:
            inline = struct.pack('<I', data_offset)
        out += struct.pack('<HHI', tag, typ, count)
        out += inline if inline is not None else struct.pack('<I', off)
    out += struct.pack('<I', 0)
    for b in blobs:
        out += b
        if len(b) & 1:
            out += b'\0'
    assert len(out) == data_offset
    out += data
    Path(path).write_bytes(bytes(out))
    return len(out)


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else 'web/test/fixtures')
    out_dir.mkdir(parents=True, exist_ok=True)
    white = 4095
    a = write_dng(out_dir / 'synthetic-a.dng', mosaic(scene(320, 240, 1), (0.55, 1.0, 0.7), white), (0.55, 1.0, 0.7), white, 'Synthetic Bayer A')
    b = write_dng(out_dir / 'synthetic-b.dng', mosaic(scene(240, 320, 2), (0.6, 1.0, 0.65), white), (0.6, 1.0, 0.65), white, 'Synthetic Bayer B', baseline_ev=-0.5)
    print(f'wrote synthetic-a.dng ({a} bytes, 320×240) and synthetic-b.dng ({b} bytes, 240×320, baseline −0.5 EV)')


if __name__ == '__main__':
    main()
