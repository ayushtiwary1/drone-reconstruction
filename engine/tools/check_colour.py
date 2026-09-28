#!/usr/bin/env python
"""check_colour.py — white-model regression gate.

Parses a PLY (binary_little_endian or ascii, vertex element with
red/green/blue uchar) and FAILS (exit 1) when the colourless condition holds:
    mean channel std < 10   OR   >50% vertices r,g,b >= 250   OR   >90% r==g==b
Also warns (exit 2) when no colour properties exist at all.

Usage: python -m engine.tools.check_colour FILE.ply [--json]
"""
import argparse
import json
import sys

import numpy as np


def read_ply_colors(path):
    with open(path, "rb") as f:
        header_lines = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError("EOF before end_header")
            header_lines.append(line.decode("latin1").rstrip("\n"))
            if line.strip() == b"end_header":
                break
        fmt = None
        nverts = 0
        props = []
        in_vertex = False
        for l in header_lines:
            p = l.split()
            if not p:
                continue
            if p[0] == "format":
                fmt = p[1]
            elif p[0] == "element":
                in_vertex = p[1] == "vertex"
                if in_vertex:
                    nverts = int(p[2])
            elif p[0] == "property" and in_vertex:
                props.append((p[-1], p[1]))
        names = [n for n, _ in props]
        if not {"red", "green", "blue"} <= set(names):
            return None, f"missing colour props (have: {names})"
        ri = names.index("red")
        gi = names.index("green")
        bi = names.index("blue")

        if fmt == "ascii":
            data = []
            for i in range(nverts):
                parts = f.readline().split()
                data.append([float(parts[ri]), float(parts[gi]), float(parts[bi])])
            return np.asarray(data, dtype=float), "ok"
        elif fmt == "binary_little_endian":
            # build struct dtype for the vertex record
            tm = {"float": "<f4", "float32": "<f4", "double": "<f8",
                  "uchar": "u1", "uint8": "u1", "char": "i1",
                  "short": "<i2", "ushort": "<u2", "int": "<i4", "int32": "<i4",
                  "uint": "<u4", "uint32": "<u4"}
            dt = np.dtype([(n, tm[t]) for n, t in props])
            rec = np.frombuffer(f.read(nverts * dt.itemsize), dtype=dt)
            return np.stack([rec["red"], rec["green"], rec["blue"]], axis=1).astype(float), "ok"
        else:
            return None, f"unsupported format {fmt}"


def check(path):
    colors, status = read_ply_colors(path)
    if colors is None:
        return {"ok": False, "reason": status}
    n = len(colors)
    std_mean = float(np.mean(np.std(colors, axis=0)))
    sat = float(((colors >= 250).all(axis=1)).mean() * 100)
    gray = float(((colors[:, 0] == colors[:, 1]) & (colors[:, 1] == colors[:, 2])).mean() * 100)
    white = std_mean < 10 or sat > 50 or gray > 90
    return {
        "ok": not white, "vertices": n, "channel_std": std_mean,
        "pct_saturated": sat, "pct_gray": gray,
        "reason": "WHITE-MODEL condition" if white else "ok",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ply")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    res = check(a.ply)
    print(json.dumps(res, indent=1) if a.json else f"{res}")
    if res["reason"] != "ok" and res["reason"] != "WHITE-MODEL condition":
        sys.exit(2)
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
