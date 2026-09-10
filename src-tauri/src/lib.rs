use tauri::Emitter;
use image::{GenericImageView, imageops::FilterType};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::process::Command;
use std::time::Instant;
use ort::{session::{Session, builder::GraphOptimizationLevel}, inputs, value::Tensor};
use serde::Deserialize;

const FOCAL_LENGTH: f32 = 380.0;
const INPUT_SIZE: usize = 518;
const BASE_ALTITUDE: f32 = 65.0; 

#[allow(dead_code)] // Silences terminal warnings about unused CSV columns
#[derive(Debug, Deserialize)]
struct FlightPoint {
    timestamp_sec: f32,
    latitude: f64,
    longitude: f64,
    altitude_m: f32,
    pitch_deg: f32,
    roll_deg: f32,
    yaw_deg: f32,
}

fn parse_telemetry(csv_path: &str) -> Vec<FlightPoint> {
    let mut points = Vec::new();
    if let Ok(mut rdr) = csv::Reader::from_path(csv_path) {
        for result in rdr.deserialize() {
            if let Ok(record) = result {
                points.push(record);
            }
        }
    }
    points
}

fn extract_frames(video_path: &str, output_dir: &str) -> Result<(), String> {
    fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
    let status = Command::new("ffmpeg")
        .args(["-y", "-i", video_path, "-vf", "fps=1", &format!("{}/frame_%04d.jpg", output_dir)])
        .status()
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;

    if !status.success() { return Err("FFmpeg process failed.".into()); }
    Ok(())
}

#[tauri::command]
fn run_reconstruction(app: tauri::AppHandle, video_path: String, telemetry_path: String) -> Result<String, String> {
    let start_time = Instant::now();
    app.emit("pipeline-log", "[SYSTEM] Initializing Hardware AI Engine...").unwrap();

    let _ = ort::init().commit();
    let model_path = "../models/depth_anything_v2_vits.onnx";
    
    let mut session = Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .commit_from_file(model_path)
        .map_err(|e| e.to_string())?;

    app.emit("pipeline-log", "[INFO] Slicing MP4 Video payload...").unwrap();
    let frames_dir = "../backend/temp_frames";
    extract_frames(&video_path, frames_dir)?;

    let mut frame_paths: Vec<_> = fs::read_dir(frames_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    frame_paths.sort();

    let num_frames = frame_paths.len();
    app.emit("pipeline-log", format!("[INFO] Sliced {} frames. Loading Telemetry...", num_frames)).unwrap();

    let telemetry = parse_telemetry(&telemetry_path);
    let origin_lat = telemetry.first().map(|p| p.latitude).unwrap_or(28.613939);
    let origin_lon = telemetry.first().map(|p| p.longitude).unwrap_or(77.209021);
    let origin_alt = telemetry.first().map(|p| p.altitude_m).unwrap_or(BASE_ALTITUDE);

    let cx = INPUT_SIZE as f32 / 2.0;
    let cy = INPUT_SIZE as f32 / 2.0;
    let area = INPUT_SIZE * INPUT_SIZE;
    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let mut vertex_buffer: Vec<u8> = Vec::with_capacity(num_frames * area * 35);
    let mut point_count: usize = 0;

    for (frame_idx, path) in frame_paths.iter().enumerate() {
        let original_img = image::open(path).map_err(|e| e.to_string())?;
        let resized_img = original_img.resize_exact(INPUT_SIZE as u32, INPUT_SIZE as u32, FilterType::Triangle);
        
        let mut raw_pixels = vec![0.0f32; 3 * area];
        for (x, y, pixel) in resized_img.pixels() {
            let idx = (y as usize) * INPUT_SIZE + (x as usize);
            raw_pixels[0 * area + idx] = (pixel[0] as f32 / 255.0 - mean[0]) / std[0];
            raw_pixels[1 * area + idx] = (pixel[1] as f32 / 255.0 - mean[1]) / std[1];
            raw_pixels[2 * area + idx] = (pixel[2] as f32 / 255.0 - mean[2]) / std[2];
        }

        let shape = [1usize, 3, INPUT_SIZE, INPUT_SIZE];
        let input_tensor = Tensor::from_array((shape, raw_pixels)).map_err(|e| e.to_string())?;
        let outputs = session.run(inputs!["pixel_values" => input_tensor]).map_err(|e| e.to_string())?;
        
        let depth_output = outputs["predicted_depth"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let depth_data = depth_output.1; 

        let min_depth = depth_data.iter().cloned().fold(f32::INFINITY, f32::min);
        let max_depth = depth_data.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

        // Metric flight offsets from GPS log
        let (dx, dy_alt, dz_fwd) = if let Some(pt) = telemetry.get(frame_idx) {
            let lat_rad = (pt.latitude * std::f64::consts::PI / 180.0) as f32;
            let delta_lat = (pt.latitude - origin_lat) as f32;
            let delta_lon = (pt.longitude - origin_lon) as f32;
            
            let x_m = delta_lon * (std::f64::consts::PI as f32 / 180.0) * 6378137.0 * lat_rad.cos();
            let z_m = delta_lat * (std::f64::consts::PI as f32 / 180.0) * 6378137.0;
            let y_m = pt.altitude_m - origin_alt;
            (x_m, y_m, z_m)
        } else {
            (0.0, 0.0, frame_idx as f32 * 12.0)
        };

        for y in 0..INPUT_SIZE {
            for x in 0..INPUT_SIZE {
                let idx = y * INPUT_SIZE + x;
                let normalized_inv = (depth_data[idx] - min_depth) / (max_depth - min_depth + 1e-6f32);

                // Sky clipping to keep the edges clean
                if normalized_inv < 0.15 {
                    continue;
                }

                let z_depth = 20.0 + (1.0 - normalized_inv) * 15.0; 

                // 1. Calculate standard physical dimensions
                // 1. Calculate continuous ground-plane dimensions
        let lateral = ((x as f32 - cx) * z_depth / 200.0) + dx;
        
        // Map the drone's forward flight to the image's vertical projection (Ground Z)
        let ground_z = ((y as f32 - cy) * z_depth / 200.0) - (dz_fwd * 0.95); 
        
        // Optical depth becomes height. Closer objects (trees) stand taller than ground
        let height = -z_depth - dy_alt; 

        // 2. Map directly to Three.js default axes (Y-up, right-handed)
        let ply_x = lateral; 
        let ply_y = height;  
        let ply_z = ground_z;

                let pixel = resized_img.get_pixel(x as u32, y as u32);
                point_count += 1;
                
                writeln!(vertex_buffer, "{:.3} {:.3} {:.3} {} {} {}", ply_x, ply_y, ply_z, pixel[0], pixel[1], pixel[2]).unwrap();
            }
        }
        app.emit("pipeline-log", format!("Processed frame {}/{}", frame_idx + 1, num_frames)).unwrap();
    }

    let _ = fs::remove_dir_all(frames_dir);

    let output_path = "../frontend/public/recon_output.ply";
    let file = File::create(output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(file);

    writeln!(writer, "ply\nformat ascii 1.0\nelement vertex {}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header", point_count).unwrap();
    writer.write_all(&vertex_buffer).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;

    let msg = format!("Reconstruction completed in {:?}", start_time.elapsed());
    app.emit("pipeline-log", format!("[SUCCESS] {}", msg)).unwrap();
    Ok(msg)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_reconstruction])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}