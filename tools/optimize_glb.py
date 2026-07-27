"""
Shrinks the textures embedded in a GLB, leaving the mesh and materials untouched.

Meshy GLBs ship with 4K and 8K maps: useful for offline rendering, unusable on
the web. This script rescales every image according to its role and rewrites the
file.

The baseColor is stored as PNG on purpose: the viewer uses it as a chroma key
map, and JPEG chroma subsampling smears exactly the green edge that defines the
mask.

Usage:
    python tools/optimize_glb.py <input.glb> <output.glb>
        [--base 2048] [--normal 2048] [--mr 1024] [--quality 92]
"""

import argparse
import json
import os
import struct
import io

from PIL import Image

from texutil import encode, resize_texture

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def read_glb(path):
    data = open(path, "rb").read()
    magic, version, total = struct.unpack("<III", data[:12])
    if magic != GLB_MAGIC:
        raise ValueError("not a GLB")
    offset, chunks = 12, {}
    while offset < total:
        length, kind = struct.unpack("<II", data[offset : offset + 8])
        chunks[kind] = data[offset + 8 : offset + 8 + length]
        offset += 8 + length
    return json.loads(chunks[CHUNK_JSON].decode("utf-8")), chunks.get(CHUNK_BIN, b"")


def image_roles(gltf):
    """Maps image index -> role, based on how each material uses it."""
    textures = gltf.get("textures", [])

    def source(tex_index):
        if tex_index is None or tex_index >= len(textures):
            return None
        return textures[tex_index].get("source")

    roles = {}
    for material in gltf.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        for key, role in (
            ("baseColorTexture", "base"),
            ("metallicRoughnessTexture", "mr"),
        ):
            i = source(pbr.get(key, {}).get("index"))
            if i is not None:
                roles[i] = role
        for key, role in (
            ("normalTexture", "normal"),
            ("occlusionTexture", "mr"),
            ("emissiveTexture", "base"),
        ):
            i = source(material.get(key, {}).get("index"))
            if i is not None:
                roles.setdefault(i, role)
    return roles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--base", type=int, default=2048, help="baseColor side length")
    ap.add_argument("--normal", type=int, default=2048, help="normal map side length")
    ap.add_argument("--mr", type=int, default=1024, help="metallicRoughness side length")
    ap.add_argument("--quality", type=int, default=92)
    args = ap.parse_args()

    gltf, binary = read_glb(args.src)
    views = gltf["bufferViews"]
    roles = image_roles(gltf)

    # every bufferView is copied verbatim except the ones holding images
    blobs = []
    for view in views:
        start = view.get("byteOffset", 0)
        blobs.append(bytearray(binary[start : start + view["byteLength"]]))

    target = {"base": args.base, "normal": args.normal, "mr": args.mr}
    for index, image in enumerate(gltf.get("images", [])):
        if "bufferView" not in image:
            continue
        role = roles.get(index, "base")
        source = Image.open(io.BytesIO(bytes(blobs[image["bufferView"]])))
        before = (source.size, len(blobs[image["bufferView"]]))

        resized = resize_texture(source, target[role])
        # the baseColor feeds the chroma key: it must not go through jpeg
        fmt = "png" if role == "base" else "jpeg"
        data, mime = encode(resized, fmt, args.quality)

        blobs[image["bufferView"]] = bytearray(data)
        image["mimeType"] = mime
        print(
            f"  image {index} ({role}): {before[0][0]}x{before[0][1]} "
            f"{before[1] / 1e6:.2f} MB -> {resized.size[0]}x{resized.size[1]} "
            f"{fmt.upper()} {len(data) / 1e6:.2f} MB"
        )

    # repack: every offset changes
    packed = bytearray()
    for view, blob in zip(views, blobs):
        packed.extend(b"\x00" * ((-len(packed)) % 4))
        view["byteOffset"] = len(packed)
        view["byteLength"] = len(blob)
        packed.extend(blob)
    packed.extend(b"\x00" * ((-len(packed)) % 4))

    gltf["buffers"] = [{"byteLength": len(packed)}]
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((-len(json_chunk)) % 4)

    total = 12 + 8 + len(json_chunk) + 8 + len(packed)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as fh:
        fh.write(struct.pack("<III", GLB_MAGIC, 2, total))
        fh.write(struct.pack("<II", len(json_chunk), CHUNK_JSON))
        fh.write(json_chunk)
        fh.write(struct.pack("<II", len(packed), CHUNK_BIN))
        fh.write(packed)

    print(
        f"{args.out}: {os.path.getsize(args.src) / 1e6:.1f} MB -> {total / 1e6:.2f} MB"
    )


if __name__ == "__main__":
    main()
