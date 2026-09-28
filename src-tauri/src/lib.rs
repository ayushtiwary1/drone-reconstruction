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
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_m: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
    pub yaw_deg: f32,
    pub gimbal_pitch_deg: Option<f32>,
    pub focal_len: Option<f32>,
}

fn clean_header(h: &str) -> String {
    h.trim().to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

pub fn parse_dji_srt(srt_path: &str) -> Result<Vec<FlightPoint>, String> {
    let file = File::open(srt_path)
        .map_err(|e| format!("[TELEMETRY] Failed to open SRT '{}': {}", srt_path, e))?;
    let reader = BufReader::new(file);

    let mut points: Vec<FlightPoint> = Vec::new();
    let mut current_time: Option<f32> = None;
    let mut lat: Option<f64> = None;
    let mut lon: Option<f64> = None;
    let mut alt: Option<f32> = None;
    let mut focal: Option<f32> = None;

    for line_res in reader.lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();

        // 1. Timestamp line: "00:00:00,033 --> 00:00:00,066"
        if trimmed.contains(" --> ") {
            if let Some(start_part) = trimmed.split(" --> ").next() {
                let parts: Vec<&str> = start_part.trim().split(':').collect();
                if parts.len() == 3 {
                    let h: f32 = parts[0].parse().unwrap_or(0.0);
                    let m: f32 = parts[1].parse().unwrap_or(0.0);
                    let sec_parts: Vec<&str> = parts[2].split(',').collect();
                    let s: f32 = sec_parts[0].parse().unwrap_or(0.0);
                    let ms: f32 = if sec_parts.len() > 1 {
                        sec_parts[1].parse().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    current_time = Some(h * 3600.0 + m * 60.0 + s + ms / 1000.0);
                }
            }
            continue;
        }

        // 2. Metadata line with bracketed key:value pairs
        if trimmed.contains('[') && trimmed.contains(']') {
            let mut remaining = trimmed;
            while let Some(start) = remaining.find('[') {
                if let Some(end) = remaining[start..].find(']') {
                    let inner = &remaining[start + 1..start + end];
                    if let Some(colon_idx) = inner.find(':') {
                        let key = inner[..colon_idx].trim().to_lowercase();
                        let val = inner[colon_idx + 1..].trim();
                        match key.as_str() {
                            "latitude" => {
                                if let Ok(v) = val.parse::<f64>() {
                                    lat = Some(v);
                                }
                            }
                            "longitude" => {
                                if let Ok(v) = val.parse::<f64>() {
                                    lon = Some(v);
                                }
                            }
                            "altitude" => {
                                if let Ok(v) = val.parse::<f32>() {
                                    alt = Some(v);
                                }
                            }
                            "focal_len" | "focallen" => {
                                if let Ok(v) = val.parse::<f32>() {
                                    focal = Some(v);
                                }
                            }
                            _ => {}
                        }
                    }
                    remaining = &remaining[start + end + 1..];
                } else {
                    break;
                }
            }
        }

        // 3. End of block: emit point if complete
        if (trimmed.contains("</font>") || trimmed.is_empty())
            && current_time.is_some()
            && lat.is_some()
            && lon.is_some()
        {
            points.push(FlightPoint {
                timestamp_sec: current_time.unwrap(),
                latitude: lat.unwrap(),
                longitude: lon.unwrap(),
                altitude_m: alt.unwrap_or(20.0),
                pitch_deg: 0.0,
                roll_deg: 0.0,
                yaw_deg: 0.0,
                gimbal_pitch_deg: None,
                focal_len: focal,
            });
            current_time = None;
            lat = None;
            lon = None;
            alt = None;
            focal = None;
        }
    }

    Ok(points)
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
            && (h.contains("heightagl") || h.contains("relativealt") || h.contains("vpsaltitude"))
        {
            alt_agl_col = Some(i);
        }
        if alt_col.is_none()
            && (h.contains("altitudem")
                || h.contains("altitudemeters")
                || h.contains("altitude")
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
            get_f32(Some(c), 50.0)
        } else {
            get_f32(alt_col, 50.0)
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
        });
    }

    Ok(points)
}

fn parse_telemetry(path: &str) -> Result<Vec<FlightPoint>, String> {
    if path.trim().is_empty() {
        return Ok(Vec::new());
    }
    if path.to_lowercase().ends_with(".srt") {
        let mut pts = parse_dji_srt(path)?;
        smooth_trajectory(&mut pts);
        Ok(pts)
    } else {
        let mut pts = parse_telemetry_csv(path)?;
        smooth_trajectory(&mut pts);
        Ok(pts)
    }
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

fn lerp_point(a: &FlightPoint, b: &FlightPoint, t: f32) -> FlightPoint {
    FlightPoint {
        timestamp_sec: a.timestamp_sec + t * (b.timestamp_sec - a.timestamp_sec),
        latitude: a.latitude + t as f64 * (b.latitude - a.latitude),
        longitude: a.longitude + t as f64 * (b.longitude - a.longitude),
        altitude_m: a.altitude_m + t * (b.altitude_m - a.altitude_m),
        pitch_deg: a.pitch_deg + t * (b.pitch_deg - a.pitch_deg),
        roll_deg: a.roll_deg + t * (b.roll_deg - a.roll_deg),
        yaw_deg: a.yaw_deg + t * (b.yaw_deg - a.yaw_deg),
        gimbal_pitch_deg: match (a.gimbal_pitch_deg, b.gimbal_pitch_deg) {
            (Some(ga), Some(gb)) => Some(ga + t * (gb - ga)),
            (Some(ga), None) => Some(ga),
            (None, Some(gb)) => Some(gb),
            (None, None) => None,
        },
        focal_len: a.focal_len.or(b.focal_len),
    }
}

fn get_frame_telemetry(points: &[FlightPoint], frame_idx: usize) -> Option<FlightPoint> {
    if points.is_empty() {
        return None;
    }
    let target_time = frame_idx as f32;
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
            "fps=1, scale=1920:1080",
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
            "fps=1, scale=1920:1080",
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
                "[GPU] ✓ CUDA Execution Provider engaged — device 0 (NVIDIA RTX 2050).",
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
const PLY_OUTPUT_PATH: &str = "../frontend/public/recon_output.ply";
const OBJ_OUTPUT_PATH: &str = "../frontend/public/recon_output.obj";
const LAS_OUTPUT_PATH: &str = "../frontend/public/recon_output.las";
const GLB_OUTPUT_PATH: &str = "../frontend/public/recon_output.glb";
const GEOREF_OUTPUT_PATH: &str = "../frontend/public/recon_georeference.json";

const ONNX_INPUT_NAME: &str = "pixel_values";
const ONNX_OUTPUT_NAME: &str = "predicted_depth";

#[tauri::command]
async fn run_reconstruction(
    app: tauri::AppHandle,
    video_path: String,
    telemetry_path: String,
    hardware_profile: HardwareProfile,
    camera_pitch_deg: Option<f32>,
) -> Result<String, String> {
    let pitch = camera_pitch_deg.unwrap_or(-45.0);
    tauri::async_runtime::spawn_blocking(move || {
        run_reconstruction_inner(app, video_path, telemetry_path, hardware_profile, pitch)
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
    let telemetry = parse_telemetry(&telemetry_path)?;
    let has_telemetry = !telemetry.is_empty();

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
    for (frame_idx, path) in frame_paths.iter().enumerate() {
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

        // Telemetry lookup
        let fp_opt = get_frame_telemetry(&telemetry, frame_idx);
        let h_agl = fp_opt.as_ref().map(|p| p.altitude_m).unwrap_or(20.0).clamp(3.0, 400.0);
        let yaw_deg = fp_opt.as_ref().map(|p| p.yaw_deg).unwrap_or(0.0);

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
        let pitch_rad = camera_pitch_deg.to_radians();
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

    // 7A. Binary PLY Export (with element face)
    let ply_file = File::create(PLY_OUTPUT_PATH)
        .map_err(|e| format!("[IO] Cannot create PLY: {}", e))?;
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
        vertex_count,
        faces.len()
    )
    .map_err(|e| format!("[IO] PLY header write failed: {}", e))?;

    let mut ply_bin: Vec<u8> = Vec::with_capacity(vertex_count * 15 + faces.len() * 13);
    for pt in &mesh_vertices {
        ply_bin.extend_from_slice(&pt.x.to_le_bytes());
        ply_bin.extend_from_slice(&pt.y.to_le_bytes());
        ply_bin.extend_from_slice(&pt.z.to_le_bytes());
        ply_bin.push(pt.r.round().clamp(0.0, 255.0) as u8);
        ply_bin.push(pt.g.round().clamp(0.0, 255.0) as u8);
        ply_bin.push(pt.b.round().clamp(0.0, 255.0) as u8);
    }
    for f in &faces {
        ply_bin.push(3u8);
        ply_bin.extend_from_slice(&(f[0] as i32).to_le_bytes());
        ply_bin.extend_from_slice(&(f[1] as i32).to_le_bytes());
        ply_bin.extend_from_slice(&(f[2] as i32).to_le_bytes());
    }
    ply_writer.write_all(&ply_bin).map_err(|e| format!("[IO] PLY binary write failed: {}", e))?;
    ply_writer.flush().map_err(|e| format!("[IO] PLY flush failed: {}", e))?;

    // 7B. Wavefront OBJ Export (with real f lines)
    if let Ok(obj_file) = File::create(OBJ_OUTPUT_PATH) {
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

    // 7C. ASPRS LAS 1.2 Export (Observed points only, Y = north = -pt.z, correct bounds)
    let observed_pts: Vec<&SurfacePoint> = surface_grid.values().collect();
    let num_las_pts = observed_pts.len() as u32;

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut min_z = f64::INFINITY;
    let mut max_z = f64::NEG_INFINITY;

    for pt in &observed_pts {
        let lx = pt.x as f64;
        let ly = (-pt.z) as f64; // LAS Y = North
        let lz = pt.y as f64;   // LAS Z = Elevation
        min_x = min_x.min(lx);
        max_x = max_x.max(lx);
        min_y = min_y.min(ly);
        max_y = max_y.max(ly);
        min_z = min_z.min(lz);
        max_z = max_z.max(lz);
    }

    if let Ok(las_file) = File::create(LAS_OUTPUT_PATH) {
        let mut las_writer = BufWriter::with_capacity(8 * 1024 * 1024, las_file);
        let mut header = [0u8; 227];
        header[0..4].copy_from_slice(b"LASF");
        header[24] = 1;
        header[25] = 2;
        let sys_id = b"UAV-3D-RECON";
        header[26..26 + sys_id.len()].copy_from_slice(sys_id);
        let gen_sw = b"Tactical-Engine";
        header[58..58 + gen_sw.len()].copy_from_slice(gen_sw);
        header[94..96].copy_from_slice(&227u16.to_le_bytes());
        header[96..100].copy_from_slice(&227u32.to_le_bytes());
        header[104] = 2; // Point Data Record Format 2 (XYZ + RGB)
        header[105..107].copy_from_slice(&26u16.to_le_bytes());
        header[107..111].copy_from_slice(&num_las_pts.to_le_bytes());

        let scale = 0.001f64;
        header[131..139].copy_from_slice(&scale.to_le_bytes());
        header[139..147].copy_from_slice(&scale.to_le_bytes());
        header[147..155].copy_from_slice(&scale.to_le_bytes());

        // Offsets 179..227: MaxX, MinX, MaxY, MinY, MaxZ, MinZ
        header[179..187].copy_from_slice(&max_x.to_le_bytes());
        header[187..195].copy_from_slice(&min_x.to_le_bytes());
        header[195..203].copy_from_slice(&max_y.to_le_bytes());
        header[203..211].copy_from_slice(&min_y.to_le_bytes());
        header[211..219].copy_from_slice(&max_z.to_le_bytes());
        header[219..227].copy_from_slice(&min_z.to_le_bytes());

        let _ = las_writer.write_all(&header);

        let mut point_buf = Vec::with_capacity(num_las_pts as usize * 26);
        for pt in &observed_pts {
            let xi = (((pt.x as f64) - min_x) / scale).round() as i32;
            let yi = (((-pt.z as f64) - min_y) / scale).round() as i32;
            let zi = (((pt.y as f64) - min_z) / scale).round() as i32;

            point_buf.extend_from_slice(&xi.to_le_bytes());
            point_buf.extend_from_slice(&yi.to_le_bytes());
            point_buf.extend_from_slice(&zi.to_le_bytes());
            point_buf.extend_from_slice(&1000u16.to_le_bytes());
            point_buf.push(1); // Return number 1
            point_buf.push(if pt.y > 4.0 { 5 } else { 2 }); // Classification: High Veg vs Ground
            point_buf.push(0);
            point_buf.push(0);
            point_buf.extend_from_slice(&0u16.to_le_bytes());
            point_buf.extend_from_slice(&((pt.r.round().clamp(0.0, 255.0) as u16) << 8).to_le_bytes());
            point_buf.extend_from_slice(&((pt.g.round().clamp(0.0, 255.0) as u16) << 8).to_le_bytes());
            point_buf.extend_from_slice(&((pt.b.round().clamp(0.0, 255.0) as u16) << 8).to_le_bytes());
        }
        let _ = las_writer.write_all(&point_buf);
        let _ = las_writer.flush();
    }

    // 7E. glTF 2.0 Binary (GLB) Export
    let _ = write_glb(GLB_OUTPUT_PATH, &mesh_vertices, &faces);

    // 7D. WGS-84 Georeference Metadata Export (Observed points)
    if let Ok(georef_file) = File::create(GEOREF_OUTPUT_PATH) {
        let mut georef_writer = BufWriter::new(georef_file);
        let orig_lat = telemetry.first().map(|p| p.latitude).unwrap_or(0.0);
        let orig_lon = telemetry.first().map(|p| p.longitude).unwrap_or(0.0);
        let orig_alt = telemetry.first().map(|p| p.altitude_m).unwrap_or(20.0);
        let earth_r = 6_378_137.0f64;
        let deg_per_m = 180.0 / (std::f64::consts::PI * earth_r);
        let lat_rad = (orig_lat * std::f64::consts::PI / 180.0) as f32;
        let deg_per_m_lon = deg_per_m / (lat_rad.cos() as f64).max(0.1);

        // -Z is North, so lat = orig_lat - z * deg_per_m
        let min_lat_wgs = orig_lat - (max_z) * deg_per_m;
        let max_lat_wgs = orig_lat - (min_z) * deg_per_m;
        let min_lon_wgs = orig_lon + (min_x) * deg_per_m_lon;
        let max_lon_wgs = orig_lon + (max_x) * deg_per_m_lon;

        let _ = writeln!(
            georef_writer,
            "{{\n  \"description\": \"Single-Pass Drone Video 3D Reconstruction Metadata\",\n  \
               \"spatial_accuracy\": \"GPS-limited (target <= 1 m, not independently validated with GCPs)\",\n  \
               \"coordinate_system\": \"WGS-84 / Metric Cartesian Local Plane\",\n  \
               \"assumptions\": {{\n    \"camera_pitch_deg\": {:.1},\n    \"hfov_deg\": {:.1},\n    \"altitude_reference\": \"relative to takeoff (AGL)\"\n  }},\n  \
               \"origin\": {{\n    \"latitude\": {:.6},\n    \"longitude\": {:.6},\n    \"altitude_m\": {:.2}\n  }},\n  \
               \"bounds_wgs84\": {{\n    \"min_latitude\": {:.6},\n    \"max_latitude\": {:.6},\n    \"min_longitude\": {:.6},\n    \"max_longitude\": {:.6}\n  }},\n  \
               \"metric_extents\": {{\n    \"width_x_m\": {:.2},\n    \"height_relief_y_m\": {:.2},\n    \"length_z_m\": {:.2}\n  }},\n  \
               \"total_observed_points\": {},\n  \
               \"total_mesh_vertices\": {},\n  \
               \"total_mesh_faces\": {},\n  \
               \"deliverables\": [\"recon_output.ply\", \"recon_output.obj\", \"recon_output.las\", \"recon_output.glb\", \"recon_georeference.json\"]\n}}",
            camera_pitch_deg, intrinsics.hfov_deg,
            orig_lat, orig_lon, orig_alt,
            min_lat_wgs, max_lat_wgs, min_lon_wgs, max_lon_wgs,
            max_x - min_x, max_z - min_z, max_y - min_y,
            observed_pts.len(),
            vertex_count,
            faces.len()
        );
        let _ = georef_writer.flush();
    }

    let t_export = t_export_start.elapsed();
    let elapsed = wall_clock.elapsed();
    let msg = format!(
        "Reconstruction complete in {:.2?} — {} vertices, {} faces written (PLY, OBJ, LAS, GLB & GeoRef). Export time: {:.2?}",
        elapsed, vertex_count, faces.len(), t_export
    );
    let _ = app.emit("pipeline-log", format!("[SUCCESS] ✓ {}", msg));
    Ok(msg)
}

// ─────────────────────────────────────────────────────────────
// glTF 2.0 Binary (GLB) Hand-Written Exporter (No Crates)
// ─────────────────────────────────────────────────────────────

fn write_glb(path: &str, vertices: &[SurfacePoint], faces: &[[u32; 3]]) -> Result<(), String> {
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
        r#"{{"asset":{{"version":"2.0","generator":"Tactical-3D-Recon"}},"scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"mesh":0}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"COLOR_0":1}},"indices":2,"mode":4}}]}}],"accessors":[{{"bufferView":0,"byteOffset":0,"componentType":5126,"count":{},"type":"VEC3","min":[{:.4},{:.4},{:.4}],"max":[{:.4},{:.4},{:.4}]}},{{"bufferView":1,"byteOffset":0,"componentType":5126,"count":{},"type":"VEC3"}},{{"bufferView":2,"byteOffset":0,"componentType":5125,"count":{},"type":"SCALAR"}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{},"target":34962}},{{"buffer":0,"byteOffset":{},"byteLength":{},"target":34962}},{{"buffer":0,"byteOffset":{},"byteLength":{},"target":34963}}],"buffers":[{{"byteLength":{}}}]}}"#,
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
        let res = run_reconstruction_inner(
            app.handle().clone(),
            video,
            tele,
            HardwareProfile::Balanced,
            -45.0,
        );
        eprintln!("[baseline] elapsed={:?} result={:?}", t0.elapsed(), res);
        assert!(res.is_ok(), "pipeline failed: {:?}", res.err());
    }

    #[test]
    fn test_las_header_bounds_offsets() {
        let mut header = [0u8; 227];
        let max_x: f64 = 123.456;
        let min_x: f64 = -45.678;
        let max_y: f64 = 890.123;
        let min_y: f64 = 12.345;
        let max_z: f64 = 55.555;
        let min_z: f64 = 1.111;

        header[179..187].copy_from_slice(&max_x.to_le_bytes());
        header[187..195].copy_from_slice(&min_x.to_le_bytes());
        header[195..203].copy_from_slice(&max_y.to_le_bytes());
        header[203..211].copy_from_slice(&min_y.to_le_bytes());
        header[211..219].copy_from_slice(&max_z.to_le_bytes());
        header[219..227].copy_from_slice(&min_z.to_le_bytes());

        let read_max_x = f64::from_le_bytes(header[179..187].try_into().unwrap());
        let read_min_x = f64::from_le_bytes(header[187..195].try_into().unwrap());
        let read_max_y = f64::from_le_bytes(header[195..203].try_into().unwrap());
        let read_min_y = f64::from_le_bytes(header[203..211].try_into().unwrap());
        let read_max_z = f64::from_le_bytes(header[211..219].try_into().unwrap());
        let read_min_z = f64::from_le_bytes(header[219..227].try_into().unwrap());

        assert_eq!(read_max_x, max_x);
        assert_eq!(read_min_x, min_x);
        assert_eq!(read_max_y, max_y);
        assert_eq!(read_min_y, min_y);
        assert_eq!(read_max_z, max_z);
        assert_eq!(read_min_z, min_z);
    }
}