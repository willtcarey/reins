// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let backend_url = std::env::var("REINS_BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:3100".to_string());

    tauri::Builder::default()
        .setup(move |app| {
            let url: WebviewUrl = WebviewUrl::External(backend_url.parse().expect("invalid REINS_BACKEND_URL"));

            WebviewWindowBuilder::new(app, "main", url)
                .title("REINS")
                .inner_size(1200.0, 800.0)
                .min_inner_size(600.0, 400.0)
                .initialization_script(
                    "document.addEventListener('keydown', (e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
                            e.preventDefault();
                            window.location.reload();
                        }
                    });"
                )
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
