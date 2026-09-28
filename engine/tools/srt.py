"""DJI SRT telemetry parser — shared by engine and eval tooling.

Handles both legacy format:
    [iso : 100] [shutter : 1/2000.0] [fnum : 280] [ev : 0] [ct : 5067]
    [color_md : default] [focal_len : 224] [latitude: 0.394028]
    [longitude: 36.883816] [altitude: 15.600000]
and newer formats (rel_alt/abs_alt, drone_latitude, gimbal keys, FrameCnt).

Timestamps: prefer the per-record UTC datetime line; fall back to the
SRT block start time. Returns list of TelemetryRecord.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class TelemetryRecord:
    t_video: float            # seconds from video start (SRT block start)
    t_utc: Optional[float]    # epoch seconds if a datetime line exists
    frame_cnt: Optional[int]
    latitude: Optional[float]
    longitude: Optional[float]
    altitude: Optional[float]  # best available: rel_alt > abs_alt-derive > altitude
    abs_alt: Optional[float]
    rel_alt: Optional[float]
    gimbal_yaw: Optional[float]
    gimbal_pitch: Optional[float]
    gimbal_roll: Optional[float]
    iso: Optional[float]
    shutter: Optional[float]
    fnum: Optional[float]
    ev: Optional[float]
    focal_len: Optional[float]
    raw: dict = field(default_factory=dict)


_TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})")
_DATETIME_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3,6})")
_KV_RE = re.compile(r"\[([^\]:]+?)\s*:\s*([^\]]+?)\]")


def _to_sec(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _f(v: str) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_srt(path: str) -> list[TelemetryRecord]:
    recs: list[TelemetryRecord] = []
    block_start: Optional[float] = None
    dt_utc: Optional[float] = None
    frame_cnt: Optional[int] = None
    meta: dict = {}

    def flush():
        nonlocal block_start, dt_utc, frame_cnt, meta
        if block_start is None:
            return
        get = lambda *ks: next((meta[k] for k in ks if k in meta), None)
        rel_alt = _f(get("rel_alt") or "")
        abs_alt = _f(get("abs_alt") or "")
        alt_direct = _f(get("altitude") or get("alt") or "")
        g_yaw = _f(get("gb_yaw", "gimbal_yaw") or "")
        g_pitch = _f(get("gb_pitch", "gimbal_pitch") or "")
        g_roll = _f(get("gb_roll", "gimbal_roll") or "")
        lat = _f(get("latitude", "drone_latitude") or "")
        lon = _f(get("longitude", "drone_longitude") or "")
        # altitude semantics differ across firmware: prefer rel_alt if present,
        # else 'altitude' (relative to takeoff on legacy DJI), else abs_alt.
        if rel_alt is not None:
            alt = rel_alt
        elif alt_direct is not None:
            alt = alt_direct
        else:
            alt = abs_alt
        recs.append(
            TelemetryRecord(
                t_video=block_start,
                t_utc=dt_utc,
                frame_cnt=frame_cnt,
                latitude=lat,
                longitude=lon,
                altitude=alt,
                abs_alt=abs_alt,
                rel_alt=rel_alt,
                gimbal_yaw=g_yaw,
                gimbal_pitch=g_pitch,
                gimbal_roll=g_roll,
                iso=_f(get("iso") or ""),
                shutter=_shutter(get("shutter") or ""),
                fnum=_f(get("fnum") or ""),
                ev=_f(get("ev") or ""),
                focal_len=_f(get("focal_len") or ""),
                raw=dict(meta),
            )
        )
        block_start = None
        dt_utc = None
        frame_cnt = None
        meta = {}

    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if "-->" in line:
                m = _TIME_RE.match(line)
                if m:
                    block_start = _to_sec(*m.groups())
                continue
            dm = _DATETIME_RE.search(line)
            if dm:
                g = dm.groups()
                frac = int(g[6]) / (1000.0 if len(g[6]) == 3 else 1e6)
                try:
                    dt_utc = datetime(
                        int(g[0]), int(g[1]), int(g[2]),
                        int(g[3]), int(g[4]), int(g[5]),
                    ).timestamp() + frac
                except ValueError:
                    dt_utc = None
            for m in _KV_RE.finditer(line):
                meta[m.group(1).strip().lower()] = m.group(2).strip()
            fc = re.search(r"(?:SrtCnt|FrameCnt|framecnt)\s*:\s*(\d+)", line)
            if fc:
                frame_cnt = int(fc.group(1))
            if line == "</font>" or line == "":
                flush()
    flush()
    return recs


def _shutter(v: str) -> Optional[float]:
    if not v:
        return None
    v = v.strip()
    if "/" in v:
        num, _, den = v.partition("/")
        try:
            return float(num) / float(den)
        except (ValueError, ZeroDivisionError):
            return None
    return _f(v)


def speeds_enu(recs: list[TelemetryRecord]) -> list[tuple[float, float, float]]:
    """Return (t, speed_mps, yaw_rate_deg_s) per record via 1-s windows."""
    R = 6378137.0
    out = []
    n = len(recs)
    for i in range(n):
        t0 = recs[i].t_video
        j = i
        while j < n - 1 and recs[j].t_video - t0 < 1.0:
            j += 1
        if j <= i or recs[i].latitude is None or recs[j].latitude is None:
            out.append((t0, 0.0, 0.0))
            continue
        dt = recs[j].t_video - t0
        dlat = (recs[j].latitude - recs[i].latitude) * 3.141592653589793 / 180
        dlon = (recs[j].longitude - recs[i].longitude) * 3.141592653589793 / 180
        dx = dlon * R * __import__("math").cos(recs[i].latitude * 3.141592653589793 / 180)
        dy = dlat * R
        sp = __import__("math").hypot(dx, dy) / max(dt, 1e-6)
        out.append((t0, sp, 0.0))
    # yaw rate from bearing change
    import math

    for i in range(n):
        j = i
        while j < n - 1 and recs[j].t_video - recs[i].t_video < 1.0:
            j += 1
        if j <= i:
            continue
        b1 = _bearing(recs, i, min(i + 5, n - 1))
        b2 = _bearing(recs, max(j - 5, 0), j)
        if b1 is not None and b2 is not None:
            d = abs((b2 - b1 + 180) % 360 - 180)
            t, s, _ = out[i]
            out[i] = (t, s, d / max(recs[j].t_video - recs[i].t_video, 1e-6))
    return out


def _bearing(recs, i, j):
    import math

    a, b = recs[i], recs[j]
    if a.latitude is None or b.latitude is None:
        return None
    dlon = math.radians(b.longitude - a.longitude)
    y = math.sin(dlon) * math.cos(math.radians(b.latitude))
    x = math.cos(math.radians(a.latitude)) * math.sin(math.radians(b.latitude)) - math.sin(
        math.radians(a.latitude)
    ) * math.cos(math.radians(b.latitude)) * math.cos(dlon)
    return math.degrees(math.atan2(y, x))
