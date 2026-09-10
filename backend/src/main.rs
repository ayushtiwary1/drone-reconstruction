use image::{GenericImageView, imageops::FilterType};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    inputs,
    value::Tensor,
};

const FOCAL_LENGTH: f32 = 500.0;
const INPUT_SIZE: usize = 518; // Depth Anything V2 requires multiples of 14

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("[SYSTEM] Initializing Depth Anything V2 AI Engine...");
    let start_time = Instant::now();

    // 1. Initialize ONNX Runtime Engine
    let _ = ort::init().commit();
    
    // 2. Load the AI Model 
    let model_path = "../models/depth_anything_v2_vits.onnx";
    
    let mut session = Session::builder()?
    .with_optimization_level(GraphOptimizationLevel::Level3)?
    .commit_from_file(model_path)?;
    
    println!("[INFO] AI Model loaded successfully. Preparing tensors...");

    // 3. Load and Preprocess the Image
    let img_path = "test_frame.jpg";
    let original_img = image::open(img_path)?;
    let resized_img = original_img.resize_exact(INPUT_SIZE as u32, INPUT_SIZE as u32, FilterType::Triangle);
    
    // Channel-first (CHW) flattened layout: [1, 3, 518, 518]
    let area = INPUT_SIZE * INPUT_SIZE;
    let mut raw_pixels = vec![0.0f32; 3 * area];
    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];
    
    for (x, y, pixel) in resized_img.pixels() {
        let x = x as usize;
        let y = y as usize;
        let idx = y * INPUT_SIZE + x;

        raw_pixels[0 * area + idx] = (pixel[0] as f32 / 255.0 - mean[0]) / std[0];
        raw_pixels[1 * area + idx] = (pixel[1] as f32 / 255.0 - mean[1]) / std[1];
        raw_pixels[2 * area + idx] = (pixel[2] as f32 / 255.0 - mean[2]) / std[2];
    }

    println!("[INFO] Executing Neural Network computation...");
    
    // 4. Create Tensor from (Shape, Vec) which natively implements OwnedTensorArrayData
    let shape = [1usize, 3, INPUT_SIZE, INPUT_SIZE];
    let input_tensor = Tensor::from_array((shape, raw_pixels))?;
    
    let outputs = session.run(inputs!["pixel_values" => input_tensor])?;
    
    // Extract raw prediction buffer directly: (shape, slice)
    let depth_output = outputs["predicted_depth"].try_extract_tensor::<f32>()?;
    let depth_data = depth_output.1; 

    println!("[INFO] AI Prediction complete. Unprojecting to true 3D geometry...");
    let output_path = "../frontend/public/recon_output.ply";
    let file = File::create(output_path)?;
    let mut writer = BufWriter::new(file);

    let total_points = INPUT_SIZE * INPUT_SIZE;
    writeln!(writer, "ply\nformat ascii 1.0\nelement vertex {}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header", total_points)?;

    let cx = INPUT_SIZE as f32 / 2.0;
    let cy = INPUT_SIZE as f32 / 2.0;

    let min_depth = depth_data.iter().cloned().fold(f32::INFINITY, f32::min);
    let max_depth = depth_data.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

    for y in 0..INPUT_SIZE {
        for x in 0..INPUT_SIZE {
            let pixel = resized_img.get_pixel(x as u32, y as u32);
            
            let idx = y * INPUT_SIZE + x;
            let raw_d = depth_data[idx];
            
            let normalized_inv = (raw_d - min_depth) / (max_depth - min_depth + 1e-6);
            let z = 5.0 / (normalized_inv + 0.1); 

            let x_f = x as f32;
            let y_f = y as f32;

            let world_x = (x_f - cx) * z / FOCAL_LENGTH;
            let world_y = (y_f - cy) * z / FOCAL_LENGTH;

            writeln!(writer, "{:.3} {:.3} {:.3} {} {} {}", world_x, -world_y, -z, pixel[0], pixel[1], pixel[2])?; 
        }
    }

    println!("[SUCCESS] Extracted AI Point Cloud in {:?}", start_time.elapsed());
    Ok(())
}