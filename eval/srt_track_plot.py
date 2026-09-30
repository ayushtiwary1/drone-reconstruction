#!/usr/bin/env python
"""Plot GPS speed / yaw-rate / altitude + XY track for clip selection.

Usage: .venv/bin/python eval/srt_track_plot.py data/kabr/DJI_0210.SRT eval/results/m0_track.png
"""
import sys
import math

sys.path.insert(0, ".")
from engine.tools.srt import parse_srt, speeds_enu


def main():
    srt_path, out_png = sys.argv[1], sys.argv[2]
    recs = parse_srt(srt_path)
    recs = [r for r in recs if r.latitude is not None]
    dyn = speeds_enu(recs)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    t = [d[0] for d in dyn]
    sp = [d[1] for d in dyn]
    yr = [d[2] for d in dyn]
    alt = [r.altitude or 0 for r in recs]
    ts = [r.t_video for r in recs]

    # ENU track
    R = 6378137.0
    lat0, lon0 = recs[0].latitude, recs[0].longitude
    xs = [(r.longitude - lon0) * math.pi / 180 * R * math.cos(math.radians(lat0)) for r in recs]
    ys = [(r.latitude - lat0) * math.pi / 180 * R for r in recs]

    fig, ax = plt.subplots(2, 2, figsize=(14, 9))
    ax[0, 0].plot(t, sp, lw=0.8)
    ax[0, 0].set_title("GPS speed (m/s)")
    ax[0, 0].set_xlabel("video s")
    ax[0, 0].grid(alpha=0.3)
    ax[0, 1].plot(t, yr, lw=0.8, color="tab:red")
    ax[0, 1].set_title("yaw rate (deg/s)")
    ax[0, 1].set_xlabel("video s")
    ax[0, 1].grid(alpha=0.3)
    ax[1, 0].plot(ts, alt, lw=0.8, color="tab:green")
    ax[1, 0].set_title("altitude (m)")
    ax[1, 0].set_xlabel("video s")
    ax[1, 0].grid(alpha=0.3)
    sc = ax[1, 1].scatter(xs, ys, c=ts, s=2, cmap="viridis")
    ax[1, 1].set_title("ENU track (m), colour=time")
    ax[1, 1].set_xlabel("East m")
    ax[1, 1].set_ylabel("North m")
    ax[1, 1].axis("equal")
    plt.colorbar(sc, ax=ax[1, 1], label="s")
    fig.suptitle(srt_path)
    fig.tight_layout()
    fig.savefig(out_png, dpi=110)
    print("wrote", out_png)


if __name__ == "__main__":
    main()
