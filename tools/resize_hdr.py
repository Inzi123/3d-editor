"""
Downsizes a Radiance .hdr environment map.

HDRIs ship at 8K because they are authored for offline rendering. On the web that
is dead weight: three reduces the map to a 256 px cubemap for image based lighting
anyway, so the resolution only matters if the map is also shown as a background.

Decoding and downsampling happen in the same pass, a few scanlines at a time, so a
67 MB 8192x4096 source never needs its 400 MB of float RGB in memory at once.

Usage:
    python tools/resize_hdr.py <input.hdr> <output.hdr> [--width 2048]
"""

import argparse
import os
import sys

import numpy as np


def read_header(fh):
    """Consumes the Radiance header and returns (width, height)."""
    if not fh.readline().startswith(b"#?"):
        raise ValueError("not a Radiance .hdr file")
    while True:
        line = fh.readline()
        if line in (b"\n", b"\r\n", b""):
            break
    resolution = fh.readline().split()
    if len(resolution) != 4 or resolution[0] != b"-Y" or resolution[2] != b"+X":
        raise ValueError(f"unsupported resolution line: {resolution}")
    return int(resolution[3]), int(resolution[1])


def read_scanline(fh, width):
    """Decodes one scanline into a (width, 4) uint8 array of RGBE."""
    header = fh.read(4)
    if len(header) < 4:
        raise EOFError("truncated file")

    # flat (non RLE) scanline
    if header[0] != 2 or header[1] != 2 or ((header[2] << 8) | header[3]) != width:
        rest = fh.read(width * 4 - 4)
        return np.frombuffer(header + rest, dtype=np.uint8).reshape(width, 4)

    # new style RLE: the four channels are stored one after another
    out = np.empty((4, width), dtype=np.uint8)
    for channel in range(4):
        x = 0
        while x < width:
            count = fh.read(1)[0]
            if count > 128:  # a run of one repeated value
                run = count - 128
                out[channel, x : x + run] = fh.read(1)[0]
                x += run
            else:  # a literal run
                out[channel, x : x + count] = np.frombuffer(fh.read(count), dtype=np.uint8)
                x += count
    return out.T


def rgbe_to_float(block):
    """RGBE bytes -> linear float RGB."""
    rgbe = block.astype(np.float32)
    exponent = np.ldexp(1.0, rgbe[..., 3].astype(np.int32) - (128 + 8))
    return rgbe[..., :3] * exponent[..., None]


def float_to_rgbe(rgb):
    """Linear float RGB -> RGBE bytes, the inverse of the above."""
    brightest = rgb.max(axis=-1)
    mantissa, exponent = np.frexp(np.maximum(brightest, 1e-32))
    scale = np.where(brightest > 1e-32, mantissa * 256.0 / brightest, 0.0)

    out = np.zeros(rgb.shape[:-1] + (4,), dtype=np.uint8)
    out[..., :3] = np.clip(rgb * scale[..., None], 0, 255).astype(np.uint8)
    out[..., 3] = np.where(brightest > 1e-32, exponent + 128, 0).astype(np.uint8)
    return out


def encode_rle(scanline):
    """Radiance new style RLE for one (width, 4) scanline."""
    width = scanline.shape[0]
    out = bytearray([2, 2, width >> 8, width & 0xFF])

    for channel in range(4):
        data = scanline[:, channel]
        x = 0
        while x < width:
            run = 1
            while x + run < width and run < 127 and data[x + run] == data[x]:
                run += 1
            if run > 4:  # worth encoding as a run
                out.append(128 + run)
                out.append(int(data[x]))
                x += run
            else:  # gather literals until a run worth breaking for
                start = x
                while x < width and (x - start) < 128:
                    ahead = 1
                    while x + ahead < width and ahead < 5 and data[x + ahead] == data[x]:
                        ahead += 1
                    if ahead >= 5:
                        break
                    x += 1
                out.append(x - start)
                out.extend(int(v) for v in data[start:x])
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=2048)
    args = ap.parse_args()

    with open(args.src, "rb") as fh:
        width, height = read_header(fh)
        factor = max(1, round(width / args.width))
        out_w, out_h = width // factor, height // factor
        print(f"{width}x{height} -> {out_w}x{out_h}  (1/{factor})")

        rows = []
        for y in range(out_h):
            block = np.stack(
                [rgbe_to_float(read_scanline(fh, width)) for _ in range(factor)]
            )
            # average in linear space; averaging RGBE bytes directly would be wrong
            block = block[:, : out_w * factor].reshape(factor, out_w, factor, 3)
            rows.append(block.mean(axis=(0, 2)))
            if y % 256 == 0:
                print(f"  row {y}/{out_h}", end="\r")

    resized = np.stack(rows)
    print(f"\nlinear range: {resized.min():.4f} .. {resized.max():.1f}")

    encoded = float_to_rgbe(resized)
    with open(args.out, "wb") as fh:
        fh.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n")
        fh.write(f"-Y {out_h} +X {out_w}\n".encode())
        for y in range(out_h):
            fh.write(encode_rle(encoded[y]))

    before, after = os.path.getsize(args.src), os.path.getsize(args.out)
    print(f"{args.out}: {before / 1e6:.1f} MB -> {after / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
