"""
Converts an OBJ + texture (map_Kd) into a web ready GLB.

- Deduplicates the v/vt/vn corners into unique vertices.
- Rescales the texture and embeds it inside the GLB.
- Output: a single self contained .glb file.

The GLB download from Meshy is usually the better starting point, since OBJ/MTL
cannot carry metallic-roughness at all -- see tools/optimize_glb.py. This script
is the fallback for exports that only ship a diffuse map.

Usage:
    python tools/obj2glb.py <input.obj> <output.glb>
        [--texture map.png] [--tex-size 2048] [--tex-format png] [--quality 95]
"""

import argparse
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

from texutil import encode, resize_texture

Image.MAX_IMAGE_PIXELS = None  # Meshy textures go up to 8192x8192

GLTF_FLOAT = 5126
GLTF_UINT32 = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


def parse_obj(path):
    """Returns (positions, normals, uvs, indices) as numpy arrays."""
    verts, uvs, norms = [], [], []
    corner_map = {}
    out_v, out_vt, out_vn = [], [], []
    indices = []
    mtl_name = None

    def corner_index(tok):
        idx = corner_map.get(tok)
        if idx is not None:
            return idx
        parts = tok.split("/")
        vi = int(parts[0])
        vti = int(parts[1]) if len(parts) > 1 and parts[1] else 0
        vni = int(parts[2]) if len(parts) > 2 and parts[2] else 0

        out_v.append(verts[vi - 1 if vi > 0 else len(verts) + vi])
        if vti:
            u, v = uvs[vti - 1 if vti > 0 else len(uvs) + vti]
            out_vt.append((u, 1.0 - v))  # OBJ is bottom-left, glTF is top-left
        else:
            out_vt.append((0.0, 0.0))
        if vni:
            out_vn.append(norms[vni - 1 if vni > 0 else len(norms) + vni])
        else:
            out_vn.append((0.0, 1.0, 0.0))

        idx = len(out_v) - 1
        corner_map[tok] = idx
        return idx

    with open(path, "r", errors="ignore") as fh:
        for line in fh:
            if line.startswith("v "):
                a = line.split()
                verts.append((float(a[1]), float(a[2]), float(a[3])))
            elif line.startswith("vt "):
                a = line.split()
                uvs.append((float(a[1]), float(a[2])))
            elif line.startswith("vn "):
                a = line.split()
                norms.append((float(a[1]), float(a[2]), float(a[3])))
            elif line.startswith("f "):
                toks = line.split()[1:]
                ids = [corner_index(t) for t in toks]
                # fan-triangulate in case an n-gon shows up
                for k in range(1, len(ids) - 1):
                    indices.extend((ids[0], ids[k], ids[k + 1]))
            elif line.startswith("usemtl "):
                mtl_name = line.split(maxsplit=1)[1].strip()

    return (
        np.asarray(out_v, dtype=np.float32),
        np.asarray(out_vn, dtype=np.float32),
        np.asarray(out_vt, dtype=np.float32),
        np.asarray(indices, dtype=np.uint32),
        mtl_name,
    )


def find_texture(obj_path):
    """Looks up the map_Kd of the .mtl referenced by the .obj."""
    base = os.path.dirname(obj_path)
    mtl_path = None
    with open(obj_path, "r", errors="ignore") as fh:
        for line in fh:
            if line.startswith("mtllib "):
                mtl_path = os.path.join(base, line.split(maxsplit=1)[1].strip())
                break
            if line.startswith(("v ", "f ")):
                break
    if not mtl_path or not os.path.exists(mtl_path):
        return None
    with open(mtl_path, "r", errors="ignore") as fh:
        for line in fh:
            if line.lower().startswith("map_kd"):
                tex = line.split(maxsplit=1)[1].strip()
                tex = os.path.join(base, tex)
                return tex if os.path.exists(tex) else None
    return None


def pad4(data, fill=b"\x00"):
    rem = (-len(data)) % 4
    return data + fill * rem


def build_glb(pos, nrm, uv, idx, texture, out_path, mime="image/png"):
    blobs = []
    views = []
    offset = 0

    def add_view(data, target=None):
        nonlocal offset
        data = pad4(data)
        views.append(
            {
                "buffer": 0,
                "byteOffset": offset,
                "byteLength": len(data),
                **({"target": target} if target else {}),
            }
        )
        blobs.append(data)
        offset += len(data)
        return len(views) - 1

    v_idx = add_view(idx.tobytes(), ELEMENT_ARRAY_BUFFER)
    v_pos = add_view(pos.tobytes(), ARRAY_BUFFER)
    v_nrm = add_view(nrm.tobytes(), ARRAY_BUFFER)
    v_uv = add_view(uv.tobytes(), ARRAY_BUFFER)
    v_img = add_view(texture) if texture else None

    # the real byteLength of each view must exclude the padding for accessors
    views[v_idx]["byteLength"] = idx.nbytes
    views[v_pos]["byteLength"] = pos.nbytes
    views[v_nrm]["byteLength"] = nrm.nbytes
    views[v_uv]["byteLength"] = uv.nbytes
    if v_img is not None:
        views[v_img]["byteLength"] = len(texture)

    accessors = [
        {
            "bufferView": v_idx,
            "componentType": GLTF_UINT32,
            "count": int(idx.size),
            "type": "SCALAR",
        },
        {
            "bufferView": v_pos,
            "componentType": GLTF_FLOAT,
            "count": int(pos.shape[0]),
            "type": "VEC3",
            "min": pos.min(axis=0).tolist(),
            "max": pos.max(axis=0).tolist(),
        },
        {
            "bufferView": v_nrm,
            "componentType": GLTF_FLOAT,
            "count": int(nrm.shape[0]),
            "type": "VEC3",
        },
        {
            "bufferView": v_uv,
            "componentType": GLTF_FLOAT,
            "count": int(uv.shape[0]),
            "type": "VEC2",
        },
    ]

    material = {
        "name": "model",
        "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.75,
        },
        "doubleSided": True,
    }

    gltf = {
        "asset": {"version": "2.0", "generator": "obj2glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "model"}],
        "meshes": [
            {
                "name": "model",
                "primitives": [
                    {
                        "attributes": {"POSITION": 1, "NORMAL": 2, "TEXCOORD_0": 3},
                        "indices": 0,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        ],
        "materials": [material],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": offset}],
    }

    if v_img is not None:
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
        gltf["images"] = [{"bufferView": v_img, "mimeType": mime}]
        gltf["samplers"] = [
            {"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}
        ]
        gltf["textures"] = [{"sampler": 0, "source": 0}]

    json_chunk = pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    bin_chunk = b"".join(blobs)

    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with open(out_path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
        fh.write(json_chunk)
        fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
        fh.write(bin_chunk)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("obj")
    ap.add_argument("out")
    ap.add_argument(
        "--texture",
        default=None,
        help="use this image instead of the map_Kd declared by the .mtl",
    )
    ap.add_argument("--tex-size", type=int, default=2048)
    ap.add_argument("--quality", type=int, default=95, help="only for --tex-format jpeg")
    ap.add_argument(
        "--tex-format",
        choices=("png", "jpeg"),
        default="png",
        help="png is lossless: required when the texture doubles as a chroma key, "
        "because jpeg smears color edges",
    )
    args = ap.parse_args()

    print(f"reading {args.obj} ...")
    pos, nrm, uv, idx, mtl = parse_obj(args.obj)
    print(f"  {pos.shape[0]} unique vertices, {idx.size // 3} triangles (material: {mtl})")

    tex_path = args.texture or find_texture(args.obj)
    tex_bytes = b""
    mime = "image/png"
    if tex_path:
        src_mb = os.path.getsize(tex_path) / 1e6
        resized = resize_texture(Image.open(tex_path), args.tex_size)
        tex_bytes, mime = encode(resized, args.tex_format, args.quality)
        print(
            f"  texture {os.path.basename(tex_path)}: {src_mb:.1f} MB -> "
            f"{resized.size[0]}x{resized.size[1]} {args.tex_format.upper()} "
            f"{len(tex_bytes) / 1e6:.2f} MB"
        )
    else:
        print("  warning: no map_Kd found, the GLB ships without a texture", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    total = build_glb(pos, nrm, uv, idx, tex_bytes, args.out, mime)
    print(f"wrote {args.out} ({total / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
