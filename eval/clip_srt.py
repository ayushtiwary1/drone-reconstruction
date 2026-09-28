#!/usr/bin/env python
"""Cut an SRT file to [t0, t1] seconds of video time, rebased to 0.

Usage: .venv/bin/python eval/clip_srt.py IN.SRT OUT.SRT T0 T1
"""
import re
import sys


def parse_start(line: str):
    m = re.match(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})", line)
    if not m:
        return None
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000.0


def fmt(t: float) -> str:
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    src, dst, t0, t1 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
    blocks = []
    cur = []
    for line in open(src, errors="replace"):
        cur.append(line)
        if "</font>" in line or line.strip() == "":
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)

    out = []
    idx = 1
    for b in blocks:
        tm = None
        start = end = None
        for line in b:
            if "-->" in line:
                m = re.match(r"(\S+)\s*-->\s*(\S+)", line)
                start = parse_start(m.group(1))
                end = parse_start(m.group(2))
                tm = line
        if start is None:
            continue
        if end < t0 or start >= t1:
            continue
        ns, ne = start - t0, end - t0
        newb = [f"{idx}\n", f"{fmt(max(ns,0))} --> {fmt(max(ne,0))}\n"]
        for line in b:
            if line.strip() == str(idx - 1) or "-->" in line:
                continue
            newb.append(line)
        out.append(newb)
        idx += 1
    with open(dst, "w") as f:
        for b in out:
            f.writelines(b)
    print(f"wrote {dst}: {len(out)} records [{t0}..{t1}]")


if __name__ == "__main__":
    main()
