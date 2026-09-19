// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Force high-performance discrete GPU (NVIDIA GeForce RTX) on dual-GPU laptops
#[used]
#[no_mangle]
pub static NvOptimusEnablement: std::os::raw::c_ulong = 0x00000001;

#[used]
#[no_mangle]
pub static AmdPowerXpressRequestHighPerformance: std::os::raw::c_int = 1;

fn set_windows_gpu_preference() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let add_pref = |exe_path: &str| {
            let _ = std::process::Command::new("reg")
                .args([
                    "add",
                    "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences",
                    "/v",
                    exe_path,
                    "/t",
                    "REG_SZ",
                    "/d",
                    "GpuPreference=2;",
                    "/f",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        };

        if let Ok(current) = std::env::current_exe() {
            let path_str = current.to_string_lossy().to_string();
            add_pref(&path_str);
            eprintln!("[GPU] Registered DirectX High Performance preference for {}", path_str);
        }

        // Search for msedgewebview2.exe under C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\*\\
        let base_dir = std::path::Path::new("C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application");
        if let Ok(entries) = std::fs::read_dir(base_dir) {
            for entry in entries.flatten() {
                let candidate = entry.path().join("msedgewebview2.exe");
                if candidate.exists() {
                    let path_str = candidate.to_string_lossy().to_string();
                    add_pref(&path_str);
                    eprintln!("[GPU] Registered DirectX High Performance preference for {}", path_str);
                }
            }
        }
    }
}

fn main() {
    set_windows_gpu_preference();

    // Instruct WebView2 to bind to the discrete high-performance GPU
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--force-high-performance-gpu --force_high_performance_gpu --enable-gpu-rasterization --gpu-preference=2",
    );

    app_lib::run();
}
