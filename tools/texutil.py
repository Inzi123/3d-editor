"""
Texture helpers shared by the converters.

The important thing this module solves is the alpha channel of UV atlases: the
gap between islands ships as transparent black, and resizing without accounting
for it averages that black into the edge of every island, leaving dark halos
along all of the model's seams.
"""

import io

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def _box_down(a):
    h, w = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
    a = a[:h, :w]
    if a.ndim == 3:
        return a.reshape(h // 2, 2, w // 2, 2, a.shape[2]).mean(axis=(1, 3))
    return a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))


def _up_to(a, shape):
    img = Image.fromarray((np.clip(a, 0, 1) * 255).round().astype(np.uint8))
    return np.asarray(img.resize((shape[1], shape[0]), Image.BILINEAR)).astype(np.float32) / 255.0


def fill_unpainted(rgb, valid):
    """
    Fills every empty spot in the atlas with the color of the nearest island,
    via push-pull over a pyramid.

    The gutters between islands are wide and branching, so an iterative dilation
    with a handful of passes never closes them. The pyramid converges in O(log n)
    levels and covers holes of any size.
    """
    pyramid = [(rgb * valid[..., None], valid.astype(np.float32))]
    while min(pyramid[-1][1].shape[:2]) > 1:
        color, weight = pyramid[-1]
        pyramid.append((_box_down(color), _box_down(weight)))

    color, weight = pyramid[-1]
    filled = np.where(
        weight[..., None] > 1e-6, color / np.maximum(weight[..., None], 1e-6), 0.0
    )
    for color, weight in reversed(pyramid[:-1]):
        coarse = _up_to(filled, color.shape[:2])
        have = weight[..., None] > 1e-6
        filled = np.where(have, color / np.maximum(weight[..., None], 1e-6), coarse)

    return np.clip(filled, 0.0, 1.0)


def resize_texture(img, size):
    """
    Resizes to `size` on the longest side. If the image carries alpha it is
    premultiplied before resizing and the gutters are filled afterwards; always
    returns RGB.
    """
    has_alpha = img.mode in ("RGBA", "LA") or "transparency" in img.info
    img = img.convert("RGBA" if has_alpha else "RGB")

    if max(img.size) <= size and not has_alpha:
        return img

    if not has_alpha:
        ratio = size / max(img.size)
        return img.resize(
            (max(1, round(img.width * ratio)), max(1, round(img.height * ratio))),
            Image.LANCZOS,
        )

    a = np.asarray(img).astype(np.float32) / 255.0
    if max(img.size) > size:
        ratio = size / max(img.size)
        target = (max(1, round(img.width * ratio)), max(1, round(img.height * ratio)))
        premultiplied = np.concatenate([a[..., :3] * a[..., 3:4], a[..., 3:4]], axis=2)
        small = Image.fromarray(
            (premultiplied * 255).round().astype(np.uint8), mode="RGBA"
        ).resize(target, Image.LANCZOS)
        a = np.asarray(small).astype(np.float32) / 255.0

    alpha = a[..., 3]
    rgb = np.where(
        alpha[..., None] > 1e-3, a[..., :3] / np.maximum(alpha[..., None], 1e-3), 0.0
    )
    rgb = fill_unpainted(np.clip(rgb, 0, 1), alpha > 0.5)
    return Image.fromarray((rgb * 255).round().astype(np.uint8), mode="RGB")


def encode(img, fmt, quality=92):
    """
    Compresses. JPEG always uses 4:4:4 -- chroma subsampling smears color edges,
    which is exactly what defines a chroma key mask and what a normal map encodes
    in its channels.
    """
    buf = io.BytesIO()
    img = img.convert("RGB")
    if fmt == "png":
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    img.save(buf, format="JPEG", quality=quality, subsampling=0, optimize=True)
    return buf.getvalue(), "image/jpeg"
