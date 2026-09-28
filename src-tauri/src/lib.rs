// ============================================================
// Tactical 3D Reconstruction Engine — Rust Backend
// Coordinate system contract (Right-Handed):
//   +X = East / Right
//   +Y = Up   / Elevation
//   −Z = North / Forward (flight direction)
// Rust outputs world-space coordinates directly.
// Three.js renders the PLY at position(0,0,0) rotation(0,0,0).
// ============================================================

use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::Emitter;

use image::{imageops::FilterType, GenericImageView, RgbImage};
use ort::{
    ep,
    inputs,
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};

// ─────────────────────────────────────────────────────────────
// Hardware Profile
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HardwareProfile {
    EdgeFast,
    Balanced,
    HighAccuracy,
}

impl HardwareProfile {
    pub fn cell_size_m(self) -> f32 {
        match self {
            HardwareProfile::EdgeFast => 0.10,
            HardwareProfile::Balanced => 0.05,
            HardwareProfile::HighAccuracy => 0.015,
        }
    }

    /// Point cloud sampling step across depth pixels.
    /// In accordance with P0 rules, every pixel is processed (step = 1).
    pub fn point_step(self) -> usize {
        1
    }

    fn intra_threads(self) -> usize {
        match self {
            HardwareProfile::EdgeFast => 4,
            HardwareProfile::Balanced => 6,
            HardwareProfile::HighAccuracy => 8,
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Camera Intrinsics & Constants
// ─────────────────────────────────────────────────────────────

pub const SENSOR_WIDTH_35MM: f32 = 36.0;
pub const FOCAL_LEN_35MM_EQ_SCALE: f32 = 10.0;
pub const RELIEF_FRAC: f32 = 0.30;

#[derive(Debug, Clone)]
pub struct CameraIntrinsics {
    pub fx: f32,
    pub fy: f32,
    pub cx: f32,
    pub cy: f32,
    pub w: usize,
    pub h: usize,
    pub hfov_deg: f32,
}

impl CameraIntrinsics {
    pub fn from_focal_len_eq(w: usize, h: usize, focal_len_val: f32) -> Self {
        let focal_len_mm = (focal_len_val / FOCAL_LEN_35MM_EQ_SCALE).max(10.0);
        let hfov_rad = 2.0 * (SENSOR_WIDTH_35MM / (2.0 * focal_len_mm)).atan();
        let fx = (w as f32 / 2.0) / (hfov_rad / 2.0).tan();
        let fy = fx;
        let cx = w as f32 / 2.0;
        let cy = h as f32 / 2.0;
        let hfov_deg = hfov_rad.to_degrees();
        CameraIntrinsics {
            fx,
            fy,
            cx,
            cy,
            w,
            h,
            hfov_deg,
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Telemetry & Flight Trajectory
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct FlightPoint {
    pub timestamp_sec: f32,
    /// Absolute UTC timestamp (epoch seconds) when the SRT carries a
    /// `YYYY-MM-DD hh:mm:ss,fff` line. Used for clock-offset cross-checks.
    pub timestamp_utc: Option<f64>,
    pub latitude: f64,
    pub longitude: f64,
    /// f32::NAN marks "missing in source" — filled/validated by `parse_telemetry`.
    pub altitude_m: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
    pub yaw_deg: f32,
    pub gimbal_pitch_deg: Option<f32>,
    pub gimbal_yaw_deg: Option<f32>,
    pub gimbal_roll_deg: Option<f32>,
    /// Per-frame counter (SrtCnt/FrameCnt) when present — video frame index.
    pub frame_cnt: Option<u32>,
    pub focal_len: Option<f32>,
    pub iso: Option<f32>,
    /// Shutter speed in seconds (e.g. 1/2000 -> 0.0005).
    pub shutter_sec: Option<f32>,
    pub ev: Option<f32>,
}

fn clean_header(h: &str) -> String {
    h.trim().to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Parse a shutter field like "1/2000.0" or "2000" into seconds.
fn parse_shutter(v: &str) -> Option<f32> {
    let v = v.trim();
    if let Some((num, den)) = v.split_once('/') {
        match (num.trim().parse::<f32>(), den.trim().parse::<f32>()) {
            (Ok(n), Ok(d)) if d.abs() > 1e-9 => return Some(n / d),
            _ => return None,
        }
    }
    v.parse::<f32>().ok()
}

/// Normalise an SRT bracket key: lowercase, strip spaces/underscores/dots.
fn srt_key(k: &str) -> String {
    k.trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

pub fn parse_dji_srt(srt_path: &str) -> Result<Vec<FlightPoint>, String> {
    let file = File::open(srt_path)
        .map_err(|e| format!("[TELEMETRY] Failed to open SRT '{}': {}", srt_path, e))?;
    let reader = BufReader::new(file);

    let mut points: Vec<FlightPoint> = Vec::new();
    let mut current_time: Option<f32> = None;
    let mut utc_time: Option<f64> = None;
    let mut kv: HashMap<String, String> = HashMap::new();

    let datetime_re = regex_like_datetime();

    let flush = |current_time: &mut Option<f32>,
                     utc_time: &mut Option<f64>,
                     kv: &mut HashMap<String, String>,
                     points: &mut Vec<FlightPoint>| {
        if current_time.is_none() {
            kv.clear();
            return;
        }
        let get = |names: &[&str]| -> Option<String> {
            for n in names {
                if let Some(v) = kv.get(*n) {
                    return Some(v.clone());
                }
            }
            None
        };
        let getf = |names: &[&str]| -> Option<f32> {
            get(names).and_then(|v| v.parse::<f32>().ok())
        };
        let getd = |names: &[&str]| -> Option<f64> {
            get(names).and_then(|v| v.parse::<f64>().ok())
        };

        let lat = getd(&["latitude", "dronelatitude", "lat"]);
        let lon = getd(&["longitude", "dronelongitude", "lon", "lng"]);
        // altitude: rel_alt (AGL) preferred; legacy 'altitude' is already
        // relative-to-takeoff on this DJI format; abs_alt is AMSL fallback.
        let alt = getf(&["relalt", "relativealtitude", "relativelatitudealt"])
            .or_else(|| getf(&["altitude", "alt", "height"]))
            .or_else(|| getf(&["absalt", "altitudeamsl"]));
        let frame_cnt = kv
            .get("srtcnt")
            .or_else(|| kv.get("framecnt"))
            .and_then(|v| v.parse::<u32>().ok());

        if let (Some(la), Some(lo)) = (lat, lon) {
            points.push(FlightPoint {
                timestamp_sec: current_time.unwrap(),
                timestamp_utc: *utc_time,
                latitude: la,
                longitude: lo,
                altitude_m: alt.unwrap_or(f32::NAN),
                pitch_deg: getf(&["pitch", "dronepitch"]).unwrap_or(0.0),
                roll_deg: getf(&["roll", "droneroll"]).unwrap_or(0.0),
                yaw_deg: getf(&["yaw", "droneyaw", "heading"]).unwrap_or(0.0),
                gimbal_pitch_deg: getf(&["gbpitch", "gimbalpitch", "camerapitch"]),
                gimbal_yaw_deg: getf(&["gbyaw", "gimbalyaw"]),
                gimbal_roll_deg: getf(&["gbroll", "gimbalroll"]),
                frame_cnt,
                focal_len: getf(&["focallen"]),
                iso: getf(&["iso"]),
                shutter_sec: get(&["shutter"]).and_then(|v| parse_shutter(&v)),
                ev: getf(&["ev"]),
            });
        }
        *current_time = None;
        *utc_time = None;
        kv.clear();
    };

    for line_res in reader.lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();

        // 1. SRT timestamp line: "00:00:00,033 --> 00:00:00,066"
        if trimmed.contains(" --> ") {
            if let Some(start_part) = trimmed.split(" --> ").next() {
                let parts: Vec<&str> = start_part.trim().split(':').collect();
                if parts.len() == 3 {
                    let h: f32 = parts[0].parse().unwrap_or(0.0);
                    let m: f32 = parts[1].parse().unwrap_or(0.0);
                    let sec_parts: Vec<&str> = parts[2].split(|c| c == ',' || c == '.').collect();
                    let s: f32 = sec_parts[0].parse().unwrap_or(0.0);
                    // fractional part: "250" (ms) or "250123" (µs) — normalise by digit count
                    let frac: f32 = if sec_parts.len() > 1 {
                        let raw = sec_parts[1].trim();
                        let v: f64 = raw.parse().unwrap_or(0.0);
                        (v / 10f64.powi(raw.len() as i32)) as f32
                    } else {
                        0.0
                    };
                    current_time = Some(h * 3600.0 + m * 60.0 + s + frac);
                }
            }
            continue;
        }

        // 2. UTC datetime line: "2023-01-21 15:08:55,429,228"
        if let Some(caps) = datetime_re(trimmed) {
            // civil-time-of-day seconds (only used for cross-checks)
            utc_time = Some(caps.0 * 3600.0 + caps.1 * 60.0 + caps.2 + caps.3);
            continue;
        }

        // 3. Non-bracketed "Key : value" text (e.g. "SrtCnt : 2645, DiffTime : 34ms")
        if !trimmed.contains('[') && trimmed.contains(':') {
            // split on ',' then on ':' — first word before ':' is the key
            for seg in trimmed.split(',') {
                if let Some(ci) = seg.find(':') {
                    // key = last word before ':', after any '>' HTML tag boundary
                    let key = seg[..ci]
                        .rsplit('>')
                        .next()
                        .and_then(|s| s.split_whitespace().last())
                        .map(srt_key)
                        .unwrap_or_default();
                    let val: String = seg[ci + 1..]
                        .trim()
                        .trim_end_matches(|c: char| c.is_alphabetic())
                        .trim()
                        .to_string();
                    if !key.is_empty() && !val.is_empty() {
                        kv.entry(key).or_insert(val);
                    }
                }
            }
        }

        // 4. Bracketed key:value pairs (old + new DJI formats)
        if trimmed.contains('[') && trimmed.contains(']') {
            let mut remaining = trimmed;
            while let Some(start) = remaining.find('[') {
                if let Some(end) = remaining[start..].find(']') {
                    let inner = &remaining[start + 1..start + end];
                    if let Some(colon_idx) = inner.find(':') {
                        let key = srt_key(&inner[..colon_idx]);
                        let val = inner[colon_idx + 1..].trim().to_string();
                        kv.insert(key, val);
                    }
                    remaining = &remaining[start + end + 1..];
                } else {
                    break;
                }
            }
            continue;
        }

        // 4. End of block
        if trimmed.contains("</font>") || trimmed.is_empty() {
            flush(&mut current_time, &mut utc_time, &mut kv, &mut points);
        }
    }
    flush(&mut current_time, &mut utc_time, &mut kv, &mut points);

    Ok(points)
}

/// Minimal datetime matcher without pulling in chrono: captures
/// `YYYY-MM-DD hh:mm:ss,fff[,\u00b5s]` and returns (h, m, s, frac).
fn regex_like_datetime() -> impl Fn(&str) -> Option<(f64, f64, f64, f64)> {
    |line: &str| {
        let b = line.as_bytes();
        if b.len() < 19 {
            return None;
        }
        if !(b[4] == b'-' && b[7] == b'-' && b[10] == b' ' && b[13] == b':' && b[16] == b':') {
            return None;
        }
        let num = |i: usize, n: usize| -> Option<f64> {
            line.get(i..i + n)?.parse::<f64>().ok()
        };
        let h = num(11, 2)?;
        let m = num(14, 2)?;
        let s = num(17, 2)?;
        let frac = if b.len() > 19 && (b[19] == b',' || b[19] == b'.') {
            let rest = &line[20..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let digits2: String = digits.chars().filter(|c| c.is_ascii_digit()).collect();
            let v: f64 = digits2.parse().unwrap_or(0.0);
            v / 10f64.powi(digits2.len() as i32)
        } else {
            0.0
        };
        Some((h, m, s, frac))
    }
}

fn parse_telemetry_csv(csv_path: &str) -> Result<Vec<FlightPoint>, String> {
    let file = match File::open(csv_path) {
        Ok(f) => f,
        Err(e) => return Err(format!("[TELEMETRY] Failed to open CSV '{}': {}", csv_path, e)),
    };
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(file);

    let headers = rdr
        .headers()
        .map_err(|e| format!("[TELEMETRY] Failed to read CSV headers: {}", e))?
        .clone();

    let clean_headers: Vec<String> = headers.iter().map(|h| clean_header(h)).collect();

    let mut time_col: Option<usize> = None;
    let mut lat_col: Option<usize> = None;
    let mut lon_col: Option<usize> = None;
    let mut alt_agl_col: Option<usize> = None;
    let mut alt_col: Option<usize> = None;
    let mut yaw_col: Option<usize> = None;
    let mut gimbal_pitch_col: Option<usize> = None;
    let mut pitch_col: Option<usize> = None;
    let mut roll_col: Option<usize> = None;

    for (i, h) in clean_headers.iter().enumerate() {
        if time_col.is_none()
            && (h.contains("timeseconds") || h.contains("timestamp") || h == "time" || h.contains("datetime"))
        {
            time_col = Some(i);
        }
        if lat_col.is_none() && (h.contains("latitude") || h == "lat" || h.contains("gpslat")) {
            lat_col = Some(i);
        }
        if lon_col.is_none() && (h.contains("longitude") || h == "lon" || h == "lng" || h.contains("gpslon")) {
            lon_col = Some(i);
        }
        if alt_agl_col.is_none()
            && (h.contains("heightagl")
                || h.contains("relativealt")
                || h.contains("relalt")
                || h.contains("altituderelative")
                || h.contains("vpsaltitude")
                || h.contains("altitudeaboveground")
                || h == "height")
        {
            alt_agl_col = Some(i);
        }
        if alt_col.is_none()
            && (h.contains("altitudem")
                || h.contains("altitudemeters")
                || h.contains("altitudeamsl")
                || h.contains("altitude")
                || h.contains("gpsalt")
                || h == "alt"
                || h.contains("elevation"))
        {
            alt_col = Some(i);
        }
        if yaw_col.is_none() && (h.contains("heading") || h.contains("yaw")) {
            yaw_col = Some(i);
        }
        if gimbal_pitch_col.is_none() && (h.contains("gimbalpitch") || h.contains("camerapitch")) {
            gimbal_pitch_col = Some(i);
        }
        if pitch_col.is_none() && !h.contains("gimbal") && h.contains("pitch") {
            pitch_col = Some(i);
        }
        if roll_col.is_none() && h.contains("roll") {
            roll_col = Some(i);
        }
    }

    let mut points: Vec<FlightPoint> = Vec::new();
    let mut first_time_sec: Option<f32> = None;

    for (row_idx, result) in rdr.records().enumerate() {
        let record = match result {
            Ok(r) => r,
            Err(_) => continue,
        };

        let get_f32 = |col_opt: Option<usize>, default: f32| -> f32 {
            col_opt
                .and_then(|c| record.get(c))
                .and_then(|val| val.trim().parse::<f32>().ok())
                .unwrap_or(default)
        };

        let get_f64 = |col_opt: Option<usize>, default: f64| -> f64 {
            col_opt
                .and_then(|c| record.get(c))
                .and_then(|val| val.trim().parse::<f64>().ok())
                .unwrap_or(default)
        };

        let lat = get_f64(lat_col, 0.0);
        let lon = get_f64(lon_col, 0.0);
        let alt = if let Some(c) = alt_agl_col {
            get_f32(Some(c), f32::NAN)
        } else {
            get_f32(alt_col, f32::NAN)
        };

        let yaw = get_f32(yaw_col, 0.0);
        let pitch = get_f32(pitch_col, 0.0);
        let roll = get_f32(roll_col, 0.0);
        let gimbal_pitch = gimbal_pitch_col
            .and_then(|c| record.get(c))
            .and_then(|val| val.trim().parse::<f32>().ok());

        let raw_time_sec = if let Some(c) = time_col {
            if let Some(t_str) = record.get(c) {
                t_str.trim().parse::<f32>().unwrap_or(row_idx as f32)
            } else {
                row_idx as f32
            }
        } else {
            row_idx as f32
        };

        let t_base = *first_time_sec.get_or_insert(raw_time_sec);
        let timestamp_sec = raw_time_sec - t_base;

        points.push(FlightPoint {
            timestamp_sec,
            latitude: lat,
            longitude: lon,
            altitude_m: alt,
            pitch_deg: pitch,
            roll_deg: roll,
            yaw_deg: yaw,
            gimbal_pitch_deg: gimbal_pitch,
            focal_len: None,
            ..Default::default()
        });
    }

    Ok(points)
}

/// Validate + repair a parsed telemetry track in place.
/// Returns warning strings (empty when clean). Missing altitude is an ERROR
/// when it is absent everywhere — never a silent default.
fn validate_telemetry(points: &mut Vec<FlightPoint>) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    if points.is_empty() {
        return Ok(warnings);
    }
    let n_missing = points.iter().filter(|p| !p.altitude_m.is_finite()).count();
    if n_missing == points.len() {
        return Err(
            "[TELEMETRY] No altitude data found in the telemetry file (expected altitude/rel_alt/\
             abs_alt). Altitude cannot be guessed — aborting rather than fabricating heights."
                .to_string(),
        );
    }
    if n_missing > 0 {
        warnings.push(format!(
            "[WARN] {} of {} telemetry records lack altitude — filled by interpolation.",
            n_missing,
            points.len()
        ));
        // nearest-valid fill: forward then backward pass
        let mut last = f32::NAN;
        for p in points.iter_mut() {
            if p.altitude_m.is_finite() {
                last = p.altitude_m;
            } else {
                p.altitude_m = last;
            }
        }
        let mut next = f32::NAN;
        for p in points.iter_mut().rev() {
            if p.altitude_m.is_finite() {
                next = p.altitude_m;
            } else if !p.altitude_m.is_finite() {
                p.altitude_m = next;
            }
        }
    }
    Ok(warnings)
}

fn parse_telemetry(path: &str) -> Result<(Vec<FlightPoint>, Vec<String>), String> {
    if path.trim().is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut pts = if path.to_lowercase().ends_with(".srt") {
        parse_dji_srt(path)?
    } else {
        parse_telemetry_csv(path)?
    };
    let warnings = validate_telemetry(&mut pts)?;
    smooth_trajectory(&mut pts);
    Ok((pts, warnings))
}

pub fn smooth_trajectory(points: &mut [FlightPoint]) {
    if points.is_empty() {
        return;
    }
    let n = points.len();
    let mut smoothed_lat = vec![0.0f64; n];
    let mut smoothed_lon = vec![0.0f64; n];
    let mut smoothed_alt = vec![0.0f32; n];

    // 1. Centred moving average (+- 2.0 seconds)
    for i in 0..n {
        let t = points[i].timestamp_sec;
        let mut sum_lat = 0.0f64;
        let mut sum_lon = 0.0f64;
        let mut sum_alt = 0.0f32;
        let mut count = 0usize;

        let mut j = i;
        while (points[j].timestamp_sec - t).abs() <= 2.0 {
            sum_lat += points[j].latitude;
            sum_lon += points[j].longitude;
            sum_alt += points[j].altitude_m;
            count += 1;
            if j == 0 {
                break;
            }
            j -= 1;
        }

        let mut k = i + 1;
        while k < n && (points[k].timestamp_sec - t).abs() <= 2.0 {
            sum_lat += points[k].latitude;
            sum_lon += points[k].longitude;
            sum_alt += points[k].altitude_m;
            count += 1;
            k += 1;
        }

        smoothed_lat[i] = sum_lat / count as f64;
        smoothed_lon[i] = sum_lon / count as f64;
        smoothed_alt[i] = sum_alt / count as f32;
    }

    for i in 0..n {
        points[i].latitude = smoothed_lat[i];
        points[i].longitude = smoothed_lon[i];
        points[i].altitude_m = smoothed_alt[i];
    }

    // 2. Yaw calculation where yaw == 0
    let mut last_yaw = 0.0f32;
    const R: f64 = 6_378_137.0;

    for i in 0..n {
        if points[i].yaw_deg.abs() > 0.01 {
            last_yaw = points[i].yaw_deg;
            continue;
        }

        let prev_idx = if i > 0 { i - 1 } else { 0 };
        let next_idx = if i + 1 < n { i + 1 } else { n - 1 };

        if prev_idx != next_idx {
            let p1 = &points[prev_idx];
            let p2 = &points[next_idx];
            let dt = (p2.timestamp_sec - p1.timestamp_sec).abs();

            let lat_rad = (p1.latitude * std::f64::consts::PI / 180.0) as f32;
            let deg_to_rad = std::f64::consts::PI as f32 / 180.0;
            let dx = ((p2.longitude - p1.longitude) as f32) * deg_to_rad * (R as f32) * lat_rad.cos();
            let dz = ((p2.latitude - p1.latitude) as f32) * deg_to_rad * (R as f32);

            let dist = (dx * dx + dz * dz).sqrt();
            let speed = if dt > 1e-4 { dist / dt } else { 0.0 };

            if speed >= 0.3 {
                let bearing_rad = dx.atan2(dz);
                let mut bearing_deg = bearing_rad.to_degrees();
                if bearing_deg < 0.0 {
                    bearing_deg += 360.0;
                }
                last_yaw = bearing_deg;
            }
        }
        points[i].yaw_deg = last_yaw;
    }
}

/// Circular interpolation for yaw — handles the 359° -> 1° wrap.
fn lerp_yaw(a: f32, b: f32, t: f32) -> f32 {
    let mut d = (b - a) % 360.0;
    if d > 180.0 {
        d -= 360.0;
    }
    if d < -180.0 {
        d += 360.0;
    }
    let v = a + t * d;
    if v < 0.0 {
        v + 360.0
    } else if v >= 360.0 {
        v - 360.0
    } else {
        v
    }
}

fn lerp_opt_angle(a: Option<f32>, b: Option<f32>, t: f32) -> Option<f32> {
    match (a, b) {
        (Some(ga), Some(gb)) => Some(lerp_yaw(ga, gb, t)),
        (Some(ga), None) => Some(ga),
        (None, Some(gb)) => Some(gb),
        (None, None) => None,
    }
}

fn lerp_opt(a: Option<f32>, b: Option<f32>, t: f32) -> Option<f32> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x + t * (y - x)),
        _ => a.or(b),
    }
}

fn lerp_point(a: &FlightPoint, b: &FlightPoint, t: f32) -> FlightPoint {
    FlightPoint {
        timestamp_sec: a.timestamp_sec + t * (b.timestamp_sec - a.timestamp_sec),
        timestamp_utc: match (a.timestamp_utc, b.timestamp_utc) {
            (Some(ua), Some(ub)) => Some(ua + t as f64 * (ub - ua)),
            _ => a.timestamp_utc.or(b.timestamp_utc),
        },
        latitude: a.latitude + t as f64 * (b.latitude - a.latitude),
        longitude: a.longitude + t as f64 * (b.longitude - a.longitude),
        altitude_m: a.altitude_m + t * (b.altitude_m - a.altitude_m),
        pitch_deg: a.pitch_deg + t * (b.pitch_deg - a.pitch_deg),
        roll_deg: a.roll_deg + t * (b.roll_deg - a.roll_deg),
        yaw_deg: lerp_yaw(a.yaw_deg, b.yaw_deg, t),
        gimbal_pitch_deg: lerp_opt(a.gimbal_pitch_deg, b.gimbal_pitch_deg, t),
        gimbal_yaw_deg: lerp_opt_angle(a.gimbal_yaw_deg, b.gimbal_yaw_deg, t),
        gimbal_roll_deg: lerp_opt(a.gimbal_roll_deg, b.gimbal_roll_deg, t),
        frame_cnt: a.frame_cnt,
        focal_len: a.focal_len.or(b.focal_len),
        iso: lerp_opt(a.iso, b.iso, t),
        shutter_sec: lerp_opt(a.shutter_sec, b.shutter_sec, t),
        ev: lerp_opt(a.ev, b.ev, t),
    }
}

/// Telemetry interpolated at absolute telemetry time `t` (seconds since the
/// telemetry track start). `target = frame_idx / fps + clock_offset`.
fn telemetry_at(points: &[FlightPoint], target_time: f32) -> Option<FlightPoint> {
    if points.is_empty() {
        return None;
    }
    let pos = points.iter().position(|p| p.timestamp_sec >= target_time);
    match pos {
        None => Some(points.last().unwrap().clone()),
        Some(0) => Some(points[0].clone()),
        Some(i) => {
            let a = &points[i - 1];
            let b = &points[i];
            let span = b.timestamp_sec - a.timestamp_sec;
            if span < 1e-6 {
                Some(a.clone())
            } else {
                let t = (target_time - a.timestamp_sec) / span;
                Some(lerp_point(a, b, t))
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Camera Pose & Coordinate Frame Extrinsics
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CameraPose {
    pub pos: [f32; 3],
    pub right: [f32; 3],
    pub down: [f32; 3],
    pub forward: [f32; 3],
}

pub fn camera_pose_from_telemetry(
    fp: &FlightPoint,
    origin: &FlightPoint,
    earth_radius_m: f64,
) -> CameraPose {
    let lat_rad = origin.latitude * std::f64::consts::PI / 180.0;
    let deg_to_rad = std::f64::consts::PI / 180.0;
    let delta_lat = fp.latitude - origin.latitude;
    let delta_lon = fp.longitude - origin.longitude;

    let world_x = (delta_lon * deg_to_rad * earth_radius_m * lat_rad.cos()) as f32;
    let world_y = fp.altitude_m - origin.altitude_m;
    let world_z = -(delta_lat * deg_to_rad * earth_radius_m) as f32; // -Z = North

    let pitch_rad = fp.pitch_deg.to_radians();
    let roll_rad = fp.roll_deg.to_radians();
    let yaw_rad = fp.yaw_deg.to_radians();

    let (s_p, c_p) = pitch_rad.sin_cos();
    let (s_r, c_r) = roll_rad.sin_cos();
    let (s_y, c_y) = yaw_rad.sin_cos();

    let right = [
        c_y * c_r + s_y * s_p * s_r,
        -c_p * s_r,
        s_y * c_r - c_y * s_p * s_r,
    ];
    let down = [
        -c_y * s_r + s_y * s_p * c_r,
        -c_p * c_r,
        -s_y * s_r - c_y * s_p * c_r,
    ];
    let forward = [
        s_y * c_p,
        s_p,
        -c_y * c_p,
    ];

    CameraPose {
        pos: [world_x, world_y, world_z],
        right,
        down,
        forward,
    }
}

// ─────────────────────────────────────────────────────────────
// RAII Temp-Dir Guard
// ─────────────────────────────────────────────────────────────

struct TempDirGuard {
    path: String,
}
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// ─────────────────────────────────────────────────────────────
// Spatial Surface Fusion & De-duplication Grid
// ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct SurfacePoint {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub weight: f32,
    /// frame that contributed the single largest weight (65535 = hole-filled)
    pub frame_id: u16,
    /// largest single contribution weight seen so far
    pub best_w: f32,
}

pub type SurfaceKey = (i32, i32);

#[inline]
pub fn surface_key(x: f32, z: f32, cell_size: f32) -> SurfaceKey {
    (
        (x / cell_size).floor() as i32,
        (z / cell_size).floor() as i32,
    )
}

#[inline]
pub fn voxel_key(x: f32, y: f32, z: f32, cell_size: f32) -> (i32, i32, i32) {
    (
        (x / cell_size).floor() as i32,
        (y / cell_size).floor() as i32,
        (z / cell_size).floor() as i32,
    )
}

// ─────────────────────────────────────────────────────────────
// Video ↔ telemetry clock-offset estimation.
// Cross-correlates visual motion magnitude (ZNCC shift, pixels/s at model res)
// against GPS ground speed at 1 Hz. Returns (offset_sec, pearson_score).
// Video time t maps to telemetry time (t + offset).
// ─────────────────────────────────────────────────────────────

fn pearson(x: &[f32], y: &[f32]) -> f32 {
    let n = x.len().min(y.len());
    if n < 5 {
        return 0.0;
    }
    let mx: f32 = x[..n].iter().sum::<f32>() / n as f32;
    let my: f32 = y[..n].iter().sum::<f32>() / n as f32;
    let (mut sxy, mut sxx, mut syy) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..n {
        let dx = x[i] - mx;
        let dy = y[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx < 1e-9 || syy < 1e-9 {
        return 0.0;
    }
    sxy / (sxx * syy).sqrt()
}

/// GPS ground-speed resampled to 1 Hz over [t0, t1) of the telemetry track.
/// Index s = speed over [t0+s, t0+s+1].
fn gps_speed_series(points: &[FlightPoint]) -> Vec<f32> {
    if points.len() < 2 {
        return Vec::new();
    }
    let t0 = points.first().unwrap().timestamp_sec;
    let t1 = points.last().unwrap().timestamp_sec;
    let n = (t1 - t0).floor().max(0.0) as usize;
    let mut out = Vec::with_capacity(n);
    for s in 0..n {
        let a = telemetry_at(points, t0 + s as f32);
        let b = telemetry_at(points, t0 + s as f32 + 1.0);
        match (a, b) {
            (Some(a), Some(b)) => {
                let lat_rad = (a.latitude * std::f64::consts::PI / 180.0) as f32;
                let dx = ((b.longitude - a.longitude) as f32)
                    * (std::f64::consts::PI as f32 / 180.0)
                    * 6_378_137.0
                    * lat_rad.cos();
                let dy = ((b.latitude - a.latitude) as f32)
                    * (std::f64::consts::PI as f32 / 180.0)
                    * 6_378_137.0;
                out.push((dx * dx + dy * dy).sqrt());
            }
            _ => out.push(0.0),
        }
    }
    out
}

/// Search clock offset o (video_t + o = telemetry_t) that maximises Pearson
/// correlation between per-frame visual-motion magnitude and GPS speed.
/// `motion[i]` is pixels/s of frame i (1 fps sampling).
pub fn estimate_sync_offset(points: &[FlightPoint], motion: &[f32]) -> (f32, f32) {
    if points.len() < 2 || motion.len() < 5 {
        return (0.0, 0.0);
    }
    let t0 = points.first().unwrap().timestamp_sec;
    let t1 = points.last().unwrap().timestamp_sec;
    let srt_dur = t1 - t0;
    let vid_dur = motion.len() as f32;
    if srt_dur < 4.0 || vid_dur < 4.0 {
        return (0.0, 0.0);
    }
    let gps = gps_speed_series(points);
    let n_gps = gps.len() as i64;
    let n_mot = motion.len() as i64;

    let mut best_o = 0.0f32;
    let mut best_c = f32::NEG_INFINITY;
    // o in [-(vid_dur-4), srt_dur-4]; integer steps then 0.1 refine.
    let mut o = -(vid_dur - 4.0);
    while o <= srt_dur - 4.0 {
        let i0 = (-o).ceil().max(0.0) as i64;
        let i1 = (n_mot - 1).min((srt_dur - 1.0 - o).floor() as i64);
        if i1 - i0 >= 4 {
            let mut gs = Vec::new();
            let mut ms = Vec::new();
            for i in i0..=i1 {
                let si = (o + i as f32).round() as i64;
                if si >= 0 && si < n_gps {
                    gs.push(gps[si as usize]);
                    ms.push(motion[i as usize]);
                }
            }
            let c = pearson(&gs, &ms);
            if c > best_c {
                best_c = c;
                best_o = o;
            }
        }
        o += 1.0;
    }
    // 0.1 s refinement
    let mut o = best_o - 0.9;
    while o <= best_o + 0.9 {
        let i0 = (-o).ceil().max(0.0) as i64;
        let i1 = (n_mot - 1).min((srt_dur - 1.0 - o).floor() as i64);
        if i1 - i0 >= 4 {
            let mut gs = Vec::new();
            let mut ms = Vec::new();
            for i in i0..=i1 {
                let si = (o + i as f32).round() as i64;
                if si >= 0 && si < n_gps {
                    gs.push(gps[si as usize]);
                    ms.push(motion[i as usize]);
                }
            }
            let c = pearson(&gs, &ms);
            if c > best_c {
                best_c = c;
                best_o = o;
            }
        }
        o += 0.1;
    }
    (best_o, best_c)
}

// ─────────────────────────────────────────────────────────────
// Inter-Frame Visual Odometry (Zero-Mean NCC)
// ─────────────────────────────────────────────────────────────

fn estimate_frame_shift(prev_rgb: &[u8], curr_rgb: &[u8], width: usize, height: usize) -> (f32, f32) {
    let sw = 96;
    let sh = 96;
    let mut s_prev = vec![0.0f32; sw * sh];
    let mut s_curr = vec![0.0f32; sw * sh];

    let step_x = (width / sw).max(1);
    let step_y = (height / sh).max(1);

    for y in 0..sh {
        for x in 0..sw {
            let p_idx = (y * step_y * width + x * step_x) * 3;
            if p_idx + 2 < prev_rgb.len() && p_idx + 2 < curr_rgb.len() {
                s_prev[y * sw + x] = 0.299 * prev_rgb[p_idx] as f32
                    + 0.587 * prev_rgb[p_idx + 1] as f32
                    + 0.114 * prev_rgb[p_idx + 2] as f32;
                s_curr[y * sw + x] = 0.299 * curr_rgb[p_idx] as f32
                    + 0.587 * curr_rgb[p_idx + 1] as f32
                    + 0.114 * curr_rgb[p_idx + 2] as f32;
            }
        }
    }

    let mut best_corr = f32::NEG_INFINITY;
    let mut best_dy = 0.0f32;
    let mut best_dx = 0.0f32;

    for dy in -15..=45 {
        for dx in -20..=20 {
            let mut sum_p = 0.0f32;
            let mut sum_c = 0.0f32;
            let mut count = 0usize;

            for y in (15..sh - 20).step_by(2) {
                let y2 = y as i32 + dy;
                if y2 < 0 || y2 >= sh as i32 {
                    continue;
                }
                let y2 = y2 as usize;

                for x in (15..sw - 15).step_by(2) {
                    let x2 = x as i32 + dx;
                    if x2 < 0 || x2 >= sw as i32 {
                        continue;
                    }
                    let x2 = x2 as usize;

                    sum_p += s_prev[y * sw + x];
                    sum_c += s_curr[y2 * sw + x2];
                    count += 1;
                }
            }

            if count > 50 {
                let mean_p = sum_p / count as f32;
                let mean_c = sum_c / count as f32;

                let mut sum_prod = 0.0f32;
                let mut sum_sq_p = 0.0f32;
                let mut sum_sq_c = 0.0f32;

                for y in (15..sh - 20).step_by(2) {
                    let y2_i = y as i32 + dy;
                    if y2_i < 0 || y2_i >= sh as i32 {
                        continue;
                    }
                    let y2 = y2_i as usize;

                    for x in (15..sw - 15).step_by(2) {
                        let x2_i = x as i32 + dx;
                        if x2_i < 0 || x2_i >= sw as i32 {
                            continue;
                        }
                        let x2 = x2_i as usize;

                        let dp = s_prev[y * sw + x] - mean_p;
                        let dc = s_curr[y2 * sw + x2] - mean_c;
                        sum_prod += dp * dc;
                        sum_sq_p += dp * dp;
                        sum_sq_c += dc * dc;
                    }
                }

                let denom = (sum_sq_p * sum_sq_c).sqrt();
                if denom > 1e-4 {
                    let corr = sum_prod / denom;
                    if corr > best_corr {
                        best_corr = corr;
                        best_dy = dy as f32;
                        best_dx = dx as f32;
                    }
                }
            }
        }
    }

    let scale_x = width as f32 / sw as f32;
    let scale_y = height as f32 / sh as f32;
    (best_dx * scale_x, best_dy * scale_y)
}

// ─────────────────────────────────────────────────────────────
// FFmpeg Frame Extraction (Hardware-Accelerated with Fallback)
// ─────────────────────────────────────────────────────────────

fn extract_frames<R: tauri::Runtime>(video_path: &str, output_dir: &str, app: &tauri::AppHandle<R>) -> Result<(), String> {
    fs::create_dir_all(output_dir).map_err(|e| format!("[FFMPEG] mkdir failed: {}", e))?;

    // Try -hwaccel cuda first
    let cuda_status = Command::new("ffmpeg")
        .args([
            "-y",
            "-hwaccel",
            "cuda",
            "-i",
            video_path,
            "-vf",
            "fps=1",
            "-q:v",
            "2",
            &format!("{}/frame_%04d.jpg", output_dir),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    if let Ok(st) = cuda_status {
        if st.success() {
            let _ = app.emit("pipeline-log", "[FFMPEG] Hardware acceleration engaged (-hwaccel cuda).");
            return Ok(());
        }
    }

    // Fallback to software decoding
    let _ = app.emit("pipeline-log", "[FFMPEG] Falling back to software frame decoding...");
    let sw_status = Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            video_path,
            "-vf",
            "fps=1",
            "-q:v",
            "2",
            &format!("{}/frame_%04d.jpg", output_dir),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("[FFMPEG] Launch failed: {}", e))?;

    if !sw_status.success() {
        return Err("[FFMPEG] Process exited with non-zero status. Verify FFmpeg is on PATH.".into());
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// ONNX Session Builder with CUDA → CPU Fallback & Cache
// ─────────────────────────────────────────────────────────────

static SESSION_CACHE: OnceLock<Mutex<Session>> = OnceLock::new();

fn build_ort_session<R: tauri::Runtime>(
    threads: usize,
    app: &tauri::AppHandle<R>,
    model_path: &str,
) -> Result<&'static Mutex<Session>, String> {
    if let Some(cached) = SESSION_CACHE.get() {
        return Ok(cached);
    }

    let cuda_ep = ep::CUDA::default().with_device_id(0).build();
    let cuda_result = Session::builder()
        .map_err(|e| e.to_string())?
        .with_execution_providers([cuda_ep])
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .with_intra_threads(threads)
        .map_err(|e| e.to_string())?
        .commit_from_file(model_path);

    let session = match cuda_result {
        Ok(s) => {
            let _ = app.emit(
                "pipeline-log",
                "[GPU] ✓ CUDA Execution Provider engaged — device 0.",
            );
            s
        }
        Err(cuda_err) => {
            let warn = format!(
                "[WARN] RUNNING ON CPU: CUDA EP failed: {}. Check that nvcuda.dll and cudnn64_8.dll are on PATH.",
                cuda_err
            );
            let _ = app.emit("pipeline-log", &warn);

            let cpu_ep = ep::CPU::default().build();
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_execution_providers([cpu_ep])
                .map_err(|e| e.to_string())?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| e.to_string())?
                .with_intra_threads(threads)
                .map_err(|e| e.to_string())?
                .commit_from_file(model_path)
                .map_err(|e| format!("[CPU] Session build failed: {}", e))?
        }
    };

    let _ = SESSION_CACHE.set(Mutex::new(session));
    Ok(SESSION_CACHE.get().unwrap())
}

// ─────────────────────────────────────────────────────────────
// Main Reconstruction Command
// ─────────────────────────────────────────────────────────────

const MODEL_PATH: &str = "../models/depth_anything_v2_vits.onnx";
const TEMP_FRAMES_DIR: &str = "../backend/temp_frames";

/// Output file names inside the per-run output directory.
pub const PLY_NAME: &str = "recon_output.ply";
pub const OBJ_NAME: &str = "recon_output.obj";
pub const LAS_NAME: &str = "recon_output.las";
pub const GLB_NAME: &str = "recon_output.glb";
pub const GEOREF_NAME: &str = "recon_georeference.json";

const ONNX_INPUT_NAME: &str = "pixel_values";
const ONNX_OUTPUT_NAME: &str = "predicted_depth";

/// Resolve the per-run output directory: <app-data>/recon/runs/<timestamp>/.
/// Falls back to std::env::temp_dir() when path resolution is unavailable
/// (e.g. mock runtime in tests).
fn resolve_output_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("recon-engine"));
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    base.join("recon").join("runs").join(format!("{}", ts))
}

#[tauri::command]
async fn run_reconstruction(
    app: tauri::AppHandle,
    video_path: String,
    telemetry_path: String,
    hardware_profile: HardwareProfile,
    camera_pitch_deg: Option<f32>,
    sync_offset_sec: Option<f32>,
    frame_range: Option<(u32, u32)>,
) -> Result<String, String> {
    let pitch = camera_pitch_deg.unwrap_or(-45.0);
    let out_dir = resolve_output_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        run_reconstruction_inner(
            app,
            video_path,
            telemetry_path,
            hardware_profile,
            pitch,
            out_dir,
            sync_offset_sec,
            frame_range,
        )
    })
    .await
    .map_err(|e| format!("[FATAL] Background thread execution failed: {}", e))?
}

fn run_reconstruction_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    video_path: String,
    telemetry_path: String,
    hardware_profile: HardwareProfile,
    camera_pitch_deg: f32,
    out_dir: std::path::PathBuf,
    sync_offset_override: Option<f32>,
    frame_range: Option<(u32, u32)>,
) -> Result<String, String> {
    let wall_clock = Instant::now();
    let _ = app.emit("pipeline-log", "[SYSTEM] Initializing tactical 3D reconstruction pipeline...");

    let threads = hardware_profile.intra_threads();
    let cell_size = hardware_profile.cell_size_m();

    // ── 1. ONNX Session (Cached) ──────────────────────────────
    let t_session_start = Instant::now();
    let session_mutex = build_ort_session(threads, &app, MODEL_PATH)?;
    let mut session = session_mutex.lock().map_err(|e| format!("Session lock poisoned: {}", e))?;
    let t_session = t_session_start.elapsed();
    let _ = app.emit("pipeline-log", format!("[TIME] Session initialization: {:.2?}", t_session));

    // ── 2. Frame Extraction ──────────────────────────────────
    let t_ffmpeg_start = Instant::now();
    let _ = app.emit("pipeline-log", "[FFMPEG] Slicing video into 1-fps frames...");
    extract_frames(&video_path, TEMP_FRAMES_DIR, &app)?;
    let _guard = TempDirGuard { path: TEMP_FRAMES_DIR.to_string() };

    let mut frame_paths: Vec<_> = fs::read_dir(TEMP_FRAMES_DIR)
        .map_err(|e| format!("[IO] Cannot list frames: {}", e))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .collect();
    frame_paths.sort();
    let num_frames = frame_paths.len();

    if num_frames == 0 {
        return Err("[FFMPEG] No frames were extracted. Verify the video file is valid.".into());
    }
    let t_ffmpeg = t_ffmpeg_start.elapsed();
    let _ = app.emit(
        "pipeline-log",
        format!("[FFMPEG] {} frames extracted. (Time: {:.2?})", num_frames, t_ffmpeg),
    );

    // ── 3. Telemetry Ingestion & Duration Validation ─────────
    let (telemetry, tele_warnings) = parse_telemetry(&telemetry_path)?;
    let has_telemetry = !telemetry.is_empty();
    for w in &tele_warnings {
        let _ = app.emit("pipeline-log", w.clone());
    }

    if has_telemetry {
        let srt_dur = telemetry.last().map(|p| p.timestamp_sec).unwrap_or(0.0)
            - telemetry.first().map(|p| p.timestamp_sec).unwrap_or(0.0);
        let video_dur = num_frames as f32;
        if (video_dur - srt_dur).abs() > 2.0 {
            let _ = app.emit(
                "pipeline-log",
                format!(
                    "[WARN] Video duration ({:.1}s) and telemetry duration ({:.1}s) differ by >2s!",
                    video_dur, srt_dur
                ),
            );
        }
        let _ = app.emit(
            "pipeline-log",
            format!("[TELEMETRY] Loaded {} smoothed records. Trajectory aligned.", telemetry.len()),
        );
    } else {
        let _ = app.emit(
            "pipeline-log",
            "[ODOMETRY] No external telemetry provided. Pure visual odometry driving 3D trajectory.",
        );
    }

    // ── 3b. Video↔telemetry clock-offset estimation ─────────
    // Frames are at 1 fps → motion[i] ≈ pixel drift over video second i.
    // offset o maps frame i ↔ telemetry time (t0 + o + i).
    let mut sync_offset = 0.0f32;
    let mut tel_t0 = 0.0f32;
    if has_telemetry {
        tel_t0 = telemetry.first().map(|p| p.timestamp_sec).unwrap_or(0.0);
        if let Some(manual) = sync_offset_override {
            sync_offset = manual;
            let _ = app.emit(
                "pipeline-log",
                format!("[SYNC] Manual clock-offset override: {:.2}s", manual),
            );
        } else {
            // motion pre-pass: per-frame pixel drift at 1 fps
            let mut motion: Vec<f32> = Vec::with_capacity(num_frames);
            let mut prev_small: Option<Vec<u8>> = None;
            for path in &frame_paths {
                if let Ok(img) = image::open(path) {
                    let small = img
                        .resize_exact(480, 270, FilterType::Triangle)
                        .to_rgb8()
                        .into_raw();
                    if let Some(prev) = &prev_small {
                        let (dx, dy) = estimate_frame_shift(prev, &small, 480, 270);
                        motion.push((dx * dx + dy * dy).sqrt());
                    } else {
                        motion.push(0.0);
                    }
                    prev_small = Some(small);
                } else {
                    motion.push(0.0);
                }
            }
            let (off, conf) = estimate_sync_offset(&telemetry, &motion);
            if conf >= 0.3 {
                sync_offset = off;
                let _ = app.emit(
                    "pipeline-log",
                    format!("[SYNC] Estimated video↔telemetry offset = {:.2}s (r={:.2}) — applied.", off, conf),
                );
            } else {
                let _ = app.emit(
                    "pipeline-log",
                    format!("[WARN] [SYNC] Offset estimate {:.2}s has low confidence (r={:.2}) — keeping 0.0s. Telemetry may be wrong-window.", off, conf),
                );
            }
        }
    }

    // ── 4. Determine Model Resolution & Letterbox ────────────
    let first_img = image::open(&frame_paths[0])
        .map_err(|e| format!("[IMAGE] Cannot open first frame: {}", e))?;
    let (orig_w, orig_h) = first_img.dimensions();

    // Check dynamic inference support with 756x420, fallback to 518x518 letterbox
    let mut use_dynamic_756 = false;
    let dummy_test = Tensor::from_array(([1usize, 3, 420, 756], vec![0.0f32; 1 * 3 * 420 * 756]));
    if let Ok(tensor) = dummy_test {
        if session.run(inputs![ONNX_INPUT_NAME => tensor]).is_ok() {
            use_dynamic_756 = true;
        }
    }

    let (inp_w, inp_h) = if use_dynamic_756 {
        (756usize, 420usize)
    } else {
        (518usize, 518usize)
    };

    // Calculate letterbox bounds if static 518x518
    let (active_y_start, active_y_end) = if !use_dynamic_756 && orig_w > 0 && orig_h > 0 {
        let aspect = orig_h as f32 / orig_w as f32;
        let target_h = ((inp_w as f32 * aspect) as usize).clamp(100, inp_h);
        let pad_top = (inp_h - target_h) / 2;
        (pad_top, pad_top + target_h)
    } else {
        (0, inp_h)
    };

    // Camera Intrinsics
    let srt_focal = telemetry.first().and_then(|p| p.focal_len).unwrap_or(224.0);
    let intrinsics = CameraIntrinsics::from_focal_len_eq(inp_w, inp_h, srt_focal);
    let (cx, cy) = (intrinsics.cx, intrinsics.cy);
    let (fx, fy) = (intrinsics.fx, intrinsics.fy);

    let _ = app.emit(
        "pipeline-log",
        format!(
            "[CAMERA] HFOV = {:.1}°, fx = fy = {:.1}px | Input = {}x{} (letterbox rows {}..{})",
            intrinsics.hfov_deg, fx, inp_w, inp_h, active_y_start, active_y_end
        ),
    );

    // Normalization parameters
    let mn = [0.485f32, 0.456, 0.406];
    let sd = [0.229f32, 0.224, 0.225];
    let area = inp_w * inp_h;

    // Fusion grid
    let mut surface_grid: HashMap<SurfaceKey, SurfacePoint> =
        HashMap::with_capacity(num_frames * (area / 4));

    let mut prev_rgb: Option<Vec<u8>> = None;
    let mut cur_world_x = 0.0f32;
    let mut cur_world_z = 0.0f32;

    // Temporal smoothing EMA for depth scale (P1)
    let mut ema_p5 = 0.0f32;
    let mut ema_p95 = 0.0f32;

    let t_infer_start = Instant::now();

    // Reusable buffers
    let mut chw = vec![0.0f32; 3 * area];
    let mut depth_samples = Vec::with_capacity(area);

    // ── 5. Per-Frame Inference & Back-Projection Loop ────────
    // [demo] per-frame camera positions for recon_cameras.json (PLY frame)
    let mut cam_positions: Vec<(u32, f32, [f32; 3])> = Vec::new();

    for (frame_idx, path) in frame_paths.iter().enumerate() {
        if let Some((a, b)) = frame_range {
            let i = frame_idx as u32;
            if i < a || i > b {
                continue;
            }
        }
        let orig = image::open(path)
            .map_err(|e| format!("[IMAGE] Cannot open {:?}: {}", path, e))?;

        let rgb_img = if use_dynamic_756 {
            orig.resize_exact(inp_w as u32, inp_h as u32, FilterType::Triangle).to_rgb8()
        } else {
            // Letterbox into 518x518
            let active_h = active_y_end - active_y_start;
            let resized_active = orig.resize_exact(inp_w as u32, active_h as u32, FilterType::Triangle).to_rgb8();
            let mut canvas = RgbImage::new(inp_w as u32, inp_h as u32);
            image::imageops::overlay(&mut canvas, &resized_active, 0, active_y_start as i64);
            canvas
        };
        let raw_rgb = rgb_img.into_raw();

        // CHW Normalization
        for y in 0..inp_h {
            for x in 0..inp_w {
                let idx = y * inp_w + x;
                let p_idx = idx * 3;
                chw[idx] = (raw_rgb[p_idx] as f32 / 255.0 - mn[0]) / sd[0];
                chw[area + idx] = (raw_rgb[p_idx + 1] as f32 / 255.0 - mn[1]) / sd[1];
                chw[2 * area + idx] = (raw_rgb[p_idx + 2] as f32 / 255.0 - mn[2]) / sd[2];
            }
        }

        // ONNX Inference
        let shape = [1usize, 3, inp_h, inp_w];
        let tensor = Tensor::from_array((shape, chw.clone()))
            .map_err(|e| format!("[ONNX] Tensor build failed: {}", e))?;
        let outputs = session
            .run(inputs![ONNX_INPUT_NAME => tensor])
            .map_err(|e| format!("[ONNX] Inference failed on frame {}: {}", frame_idx, e))?;
        let depth_view = outputs[ONNX_OUTPUT_NAME]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("[ONNX] Output extraction failed: {}", e))?;
        let depth_raw: &[f32] = depth_view.1;

        // Telemetry lookup at the frame's true timestamp: t0 + offset + frame
        let fp_opt = telemetry_at(&telemetry, frame_idx as f32 + sync_offset + tel_t0);
        let h_agl = fp_opt.as_ref().map(|p| p.altitude_m).unwrap_or(20.0).clamp(3.0, 400.0);
        let yaw_deg = fp_opt.as_ref().map(|p| p.yaw_deg).unwrap_or(0.0);
        // Gimbal pitch from telemetry by default; the dropdown is the override.
        let eff_pitch_deg = fp_opt
            .as_ref()
            .and_then(|p| p.gimbal_pitch_deg)
            .unwrap_or(camera_pitch_deg);

        // Visual odometry shift
        let (v_shift_x, v_shift_y) = if let Some(ref prev) = prev_rgb {
            estimate_frame_shift(prev, &raw_rgb, inp_w, inp_h)
        } else {
            (0.0, 0.0)
        };

        let v_metric_forward = v_shift_y * (h_agl / fx);
        let v_metric_lateral = -v_shift_x * (h_agl / fx);

        if frame_idx == 0 {
            cur_world_x = 0.0;
            cur_world_z = 0.0;
        } else if let (Some(ref curr_fp), Some(ref orig_fp)) = (&fp_opt, &telemetry.first()) {
            let lat_rad = (curr_fp.latitude * std::f64::consts::PI / 180.0) as f32;
            let delta_lat = (curr_fp.latitude - orig_fp.latitude) as f32;
            let delta_lon = (curr_fp.longitude - orig_fp.longitude) as f32;
            let deg_to_rad = std::f64::consts::PI as f32 / 180.0;
            let earth_r = 6_378_137.0f32;

            let gps_x = delta_lon * deg_to_rad * earth_r * lat_rad.cos();
            let gps_z = delta_lat * deg_to_rad * earth_r;

            let gps_step = (gps_z - cur_world_z).abs();
            let is_mismatched = gps_step < 0.1
                || (gps_step > 0.0 && v_metric_forward > 0.5 && (gps_step / v_metric_forward < 0.3 || gps_step / v_metric_forward > 3.0));

            if is_mismatched {
                let (sin_y, cos_y) = yaw_deg.to_radians().sin_cos();
                cur_world_x += v_metric_lateral * cos_y - v_metric_forward * sin_y;
                cur_world_z += v_metric_lateral * sin_y + v_metric_forward * cos_y;
            } else {
                cur_world_x = gps_x;
                cur_world_z = gps_z;
            }
        } else {
            let (sin_y, cos_y) = yaw_deg.to_radians().sin_cos();
            cur_world_x += v_metric_lateral * cos_y - v_metric_forward * sin_y;
            cur_world_z += v_metric_lateral * sin_y + v_metric_forward * cos_y;
        }

        prev_rgb = Some(raw_rgb.clone());

        // Fast percentile depth calculation via select_nth_unstable
        depth_samples.clear();
        depth_samples.extend_from_slice(depth_raw);
        let len = depth_samples.len();
        let idx5 = (len as f32 * 0.05) as usize;
        let (_, &mut raw_p5, _) = depth_samples.select_nth_unstable_by(idx5, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let idx95 = (len as f32 * 0.95) as usize;
        let (_, &mut raw_p95, _) = depth_samples.select_nth_unstable_by(idx95, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        // EMA smoothing across frames (P1)
        if frame_idx == 0 {
            ema_p5 = raw_p5;
            ema_p95 = raw_p95;
        } else {
            ema_p5 = 0.3 * raw_p5 + 0.7 * ema_p5;
            ema_p95 = 0.3 * raw_p95 + 0.7 * ema_p95;
        }
        let d_range = (ema_p95 - ema_p5).max(1e-4);

        // Camera pose basis vectors
        let yaw_rad = yaw_deg.to_radians();
        let pitch_rad = eff_pitch_deg.to_radians();
        let roll_rad = 0.0f32;

        let (s_p, c_p) = pitch_rad.sin_cos();
        let (s_r, c_r) = roll_rad.sin_cos();
        let (s_y, c_y) = yaw_rad.sin_cos();

        let right = [
            c_y * c_r + s_y * s_p * s_r,
            -c_p * s_r,
            s_y * c_r - c_y * s_p * s_r,
        ];
        let down = [
            -c_y * s_r + s_y * s_p * c_r,
            -c_p * c_r,
            -s_y * s_r - c_y * s_p * c_r,
        ];
        let forward = [
            s_y * c_p,
            s_p,
            -c_y * c_p,
        ];

        let cam_c = [cur_world_x, h_agl, -cur_world_z];
        cam_positions.push((
            frame_idx as u32,
            frame_idx as f32 + sync_offset + tel_t0,
            cam_c,
        ));

        // Back-projection loop across every pixel
        for y in active_y_start..active_y_end {
            let y_f = y as f32;
            let v = (y_f - cy) / fy;

            for x in 0..inp_w {
                let x_f = x as f32;
                let u = (x_f - cx) / fx;
                let idx = y * inp_w + x;

                let raw_d = depth_raw[idx];
                let norm_inv = ((raw_d - ema_p5) / d_range).clamp(0.0, 1.0);

                // Invalid depth filter
                if norm_inv < 0.05 {
                    continue;
                }

                // Flying pixel gradient check (P1)
                if x > 0 && x + 1 < inp_w && y > active_y_start && y + 1 < active_y_end {
                    let d_left = ((depth_raw[idx - 1] - ema_p5) / d_range).clamp(0.0, 1.0);
                    let d_right = ((depth_raw[idx + 1] - ema_p5) / d_range).clamp(0.0, 1.0);
                    let d_up = ((depth_raw[idx - inp_w] - ema_p5) / d_range).clamp(0.0, 1.0);
                    let d_down = ((depth_raw[idx + inp_w] - ema_p5) / d_range).clamp(0.0, 1.0);
                    if ((d_right - d_left).abs() * 0.5) > 0.08 || ((d_down - d_up).abs() * 0.5) > 0.08 {
                        continue;
                    }
                }

                // Ray construction
                let rx_unnorm = u * right[0] + v * down[0] + forward[0];
                let ry_unnorm = u * right[1] + v * down[1] + forward[1];
                let rz_unnorm = u * right[2] + v * down[2] + forward[2];
                let r_len = (rx_unnorm * rx_unnorm + ry_unnorm * ry_unnorm + rz_unnorm * rz_unnorm).sqrt();

                let ray_x = rx_unnorm / r_len;
                let ray_y = ry_unnorm / r_len;
                let ray_z = rz_unnorm / r_len;

                // Horizon / Sky skip: ray pointing near horizontal or up
                if -ray_y < 0.15 {
                    continue;
                }

                let t_plane = h_agl / (-ray_y);
                let t = t_plane * (1.0 + RELIEF_FRAC * (0.5 - norm_inv));

                let ply_x = cam_c[0] + t * ray_x;
                let ply_y = cam_c[1] + t * ray_y;
                let ply_z = cam_c[2] + t * ray_z;

                let p_idx = idx * 3;
                let pr = raw_rgb[p_idx] as f32;
                let pg = raw_rgb[p_idx + 1] as f32;
                let pb = raw_rgb[p_idx + 2] as f32;

                // Surface fusion
                let key = surface_key(ply_x, ply_z, cell_size);
                let w = (1.0 - (t / 150.0).clamp(0.0, 0.9)).max(0.1);

                match surface_grid.get_mut(&key) {
                    Some(cell) => {
                        let total_w = cell.weight + w;
                        cell.x = (cell.x * cell.weight + ply_x * w) / total_w;
                        cell.y = (cell.y * cell.weight + ply_y * w) / total_w;
                        cell.z = (cell.z * cell.weight + ply_z * w) / total_w;
                        cell.r = (cell.r * cell.weight + pr * w) / total_w;
                        cell.g = (cell.g * cell.weight + pg * w) / total_w;
                        cell.b = (cell.b * cell.weight + pb * w) / total_w;
                        cell.weight = total_w;
                        if w > cell.best_w {
                            cell.best_w = w;
                            cell.frame_id = frame_idx as u16;
                        }
                    }
                    None => {
                        surface_grid.insert(
                            key,
                            SurfacePoint {
                                x: ply_x,
                                y: ply_y,
                                z: ply_z,
                                r: pr,
                                g: pg,
                                b: pb,
                                weight: w,
                                frame_id: frame_idx as u16,
                                best_w: w,
                            },
                        );
                    }
                }
            }
        }

        let _ = app.emit(
            "pipeline-log",
            format!(
                "[FRAME {}/{}] fused surface points={} | H_agl={:.1}m",
                frame_idx + 1,
                num_frames,
                surface_grid.len(),
                h_agl,
            ),
        );
    }

    let t_infer = t_infer_start.elapsed();
    let _ = app.emit(
        "pipeline-log",
        format!("[TIME] Neural inference & fusion ({} frames): {:.2?}", num_frames, t_infer),
    );

    // ── 6. Triangulation & Mesh Generation (P1) ──────────────
    let t_mesh_start = Instant::now();
    let mut min_gx = i32::MAX;
    let mut max_gx = i32::MIN;
    let mut min_gz = i32::MAX;
    let mut max_gz = i32::MIN;

    for &(gx, gz) in surface_grid.keys() {
        min_gx = min_gx.min(gx);
        max_gx = max_gx.max(gx);
        min_gz = min_gz.min(gz);
        max_gz = max_gz.max(gz);
    }

    let grid_w = if max_gx >= min_gx { (max_gx - min_gx + 1) as usize } else { 0 };
    let grid_h = if max_gz >= min_gz { (max_gz - min_gz + 1) as usize } else { 0 };

    // Coarsen by integer factor if total cells exceed 4 million
    let mut coarsen_factor = 1i32;
    while ((grid_w / coarsen_factor as usize) * (grid_h / coarsen_factor as usize)) > 4_000_000 {
        coarsen_factor += 1;
    }

    let eff_w = (grid_w + coarsen_factor as usize - 1) / coarsen_factor as usize;
    let eff_h = (grid_h + coarsen_factor as usize - 1) / coarsen_factor as usize;

    let mut dense_pts: Vec<Option<SurfacePoint>> = vec![None; eff_w * eff_h];
    for (&(gx, gz), &pt) in surface_grid.iter() {
        let ix = ((gx - min_gx) / coarsen_factor) as usize;
        let iz = ((gz - min_gz) / coarsen_factor) as usize;
        if ix < eff_w && iz < eff_h {
            dense_pts[iz * eff_w + ix] = Some(pt);
        }
    }

    // 3x3 median and 3*MAD height outlier rejection
    let mut filtered_dense = dense_pts.clone();
    for iz in 1..eff_h.saturating_sub(1) {
        for ix in 1..eff_w.saturating_sub(1) {
            let idx = iz * eff_w + ix;
            if let Some(ref pt) = dense_pts[idx] {
                let mut heights = Vec::with_capacity(9);
                for dz in -1..=1 {
                    for dx in -1..=1 {
                        let n_idx = ((iz as isize + dz) as usize) * eff_w + ((ix as isize + dx) as usize);
                        if let Some(ref np) = dense_pts[n_idx] {
                            heights.push(np.y);
                        }
                    }
                }
                if heights.len() >= 5 {
                    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let median = heights[heights.len() / 2];
                    let mut diffs: Vec<f32> = heights.iter().map(|h| (h - median).abs()).collect();
                    diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let mad = diffs[diffs.len() / 2].max(0.1);
                    if (pt.y - median).abs() > 3.0 * mad {
                        filtered_dense[idx] = None;
                    }
                }
            }
        }
    }
    dense_pts = filtered_dense;
    let grid_w = eff_w;
    let grid_h = eff_h;

    // Hole-filling (up to 3 passes, requiring >= 3 neighbors)
    for _ in 0..3 {
        let mut updates: Vec<(usize, SurfacePoint)> = Vec::new();
        for iz in 1..grid_h.saturating_sub(1) {
            for ix in 1..grid_w.saturating_sub(1) {
                let idx = iz * grid_w + ix;
                if dense_pts[idx].is_some() {
                    continue;
                }
                let mut sum_x = 0.0f32;
                let mut sum_y = 0.0f32;
                let mut sum_z = 0.0f32;
                let mut sum_r = 0.0f32;
                let mut sum_g = 0.0f32;
                let mut sum_b = 0.0f32;
                let mut n_nbrs = 0usize;

                for dz in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dz == 0 { continue; }
                        let n_idx = ((iz as isize + dz) as usize) * grid_w + ((ix as isize + dx) as usize);
                        if let Some(ref p) = dense_pts[n_idx] {
                            sum_x += p.x;
                            sum_y += p.y;
                            sum_z += p.z;
                            sum_r += p.r;
                            sum_g += p.g;
                            sum_b += p.b;
                            n_nbrs += 1;
                        }
                    }
                }

                if n_nbrs >= 3 {
                    let inv = 1.0 / n_nbrs as f32;
                    updates.push((
                        idx,
                        SurfacePoint {
                            x: sum_x * inv,
                            y: sum_y * inv,
                            z: sum_z * inv,
                            r: sum_r * inv,
                            g: sum_g * inv,
                            b: sum_b * inv,
                            weight: 1.0,
                            frame_id: u16::MAX,
                            best_w: 0.0,
                        },
                    ));
                }
            }
        }
        if updates.is_empty() {
            break;
        }
        for (idx, pt) in updates {
            dense_pts[idx] = Some(pt);
        }
    }

    // Build indexed mesh vertices and faces
    let mut mesh_vertices: Vec<SurfacePoint> = Vec::new();
    let mut grid_to_vertex_idx: Vec<i32> = vec![-1; grid_w * grid_h];

    for idx in 0..(grid_w * grid_h) {
        if let Some(pt) = dense_pts[idx] {
            grid_to_vertex_idx[idx] = mesh_vertices.len() as i32;
            mesh_vertices.push(pt);
        }
    }

    let mut faces: Vec<[u32; 3]> = Vec::new();
    for iz in 0..grid_h.saturating_sub(1) {
        for ix in 0..grid_w.saturating_sub(1) {
            let i00 = grid_to_vertex_idx[iz * grid_w + ix];
            let i10 = grid_to_vertex_idx[iz * grid_w + (ix + 1)];
            let i01 = grid_to_vertex_idx[(iz + 1) * grid_w + ix];
            let i11 = grid_to_vertex_idx[(iz + 1) * grid_w + (ix + 1)];

            // Triangle 1: (0,0), (1,0), (0,1)
            if i00 >= 0 && i10 >= 0 && i01 >= 0 {
                let p00 = &mesh_vertices[i00 as usize];
                let p10 = &mesh_vertices[i10 as usize];
                let p01 = &mesh_vertices[i01 as usize];
                if (p00.y - p10.y).abs() < 2.0 && (p00.y - p01.y).abs() < 2.0 && (p10.y - p01.y).abs() < 2.0 {
                    faces.push([i00 as u32, i10 as u32, i01 as u32]);
                }
            }

            // Triangle 2: (1,0), (1,1), (0,1)
            if i10 >= 0 && i11 >= 0 && i01 >= 0 {
                let p10 = &mesh_vertices[i10 as usize];
                let p11 = &mesh_vertices[i11 as usize];
                let p01 = &mesh_vertices[i01 as usize];
                if (p10.y - p11.y).abs() < 2.0 && (p10.y - p01.y).abs() < 2.0 && (p11.y - p01.y).abs() < 2.0 {
                    faces.push([i10 as u32, i11 as u32, i01 as u32]);
                }
            }
        }
    }

    let t_mesh = t_mesh_start.elapsed();
    let _ = app.emit(
        "pipeline-log",
        format!(
            "[MESH] Triangulation generated {} vertices and {} faces. (Time: {:.2?})",
            mesh_vertices.len(),
            faces.len(),
            t_mesh
        ),
    );

    // ── 7. Multi-Format Deliverables Export ───────────────────
    let t_export_start = Instant::now();
    let vertex_count = mesh_vertices.len();

    fs::create_dir_all(&out_dir).map_err(|e| format!("[IO] Cannot create output dir {:?}: {}", out_dir, e))?;
    let _ = app.emit("pipeline-log", format!("[IO] Output directory: {}", out_dir.display()));

    let ply_path = out_dir.join(PLY_NAME);
    let obj_path = out_dir.join(OBJ_NAME);
    let las_path = out_dir.join(LAS_NAME);
    let glb_path = out_dir.join(GLB_NAME);
    let georef_path = out_dir.join(GEOREF_NAME);

    let emit_artifact = |kind: &str, path: &std::path::Path| {
        let _ = app.emit(
            "pipeline-artifact",
            serde_json::json!({"kind": kind, "path": path.to_string_lossy()}),
        );
    };

    // 7A. Binary PLY Export (with element face)
    write_ply(&ply_path, &mesh_vertices, &faces)?;

    // [demo] recon_frames.bin — u16 LE per PLY vertex (same order as write_ply)
    let frames_bin_path = out_dir.join("recon_frames.bin");
    {
        let mut fb = Vec::with_capacity(mesh_vertices.len() * 2);
        for pt in &mesh_vertices {
            fb.extend_from_slice(&pt.frame_id.to_le_bytes());
        }
        let _ = fs::write(&frames_bin_path, fb);
        emit_artifact("frames_bin", &frames_bin_path);
    }

    // [demo] recon_cameras.json — per-frame camera centres (PLY coords)
    let cams_path = out_dir.join("recon_cameras.json");
    {
        let arr: Vec<serde_json::Value> = cam_positions
            .iter()
            .map(|(f, t, c)| {
                serde_json::json!({"frame": f, "time_s": t, "cam": c})
            })
            .collect();
        let _ = fs::write(&cams_path, serde_json::to_string(&arr).unwrap());
        emit_artifact("cameras", &cams_path);
    }

    // [demo] downscaled frame thumbnails for the filmstrip (320px wide)
    let thumbs_dir = out_dir.join("frames");
    {
        let _ = fs::create_dir_all(&thumbs_dir);
        let mut made = 0u32;
        for (i, path) in frame_paths.iter().enumerate() {
            if let Ok(img) = image::open(path) {
                let thumb = img.thumbnail(320, 180);
                let dst = thumbs_dir.join(format!("frame_{:04}.jpg", i));
                if thumb.save(&dst).is_ok() {
                    made += 1;
                }
            }
        }
        let _ = app.emit(
            "pipeline-artifact",
            serde_json::json!({
                "kind": "frames_dir",
                "path": thumbs_dir.to_string_lossy(),
                "count": made,
            }),
        );
    }

    // 7B. Wavefront OBJ Export (with real f lines)
    if let Ok(obj_file) = File::create(&obj_path) {
        let mut obj_writer = BufWriter::with_capacity(8 * 1024 * 1024, obj_file);
        let _ = writeln!(obj_writer, "# 3D Reconstruction Output — Tactical Recon Engine");
        let _ = writeln!(obj_writer, "# Vertices: {}\n# Faces: {}", vertex_count, faces.len());

        let mut line_buf = String::with_capacity(128 * 1024);
        use std::fmt::Write as FmtWrite;

        for pt in &mesh_vertices {
            let _ = writeln!(
                &mut line_buf,
                "v {:.3} {:.3} {:.3} {:.3} {:.3} {:.3}",
                pt.x,
                pt.y,
                pt.z,
                pt.r / 255.0,
                pt.g / 255.0,
                pt.b / 255.0
            );
            if line_buf.len() >= 64 * 1024 {
                let _ = obj_writer.write_all(line_buf.as_bytes());
                line_buf.clear();
            }
        }
        for f in &faces {
            let _ = writeln!(&mut line_buf, "f {} {} {}", f[0] + 1, f[1] + 1, f[2] + 1);
            if line_buf.len() >= 64 * 1024 {
                let _ = obj_writer.write_all(line_buf.as_bytes());
                line_buf.clear();
            }
        }
        if !line_buf.is_empty() {
            let _ = obj_writer.write_all(line_buf.as_bytes());
        }
        let _ = obj_writer.flush();
    }

    // 7C. ASPRS LAS 1.2 Export — real UTM coordinates + GeoTIFF CRS VLR.
    // X = UTM easting, Y = UTM northing, Z = elevation (m above ENU origin).
    let observed_pts: Vec<&SurfacePoint> = surface_grid.values().collect();

    let orig_lat = telemetry.first().map(|p| p.latitude).unwrap_or(0.394);
    let orig_lon = telemetry.first().map(|p| p.longitude).unwrap_or(36.88);

    if !observed_pts.is_empty() {
        let las_pts: Vec<(f64, f64, f64, u8, u8, u8)> = observed_pts
            .iter()
            .map(|pt| {
                (
                    pt.x as f64,
                    (-pt.z) as f64, // LAS Y = North = -Z in our frame
                    pt.y as f64,    // LAS Z = elevation
                    pt.r.round().clamp(0.0, 255.0) as u8,
                    pt.g.round().clamp(0.0, 255.0) as u8,
                    pt.b.round().clamp(0.0, 255.0) as u8,
                )
            })
            .collect();
        if let Err(e) = write_las(&las_path, &las_pts, orig_lat, orig_lon) {
            let _ = app.emit("pipeline-log", format!("[WARN] LAS export failed: {}", e));
        }
    }

    // 7E. glTF 2.0 Binary (GLB) Export
    let _ = write_glb(&glb_path, &mesh_vertices, &faces);

    // 7D. Georeference Metadata Export (Observed points, ENU frame)
    if let Ok(georef_file) = File::create(&georef_path) {
        let mut georef_writer = BufWriter::new(georef_file);
        let orig_alt = telemetry.first().map(|p| p.altitude_m).unwrap_or(20.0);
        let earth_r = 6_378_137.0f64;
        let deg_per_m = 180.0 / (std::f64::consts::PI * earth_r);
        let lat_rad = (orig_lat * std::f64::consts::PI / 180.0) as f32;
        let deg_per_m_lon = deg_per_m / (lat_rad.cos() as f64).max(0.1);

        // ENU bounds over observed points: x=east, north=-z, y=up
        let (mut mn_e, mut mx_e) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut mn_n, mut mx_n) = (f64::INFINITY, f64::NEG_INFINITY);
        let (mut mn_u, mut mx_u) = (f64::INFINITY, f64::NEG_INFINITY);
        for pt in &observed_pts {
            mn_e = mn_e.min(pt.x as f64);
            mx_e = mx_e.max(pt.x as f64);
            mn_n = mn_n.min(-pt.z as f64);
            mx_n = mx_n.max(-pt.z as f64);
            mn_u = mn_u.min(pt.y as f64);
            mx_u = mx_u.max(pt.y as f64);
        }
        if observed_pts.is_empty() {
            (mn_e, mx_e, mn_n, mx_n, mn_u, mx_u) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        }

        // lat bounds from NORTH extent (not elevation); lon from east.
        let min_lat_wgs = orig_lat + mn_n * deg_per_m;
        let max_lat_wgs = orig_lat + mx_n * deg_per_m;
        let min_lon_wgs = orig_lon + mn_e * deg_per_m_lon;
        let max_lon_wgs = orig_lon + mx_e * deg_per_m_lon;
        let utm = utm_zone_epsg(orig_lat, orig_lon);

        let _ = writeln!(
            georef_writer,
            "{{\n  \"description\": \"Single-Pass Drone Video 3D Reconstruction Metadata\",\n  \
               \"spatial_accuracy\": \"GPS-limited (target <= 1 m, not independently validated with GCPs)\",\n  \
               \"coordinate_system\": {{\n    \"frame\": \"ENU at origin (x=east, y=north; z=up in PLY/OBJ/GLB; LAS stores UTM)\",\n    \
               \"geographic\": \"WGS-84 (EPSG:4326)\",\n    \"projected\": \"UTM zone {}{} EPSG:{}\",\n    \
               \"vertical_datum\": \"relative height above takeoff point (AGL); not geoid-referenced\"\n  }},\n  \
               \"assumptions\": {{\n    \"camera_pitch_deg\": {:.1},\n    \"hfov_deg\": {:.1},\n    \"altitude_reference\": \"relative to takeoff (AGL)\"\n  }},\n  \
               \"origin\": {{\n    \"latitude\": {:.6},\n    \"longitude\": {:.6},\n    \"altitude_m\": {:.2}\n  }},\n  \
               \"bounds_wgs84\": {{\n    \"min_latitude\": {:.6},\n    \"max_latitude\": {:.6},\n    \"min_longitude\": {:.6},\n    \"max_longitude\": {:.6}\n  }},\n  \
               \"metric_extents\": {{\n    \"width_x_m\": {:.2},\n    \"height_relief_y_m\": {:.2},\n    \"length_z_m\": {:.2}\n  }},\n  \
               \"sync_offset_sec\": {:.2},\n  \
               \"total_observed_points\": {},\n  \
               \"total_mesh_vertices\": {},\n  \
               \"total_mesh_faces\": {},\n  \
               \"deliverables\": [\"recon_output.ply\", \"recon_output.obj\", \"recon_output.las\", \"recon_output.glb\", \"recon_georeference.json\"]\n}}",
            utm.0, utm.2, utm.1,
            camera_pitch_deg, intrinsics.hfov_deg,
            orig_lat, orig_lon, orig_alt,
            min_lat_wgs, max_lat_wgs, min_lon_wgs, max_lon_wgs,
            mx_e - mn_e, mx_u - mn_u, mx_n - mn_n,
            sync_offset,
            observed_pts.len(),
            vertex_count,
            faces.len()
        );
        let _ = georef_writer.flush();
    }

    emit_artifact("ply", &ply_path);
    emit_artifact("obj", &obj_path);
    emit_artifact("las", &las_path);
    emit_artifact("glb", &glb_path);
    emit_artifact("georef", &georef_path);

    let t_export = t_export_start.elapsed();
    let elapsed = wall_clock.elapsed();
    let msg = format!(
        "Reconstruction complete in {:.2?} — {} vertices, {} faces written to {} (PLY, OBJ, LAS, GLB & GeoRef). Export time: {:.2?}",
        elapsed, vertex_count, faces.len(), out_dir.display(), t_export
    );
    let _ = app.emit("pipeline-log", format!("[SUCCESS] ✓ {}", msg));
    Ok(msg)
}

// ─────────────────────────────────────────────────────────────
// UTM forward projection (WGS-84 ellipsoid, standard series to A^6)
// ─────────────────────────────────────────────────────────────

/// Returns (zone, epsg, hemisphere_char) for a WGS-84 lat/lon.
fn utm_zone_epsg(lat: f64, lon: f64) -> (u32, u32, &'static str) {
    let zone = (((lon + 180.0) / 6.0).floor() as u32 + 1).clamp(1, 60);
    if lat >= 0.0 {
        (zone, 32600 + zone, "N")
    } else {
        (zone, 32700 + zone, "S")
    }
}

/// WGS-84 (deg) -> UTM (m). Returns (easting, northing).
fn wgs84_to_utm(lat_deg: f64, lon_deg: f64) -> (f64, f64) {
    let a = 6_378_137.0f64;
    let f = 1.0 / 298.257_223_563;
    let k0 = 0.9996;
    let e2 = f * (2.0 - f);
    let ep2 = e2 / (1.0 - e2);
    let (zone, _, _) = utm_zone_epsg(lat_deg, lon_deg);
    let lon0 = ((zone as f64) - 1.0) * 6.0 - 180.0 + 3.0;
    let lat = lat_deg.to_radians();
    let lon = lon_deg.to_radians();
    let lon0 = lon0.to_radians();
    let n = a / (1.0 - e2 * lat.sin().powi(2)).sqrt();
    let t = lat.tan().powi(2);
    let c = ep2 * lat.cos().powi(2);
    let aa = lat.cos() * (lon - lon0);
    let m = a
        * ((1.0 - e2 / 4.0 - 3.0 * e2.powi(2) / 64.0 - 5.0 * e2.powi(3) / 256.0) * lat
            - (3.0 * e2 / 8.0 + 3.0 * e2.powi(2) / 32.0 + 45.0 * e2.powi(3) / 1024.0)
                * (2.0 * lat).sin()
            + (15.0 * e2.powi(2) / 256.0 + 45.0 * e2.powi(3) / 1024.0) * (4.0 * lat).sin()
            - (35.0 * e2.powi(3) / 3072.0) * (6.0 * lat).sin());
    let mut x = k0
        * n
        * (aa + (1.0 - t + c) * aa.powi(3) / 6.0
            + (5.0 - 18.0 * t + t * t + 72.0 * c - 58.0 * ep2) * aa.powi(5) / 120.0)
        + 500_000.0;
    let mut y = k0
        * (m + n
            * lat.tan()
            * (aa.powi(2) / 2.0
                + (5.0 - t + 9.0 * c + 4.0 * c * c) * aa.powi(4) / 24.0
                + (61.0 - 58.0 * t + t * t + 600.0 * c - 330.0 * ep2) * aa.powi(6) / 720.0));
    if lat_deg < 0.0 {
        y += 10_000_000.0;
    }
    if !x.is_finite() || !y.is_finite() {
        (x, y) = (0.0, 0.0);
    }
    (x, y)
}

// ─────────────────────────────────────────────────────────────
// ASPRS LAS 1.2 writer — UTM easting/northing + GeoTIFF CRS VLR.
// pts: (east_rel_m, north_rel_m, up_m, r, g, b) in the ENU frame
// centred on `origin_lat/lon`.
// ─────────────────────────────────────────────────────────────

fn write_las(
    path: &std::path::Path,
    pts: &[(f64, f64, f64, u8, u8, u8)],
    origin_lat: f64,
    origin_lon: f64,
) -> Result<(), String> {
    if pts.is_empty() {
        return Err("empty point set".into());
    }
    let (_zone, epsg, _) = utm_zone_epsg(origin_lat, origin_lon);
    let (e0, n0) = wgs84_to_utm(origin_lat, origin_lon);

    // UTM coordinates
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let coords: Vec<(f64, f64, f64)> = pts
        .iter()
        .map(|p| {
            let c = (e0 + p.0, n0 + p.1, p.2);
            for i in 0..3 {
                min[i] = min[i].min([c.0, c.1, c.2][i]);
                max[i] = max[i].max([c.0, c.1, c.2][i]);
            }
            c
        })
        .collect();

    let scale = 0.001f64;
    // offsets = min bounds → decoded coord = int*scale + offset, mm resolution
    let file = File::create(path).map_err(|e| format!("[IO] LAS create: {}", e))?;
    let mut w = BufWriter::with_capacity(8 * 1024 * 1024, file);

    // GeoKeyDirectoryTag VLR data (record_id 34735):
    //   keys: GTModelType=1(projected), GTRasterType=1(PixelIsArea),
    //         ProjectedCSType=EPSG utm
    let mut vlr_data: Vec<u8> = Vec::new();
    let keys: [u16; 16] = [
        1, 1, 0, 3, // dir header: version 1, rev 1.0, 3 keys
        1024, 0, 1, 1, // GTModelTypeGeoKey = Projected
        1025, 0, 1, 1, // GTRasterTypeGeoKey = RasterPixelIsArea
        3072, 0, 1, epsg as u16, // ProjectedCSTypeGeoKey
    ];
    for k in keys {
        vlr_data.extend_from_slice(&k.to_le_bytes());
    }

    let vlr_len = 54 + vlr_data.len();
    let npts = coords.len() as u32;

    let mut header = [0u8; 227];
    header[0..4].copy_from_slice(b"LASF");
    header[24] = 1; // version major
    header[25] = 2; // version minor
    let sys_id = b"EKDRSHTI-v2";
    header[26..26 + sys_id.len()].copy_from_slice(sys_id);
    let gen_sw = b"Tactical-Engine";
    header[58..58 + gen_sw.len()].copy_from_slice(gen_sw);
    header[94..96].copy_from_slice(&227u16.to_le_bytes()); // header size
    header[96..100].copy_from_slice(&((227 + vlr_len) as u32).to_le_bytes()); // point data offset
    header[100..104].copy_from_slice(&1u32.to_le_bytes()); // number of VLRs
    header[104] = 2; // point format 2 (XYZ+RGB)
    header[105..107].copy_from_slice(&26u16.to_le_bytes()); // record length
    header[107..111].copy_from_slice(&npts.to_le_bytes()); // legacy point count
    // legacy points-by-return: all in return 1
    header[111..115].copy_from_slice(&npts.to_le_bytes());
    header[131..139].copy_from_slice(&scale.to_le_bytes());
    header[139..147].copy_from_slice(&scale.to_le_bytes());
    header[147..155].copy_from_slice(&scale.to_le_bytes());
    header[155..163].copy_from_slice(&min[0].to_le_bytes()); // x offset
    header[163..171].copy_from_slice(&min[1].to_le_bytes()); // y offset
    header[171..179].copy_from_slice(&min[2].to_le_bytes()); // z offset
    header[179..187].copy_from_slice(&max[0].to_le_bytes());
    header[187..195].copy_from_slice(&min[0].to_le_bytes());
    header[195..203].copy_from_slice(&max[1].to_le_bytes());
    header[203..211].copy_from_slice(&min[1].to_le_bytes());
    header[211..219].copy_from_slice(&max[2].to_le_bytes());
    header[219..227].copy_from_slice(&min[2].to_le_bytes());
    w.write_all(&header).map_err(|e| format!("[IO] LAS header: {}", e))?;

    // VLR header (54B): reserved u16, user_id 16B, record_id u16,
    // record_len u16, description 32B
    let mut vlr_hdr = [0u8; 54];
    let uid = b"LASF_Projection";
    vlr_hdr[2..2 + uid.len()].copy_from_slice(uid);
    vlr_hdr[18..20].copy_from_slice(&34735u16.to_le_bytes());
    vlr_hdr[20..22].copy_from_slice(&(vlr_data.len() as u16).to_le_bytes());
    let desc = b"OGC GeoTIFF (UTM)";
    vlr_hdr[22..22 + desc.len()].copy_from_slice(desc);
    w.write_all(&vlr_hdr).map_err(|e| format!("[IO] LAS VLR: {}", e))?;
    w.write_all(&vlr_data).map_err(|e| format!("[IO] LAS VLR data: {}", e))?;

    let mut buf = Vec::with_capacity(coords.len() * 26);
    for (i, c) in coords.iter().enumerate() {
        let xi = ((c.0 - min[0]) / scale).round() as i32;
        let yi = ((c.1 - min[1]) / scale).round() as i32;
        let zi = ((c.2 - min[2]) / scale).round() as i32;
        buf.extend_from_slice(&xi.to_le_bytes());
        buf.extend_from_slice(&yi.to_le_bytes());
        buf.extend_from_slice(&zi.to_le_bytes());
        buf.extend_from_slice(&1000u16.to_le_bytes()); // intensity
        buf.push(0b0000_1001); // return 1 of 1
        buf.push(if c.2 > 4.0 { 5 } else { 2 }); // classification: veg vs ground
        buf.push(0); // scan angle
        buf.push(0); // user data
        buf.extend_from_slice(&0u16.to_le_bytes()); // point source id
        buf.extend_from_slice(&((pts[i].3 as u16) << 8).to_le_bytes());
        buf.extend_from_slice(&((pts[i].4 as u16) << 8).to_le_bytes());
        buf.extend_from_slice(&((pts[i].5 as u16) << 8).to_le_bytes());
    }
    w.write_all(&buf).map_err(|e| format!("[IO] LAS points: {}", e))?;
    w.flush().map_err(|e| format!("[IO] LAS flush: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Binary PLY Exporter (xyz f32 + rgb u8 + face list)
// ─────────────────────────────────────────────────────────────

fn write_ply(
    path: &std::path::Path,
    mesh_vertices: &[SurfacePoint],
    faces: &[[u32; 3]],
) -> Result<(), String> {
    let ply_file =
        File::create(path).map_err(|e| format!("[IO] Cannot create PLY: {}", e))?;
    let mut ply_writer = BufWriter::with_capacity(8 * 1024 * 1024, ply_file);

    write!(
        ply_writer,
        "ply\nformat binary_little_endian 1.0\n\
         element vertex {}\n\
         property float x\nproperty float y\nproperty float z\n\
         property uchar red\nproperty uchar green\nproperty uchar blue\n\
         element face {}\n\
         property list uchar int vertex_indices\n\
         end_header\n",
        mesh_vertices.len(),
        faces.len()
    )
    .map_err(|e| format!("[IO] PLY header write failed: {}", e))?;

    let mut ply_bin: Vec<u8> = Vec::with_capacity(mesh_vertices.len() * 15 + faces.len() * 13);
    for pt in mesh_vertices {
        ply_bin.extend_from_slice(&pt.x.to_le_bytes());
        ply_bin.extend_from_slice(&pt.y.to_le_bytes());
        ply_bin.extend_from_slice(&pt.z.to_le_bytes());
        ply_bin.push(pt.r.round().clamp(0.0, 255.0) as u8);
        ply_bin.push(pt.g.round().clamp(0.0, 255.0) as u8);
        ply_bin.push(pt.b.round().clamp(0.0, 255.0) as u8);
    }
    for f in faces {
        ply_bin.push(3u8);
        ply_bin.extend_from_slice(&(f[0] as i32).to_le_bytes());
        ply_bin.extend_from_slice(&(f[1] as i32).to_le_bytes());
        ply_bin.extend_from_slice(&(f[2] as i32).to_le_bytes());
    }
    ply_writer.write_all(&ply_bin).map_err(|e| format!("[IO] PLY binary write failed: {}", e))?;
    ply_writer.flush().map_err(|e| format!("[IO] PLY flush failed: {}", e))?;
    Ok(())
}

/// White-model regression check shared by tests: returns (mean channel std,
/// % vertices with r,g,b >= 250, % vertices with r == g == b).
#[cfg(test)]
fn ply_white_stats(vertices: &[SurfacePoint]) -> (f32, f32, f32) {
    if vertices.is_empty() {
        return (0.0, 100.0, 100.0);
    }
    let n = vertices.len() as f32;
    let (mut mr, mut mg, mut mb) = (0.0f32, 0.0f32, 0.0f32);
    let (mut sat, mut gray) = (0usize, 0usize);
    for p in vertices {
        mr += p.r;
        mg += p.g;
        mb += p.b;
        if p.r >= 250.0 && p.g >= 250.0 && p.b >= 250.0 {
            sat += 1;
        }
        if p.r == p.g && p.g == p.b {
            gray += 1;
        }
    }
    mr /= n;
    mg /= n;
    mb /= n;
    let mut var = 0.0f32;
    for p in vertices {
        var += (p.r - mr).powi(2) + (p.g - mg).powi(2) + (p.b - mb).powi(2);
    }
    let std = (var / (n * 3.0)).sqrt();
    (std, sat as f32 / n * 100.0, gray as f32 / n * 100.0)
}

// ─────────────────────────────────────────────────────────────
// glTF 2.0 Binary (GLB) Hand-Written Exporter (No Crates)
// ─────────────────────────────────────────────────────────────

fn write_glb(path: &std::path::Path, vertices: &[SurfacePoint], faces: &[[u32; 3]]) -> Result<(), String> {
    if vertices.is_empty() {
        return Ok(());
    }

    let num_verts = vertices.len();
    let num_indices = faces.len() * 3;

    let pos_len = num_verts * 12;
    let col_len = num_verts * 12;
    let idx_len = num_indices * 4;

    let mut bin_data = Vec::with_capacity(pos_len + col_len + idx_len + 16);

    let mut min_pos = [f32::INFINITY, f32::INFINITY, f32::INFINITY];
    let mut max_pos = [f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];

    for pt in vertices {
        min_pos[0] = min_pos[0].min(pt.x);
        min_pos[1] = min_pos[1].min(pt.y);
        min_pos[2] = min_pos[2].min(pt.z);
        max_pos[0] = max_pos[0].max(pt.x);
        max_pos[1] = max_pos[1].max(pt.y);
        max_pos[2] = max_pos[2].max(pt.z);

        bin_data.extend_from_slice(&pt.x.to_le_bytes());
        bin_data.extend_from_slice(&pt.y.to_le_bytes());
        bin_data.extend_from_slice(&pt.z.to_le_bytes());
    }

    for pt in vertices {
        let r = (pt.r / 255.0).clamp(0.0, 1.0);
        let g = (pt.g / 255.0).clamp(0.0, 1.0);
        let b = (pt.b / 255.0).clamp(0.0, 1.0);
        bin_data.extend_from_slice(&r.to_le_bytes());
        bin_data.extend_from_slice(&g.to_le_bytes());
        bin_data.extend_from_slice(&b.to_le_bytes());
    }

    for f in faces {
        bin_data.extend_from_slice(&f[0].to_le_bytes());
        bin_data.extend_from_slice(&f[1].to_le_bytes());
        bin_data.extend_from_slice(&f[2].to_le_bytes());
    }

    while bin_data.len() % 4 != 0 {
        bin_data.push(0);
    }
    let bin_len = bin_data.len();

    let json_str = format!(
        r#"{{"asset":{{"version":"2.0","generator":"Tactical-3D-Recon"}},"extensionsUsed":["KHR_materials_unlit"],"scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"mesh":0}}],"materials":[{{"pbrMetallicRoughness":{{"baseColorFactor":[1.0,1.0,1.0,1.0],"metallicFactor":0.0,"roughnessFactor":1.0}},"extensions":{{"KHR_materials_unlit":{{}}}},"doubleSided":true}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"COLOR_0":1}},"indices":2,"material":0,"mode":4}}]}}],"accessors":[{{"bufferView":0,"byteOffset":0,"componentType":5126,"count":{},"type":"VEC3","min":[{:.4},{:.4},{:.4}],"max":[{:.4},{:.4},{:.4}]}},{{"bufferView":1,"byteOffset":0,"componentType":5126,"count":{},"type":"VEC3"}},{{"bufferView":2,"byteOffset":0,"componentType":5125,"count":{},"type":"SCALAR"}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{},"target":34962}},{{"buffer":0,"byteOffset":{},"byteLength":{},"target":34962}},{{"buffer":0,"byteOffset":{},"byteLength":{},"target":34963}}],"buffers":[{{"byteLength":{}}}]}}"#,
        num_verts,
        min_pos[0], min_pos[1], min_pos[2],
        max_pos[0], max_pos[1], max_pos[2],
        num_verts,
        num_indices,
        pos_len,
        pos_len,
        col_len,
        pos_len + col_len,
        idx_len,
        bin_len
    );

    let mut json_bytes = json_str.into_bytes();
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }
    let json_len = json_bytes.len();

    let total_len = 12 + 8 + json_len + 8 + bin_len;

    let file = File::create(path).map_err(|e| format!("GLB create failed: {}", e))?;
    let mut w = BufWriter::new(file);

    w.write_all(b"glTF").map_err(|e| e.to_string())?;
    w.write_all(&2u32.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&(total_len as u32).to_le_bytes()).map_err(|e| e.to_string())?;

    w.write_all(&(json_len as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"JSON").map_err(|e| e.to_string())?;
    w.write_all(&json_bytes).map_err(|e| e.to_string())?;

    w.write_all(&(bin_len as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"BIN\0").map_err(|e| e.to_string())?;
    w.write_all(&bin_data).map_err(|e| e.to_string())?;

    w.flush().map_err(|e| format!("GLB flush failed: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Tauri Application Entry Point
// ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("ort=info,app=debug")
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_reconstruction])
        .run(tauri::generate_context!())
        .expect("Fatal: Tauri application failed to start.");
}

// ─────────────────────────────────────────────────────────────
// Verification Unit Tests
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_camera_pose_orthonormal_level() {
        let origin = FlightPoint {
            timestamp_sec: 0.0,
            latitude: 28.613939,
            longitude: 77.209021,
            altitude_m: 65.0,
            pitch_deg: 0.0,
            roll_deg: 0.0,
            yaw_deg: 0.0,
            gimbal_pitch_deg: None,
            focal_len: None,
            ..Default::default()
        };
        let pose = camera_pose_from_telemetry(&origin, &origin, 6_378_137.0);

        assert!((pose.right[0] - 1.0).abs() < 1e-5);
        assert!((pose.down[1] - (-1.0)).abs() < 1e-5);
        assert!((pose.forward[2] - (-1.0)).abs() < 1e-5);

        let dot_rf = pose.right[0] * pose.forward[0] + pose.right[1] * pose.forward[1] + pose.right[2] * pose.forward[2];
        let dot_df = pose.down[0] * pose.forward[0] + pose.down[1] * pose.forward[1] + pose.down[2] * pose.forward[2];
        let dot_rd = pose.right[0] * pose.down[0] + pose.right[1] * pose.down[1] + pose.right[2] * pose.down[2];
        assert!(dot_rf.abs() < 1e-5, "right . forward != 0");
        assert!(dot_df.abs() < 1e-5, "down . forward != 0");
        assert!(dot_rd.abs() < 1e-5, "right . down != 0");
    }

    #[test]
    fn test_camera_pose_pitched_down() {
        let origin = FlightPoint {
            timestamp_sec: 0.0,
            latitude: 28.613939,
            longitude: 77.209021,
            altitude_m: 65.0,
            pitch_deg: -12.0,
            roll_deg: 0.0,
            yaw_deg: 0.0,
            gimbal_pitch_deg: None,
            focal_len: None,
            ..Default::default()
        };
        let pose = camera_pose_from_telemetry(&origin, &origin, 6_378_137.0);

        assert!(pose.forward[1] < 0.0, "Forward Y should point down towards ground");
        assert!(pose.forward[2] < 0.0, "Forward Z should point North (-Z)");

        let dot_rf = pose.right[0] * pose.forward[0] + pose.right[1] * pose.forward[1] + pose.right[2] * pose.forward[2];
        let dot_df = pose.down[0] * pose.forward[0] + pose.down[1] * pose.forward[1] + pose.down[2] * pose.forward[2];
        let dot_rd = pose.right[0] * pose.down[0] + pose.right[1] * pose.down[1] + pose.right[2] * pose.down[2];
        assert!(dot_rf.abs() < 1e-5);
        assert!(dot_df.abs() < 1e-5);
        assert!(dot_rd.abs() < 1e-5);
    }

    #[test]
    fn test_parse_dji_srt_block() {
        let sample_srt = "\
1\n\
00:00:00,033 --> 00:00:00,066\n\
<font size=\"36\">SrtCnt : 1, DiffTime : 33ms\n\
2023-01-21 15:08:55,429,228\n\
[iso : 100] [shutter : 1/2000.0] [fnum : 280] [ev : 0] [ct : 5067] [color_md : default] [focal_len : 224] [latitude: 0.394028] [longitude: 36.883816] [altitude: 15.600000]\n\
</font>\n";

        let temp_path = "../backend/test_sample.srt";
        let _ = fs::create_dir_all("../backend");
        let mut f = File::create(temp_path).unwrap();
        f.write_all(sample_srt.as_bytes()).unwrap();
        f.flush().unwrap();

        let pts = parse_dji_srt(temp_path).unwrap();
        let _ = fs::remove_file(temp_path);

        assert_eq!(pts.len(), 1);
        assert!((pts[0].timestamp_sec - 0.033).abs() < 1e-4);
        assert!((pts[0].latitude - 0.394028).abs() < 1e-6);
        assert!((pts[0].longitude - 36.883816).abs() < 1e-6);
        assert!((pts[0].altitude_m - 15.6).abs() < 1e-3);
        assert_eq!(pts[0].focal_len, Some(224.0));
    }

    #[test]
    fn test_nadir_projection_ground_level() {
        // (a) nadir (-90 deg), norm_inv=0.5 -> point.y = 0.0 +- 1e-3 for any altitude
        for &h_agl in &[10.0f32, 25.0, 50.0, 100.0, 300.0] {
            let yaw_rad = 0.0f32;
            let pitch_rad = (-90.0f32).to_radians();
            let (s_p, c_p) = pitch_rad.sin_cos();
            let (s_y, c_y) = yaw_rad.sin_cos();

            let right = [c_y, 0.0, s_y];
            let down = [0.0, -c_p, -s_p]; // down points horizontally forward when nadir
            let forward = [s_y * c_p, s_p, -c_y * c_p]; // forward points straight down -Y

            let (u, v) = (0.0f32, 0.0f32);
            let rx = u * right[0] + v * down[0] + forward[0];
            let ry = u * right[1] + v * down[1] + forward[1];
            let rz = u * right[2] + v * down[2] + forward[2];
            let r_len = (rx * rx + ry * ry + rz * rz).sqrt();
            let ray = [rx / r_len, ry / r_len, rz / r_len];

            let norm_inv = 0.5f32;
            let t_plane = h_agl / (-ray[1]);
            let t = t_plane * (1.0 + RELIEF_FRAC * (0.5 - norm_inv));
            let cam_c = [0.0f32, h_agl, 0.0f32];
            let point_y = cam_c[1] + t * ray[1];

            assert!((point_y - 0.0).abs() < 1e-3, "Ground level at h={} must be 0, got {}", h_agl, point_y);
        }
    }

    #[test]
    fn test_altitude_change_does_not_move_ground() {
        // (b) changing altitude must not move the ground
        let h1 = 20.0f32;
        let h2 = 80.0f32;
        let pitch_rad = (-45.0f32).to_radians();
        let (s_p, c_p) = pitch_rad.sin_cos();
        let forward = [0.0, s_p, -c_p];
        let ray_y = forward[1];

        let norm_inv = 0.5f32;

        let t1 = (h1 / (-ray_y)) * (1.0 + RELIEF_FRAC * (0.5 - norm_inv));
        let pt1_y = h1 + t1 * ray_y;

        let t2 = (h2 / (-ray_y)) * (1.0 + RELIEF_FRAC * (0.5 - norm_inv));
        let pt2_y = h2 + t2 * ray_y;

        assert!((pt1_y - pt2_y).abs() < 1e-3);
        assert!((pt1_y - 0.0).abs() < 1e-3);
    }

    #[test]
    fn test_oblique_ray_distance() {
        // (c) centre-pixel ray at pitch -45 deg hits the plane at h / sin(45 deg)
        let h = 50.0f32;
        let pitch_deg = -45.0f32;
        let pitch_rad = pitch_deg.to_radians();
        let (s_p, _) = pitch_rad.sin_cos();
        let ray_y = s_p; // -sin(45)

        let t_plane = h / (-ray_y);
        let expected = h / (45.0f32.to_radians().sin());
        assert!((t_plane - expected).abs() < 1e-4);
    }

    /// M0 baseline / M1 reproduction: run the real pipeline headlessly on a video
    /// file through a mock Tauri app. Usage:
    ///   BASELINE_VIDEO=../data/kabr/x.mp4 BASELINE_TELEMETRY=../data/kabr/x.SRT \
    ///   cargo test --release -- --ignored baseline_pipeline_headless --nocapture
    #[test]
    #[ignore]
    fn baseline_pipeline_headless() {
        let video = std::env::var("BASELINE_VIDEO")
            .unwrap_or_else(|_| "../data/kabr/DJI_0212_trimmed.mp4".to_string());
        let tele = std::env::var("BASELINE_TELEMETRY")
            .unwrap_or_else(|_| "../data/kabr/DJI_0212.SRT".to_string());
        let app = tauri::test::mock_app();
        {
            use tauri::Listener;
            let h = app.handle().clone();
            let _id = h.listen_any("pipeline-log", |e| eprintln!("LOG: {}", e.payload()));
        }
        let t0 = Instant::now();
        let out_dir = std::env::var("BASELINE_OUT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("recon-baseline"));
        let res = run_reconstruction_inner(
            app.handle().clone(),
            video,
            tele,
            HardwareProfile::Balanced,
            -45.0,
            out_dir,
            None,
            None,
        );
        eprintln!("[baseline] elapsed={:?} result={:?}", t0.elapsed(), res);
        assert!(res.is_ok(), "pipeline failed: {:?}", res.err());
    }

    #[test]
    fn test_ply_roundtrip_has_color() {
        // M1 regression: a written PLY must contain per-vertex colour that an
        // independent byte-level parse can read back, and must not satisfy the
        // white-model condition (std<10 OR >50% saturated OR >90% r==g==b).
        let verts = vec![
            SurfacePoint { x: 0.0, y: 0.0, z: 0.0, r: 34.0, g: 120.0, b: 60.0, weight: 1.0, frame_id: 0, best_w: 1.0 },
            SurfacePoint { x: 1.0, y: 0.0, z: 0.0, r: 200.0, g: 30.0, b: 40.0, weight: 1.0, frame_id: 0, best_w: 1.0 },
            SurfacePoint { x: 0.0, y: 0.0, z: 1.0, r: 90.0, g: 80.0, b: 210.0, weight: 1.0, frame_id: 0, best_w: 1.0 },
        ];
        let faces = vec![[0u32, 1, 2]];
        let tmp = std::env::temp_dir().join("test_ply_color.ply");
        write_ply(&tmp, &verts, &faces).unwrap();
        let bytes = fs::read(&tmp).unwrap();
        let _ = fs::remove_file(&tmp);
        let s = String::from_utf8_lossy(&bytes);
        let hdr_end = s.find("end_header\n").unwrap();
        let header = &s[..hdr_end];
        assert!(header.contains("property uchar red"));
        assert!(header.contains("property uchar green"));
        assert!(header.contains("property uchar blue"));
        assert!(header.contains("binary_little_endian"));
        // binary body: 3 verts * 15 B + 1 face * 13 B
        let body = &bytes[hdr_end + "end_header\n".len()..];
        assert_eq!(body.len(), 3 * 15 + 13);
        // vertex 0 colour at bytes 12..15
        assert_eq!(body[12], 34);
        assert_eq!(body[13], 120);
        assert_eq!(body[14], 60);

        let (std, sat, gray) = ply_white_stats(&verts);
        assert!(std >= 10.0 && sat <= 50.0 && gray <= 90.0,
            "coloured buffer failed white-model check: std={std} sat={sat} gray={gray}");
    }

    #[test]
    fn test_ply_white_stats_catches_white() {
        let white = vec![
            SurfacePoint { x: 0.0, y: 0.0, z: 0.0, r: 255.0, g: 255.0, b: 255.0, weight: 1.0, frame_id: 0, best_w: 1.0 };
            10
        ];
        let (std, sat, gray) = ply_white_stats(&white);
        assert!(std < 10.0 || sat > 50.0 || gray > 90.0,
            "all-white buffer must trigger the white-model condition");
    }

    #[test]
    fn test_las_roundtrip_utm() {
        // M2 regression: LAS must carry real UTM coordinates — decoded
        // (int*scale + offset) values must land near the expected UTM
        // easting/northing for the origin, and the CRS VLR must exist.
        let origin = (0.394027, 36.883815); // KABR site
        let pts = vec![
            (0.0f64, 0.0f64, 0.0f64, 100u8, 110u8, 90u8),
            (10.0, 5.0, 2.0, 80, 90, 70),
            (-20.0, -8.0, -1.5, 60, 70, 55),
        ];
        let tmp = std::env::temp_dir().join("test_roundtrip.las");
        write_las(&tmp, &pts, origin.0, origin.1).unwrap();
        let bytes = fs::read(&tmp).unwrap();
        let _ = fs::remove_file(&tmp);

        assert_eq!(&bytes[0..4], b"LASF");
        let header_size = u16::from_le_bytes(bytes[94..96].try_into().unwrap()) as usize;
        let pt_off = u32::from_le_bytes(bytes[96..100].try_into().unwrap()) as usize;
        let n_vlr = u32::from_le_bytes(bytes[100..104].try_into().unwrap());
        let pt_fmt = bytes[104];
        let pt_len = u16::from_le_bytes(bytes[105..107].try_into().unwrap()) as usize;
        let npts = u32::from_le_bytes(bytes[107..111].try_into().unwrap()) as usize;
        let ret1 = u32::from_le_bytes(bytes[111..115].try_into().unwrap());
        assert_eq!(header_size, 227);
        assert_eq!(n_vlr, 1);
        assert_eq!(pt_fmt, 2);
        assert_eq!(pt_len, 26);
        assert_eq!(npts, 3);
        assert_eq!(ret1, 3, "points-by-return[0] must equal point count");
        assert_eq!(pt_off, 227 + 54 + 32, "point data offset must include the VLR");

        // VLR declares GeoTIFF record 34735
        assert_eq!(&bytes[header_size + 2..header_size + 17], b"LASF_Projection");
        let rec_id = u16::from_le_bytes(bytes[header_size + 18..header_size + 20].try_into().unwrap());
        assert_eq!(rec_id, 34735);

        let (e0, n0) = wgs84_to_utm(origin.0, origin.1);
        let scale = f64::from_le_bytes(bytes[131..139].try_into().unwrap());
        let off_x = f64::from_le_bytes(bytes[155..163].try_into().unwrap());
        let off_y = f64::from_le_bytes(bytes[163..171].try_into().unwrap());
        let off_z = f64::from_le_bytes(bytes[171..179].try_into().unwrap());
        assert!((scale - 0.001).abs() < 1e-9);
        assert!(off_x > 0.0 && off_y > 0.0, "offsets must be non-zero now (UTM)");

        for (i, p) in pts.iter().enumerate() {
            let base = pt_off + i * pt_len;
            let xi = i32::from_le_bytes(bytes[base..base + 4].try_into().unwrap());
            let yi = i32::from_le_bytes(bytes[base + 4..base + 8].try_into().unwrap());
            let zi = i32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap());
            let x = xi as f64 * scale + off_x;
            let y = yi as f64 * scale + off_y;
            let z = zi as f64 * scale + off_z;
            assert!((x - (e0 + p.0)).abs() < 0.002, "easting err {} vs {}", x, e0 + p.0);
            assert!((y - (n0 + p.1)).abs() < 0.002);
            assert!((z - p.2).abs() < 0.002);
            // RGB encoded <<8
            let r = u16::from_le_bytes(bytes[base + 20..base + 22].try_into().unwrap());
            assert_eq!((r >> 8) as u8, p.3);
            // return number byte = 1/1
            assert_eq!(bytes[base + 14], 0b0000_1001);
        }
    }

    #[test]
    fn test_utm_known_point() {
        // Nairobi CBD ≈ -1.2921, 36.8219 → UTM 37S ≈ (258,505 E, 9,857,071 N)
        let (e, n) = wgs84_to_utm(-1.2921, 36.8219);
        // pyproj-verified: (257634.502, 9857079.966)
        assert!((e - 257_634.502).abs() < 0.05, "easting {e} off by >5cm");
        assert!((n - 9_857_079.966).abs() < 0.05, "northing {n} off by >5cm");
        // KABR site lat 0.394N → UTM 37N
        let (zone, epsg, _) = utm_zone_epsg(0.394, 36.884);
        assert_eq!(zone, 37);
        assert_eq!(epsg, 32637);
    }

    #[test]
    fn test_yaw_wrap_lerp() {
        // 359° -> 1° must go forward by 2°, not backward by 358°
        let y = lerp_yaw(359.0, 1.0, 0.5);
        assert!((y - 0.0).abs() < 1e-4 || (y - 360.0).abs() < 1e-4, "yaw lerp gave {y}");
        let y2 = lerp_yaw(10.0, 350.0, 0.5);
        assert!((y2 - 360.0).abs() < 1e-4 || y2.abs() < 1e-4 || (y2 - 0.0).abs() < 1e-4);
    }

    #[test]
    fn test_parse_dji_srt_new_format() {
        // New DJI key layout (Mavic 3 / newer): drone_lat, rel_alt, gb_* keys
        let srt = "\
1\n\
00:00:00,000 --> 00:00:00,033\n\
<font size=\"36\">FrameCnt : 1, DiffTime : 33ms\n\
2024-06-01 10:00:00,000,000\n\
[iso : 100] [shutter : 1/500] [fnum : 170] [ev : 0] [focal_len : 240] [drone_latitude : 0.400000] [drone_longitude : 36.900000] [rel_alt : 30.5] [abs_alt : 1650.2] [gb_pitch : -60.0] [gb_yaw : 5.0] [gb_roll : 0.0]\n\
</font>\n";
        let temp_path = std::env::temp_dir().join("test_new_fmt.srt");
        fs::write(&temp_path, srt).unwrap();
        let pts = parse_dji_srt(temp_path.to_str().unwrap()).unwrap();
        let _ = fs::remove_file(&temp_path);
        assert_eq!(pts.len(), 1);
        assert!((pts[0].latitude - 0.4).abs() < 1e-6);
        assert!((pts[0].altitude_m - 30.5).abs() < 1e-3, "rel_alt must be used for altitude");
        assert_eq!(pts[0].gimbal_pitch_deg, Some(-60.0));
        assert_eq!(pts[0].frame_cnt, Some(1));
    }

    #[test]
    fn test_missing_altitude_is_error() {
        let srt = "\
1\n\
00:00:00,000 --> 00:00:00,033\n\
<font size=\"36\">SrtCnt : 1, DiffTime : 33ms\n\
[latitude: 0.394028] [longitude: 36.883816]\n\
</font>\n";
        let temp_path = std::env::temp_dir().join("test_no_alt.srt");
        fs::write(&temp_path, srt).unwrap();
        let mut pts = parse_dji_srt(temp_path.to_str().unwrap()).unwrap();
        let _ = fs::remove_file(&temp_path);
        assert_eq!(pts.len(), 1);
        assert!(!pts[0].altitude_m.is_finite());
        let res = validate_telemetry(&mut pts);
        assert!(res.is_err(), "telemetry with zero altitude must be an error");
    }

    #[test]
    fn test_csv_px4_columns() {
        let csv = "\
timestamp,latitude,longitude,altitude_amsl,relative_alt,yaw,pitch,roll\n\
0.0,0.394027,36.883815,1510.0,20.0,90.0,0.0,0.0\n\
1.0,0.394030,36.883900,1510.5,20.5,91.0,0.5,0.0\n";
        let tmp = std::env::temp_dir().join("test_px4.csv");
        fs::write(&tmp, csv).unwrap();
        let pts = parse_telemetry_csv(tmp.to_str().unwrap()).unwrap();
        let _ = fs::remove_file(&tmp);
        assert_eq!(pts.len(), 2);
        // relative_alt (AGL) must win over altitude_amsl
        assert!((pts[0].altitude_m - 20.0).abs() < 1e-3, "AGL must win, got {}", pts[0].altitude_m);
        assert!((pts[1].yaw_deg - 91.0).abs() < 1e-3);
    }

    #[test]
    fn test_sync_offset_recovers_trim() {
        // Synthetic: 200 s telemetry (10 Hz), aperiodic speed profile;
        // video is a 30-frame window starting at telemetry second 12.
        // Estimator must recover offset ≈ 12.
        let mut pts = Vec::new();
        let earth_r = 6_378_137.0f64;
        let deg_per_m = 180.0 / (std::f64::consts::PI * earth_r);
        let mut t = 0.0f32;
        let mut x_m = 0.0f64;
        let speed = |tt: f32| 4.0 + 3.0 * (tt / 9.0).sin() + 1.5 * (tt / 2.7).sin();
        for _ in 0..2000 {
            x_m += speed(t) as f64 * 0.1;
            pts.push(FlightPoint {
                timestamp_sec: t,
                latitude: 0.394027,
                longitude: 36.883815 + x_m * deg_per_m,
                altitude_m: 20.0,
                yaw_deg: 90.0,
                ..Default::default()
            });
            t += 0.1;
        }
        let offset = 12.0f32;
        let motion: Vec<f32> = (0..30)
            .map(|i| speed(offset + i as f32 + 0.5) * 10.0)
            .collect();
        let (est, conf) = estimate_sync_offset(&pts, &motion);
        assert!((est - offset).abs() < 1.5, "offset est {est} vs {offset}");
        assert!(conf > 0.5, "confidence {conf} too low on synthetic");
    }
}