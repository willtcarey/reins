// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_BACKEND_URL: &str = "http://localhost:3100";

fn env_backend_url() -> Option<String> {
    std::env::var("REINS_BACKEND_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn build_time_backend_url() -> Option<String> {
    option_env!("REINS_BACKEND_URL")
        .filter(|value| !value.trim().is_empty())
        .map(String::from)
}

fn backend_url() -> String {
    env_backend_url()
        .or_else(build_time_backend_url)
        .unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string())
}

fn main() {
    let backend_url = backend_url();

    tauri::Builder::default()
        .setup(move |app| {
            let url = backend_url.parse().unwrap_or_else(|error| {
                panic!("invalid REINS_BACKEND_URL `{backend_url}`: {error}")
            });
            let url = WebviewUrl::External(url);

            WebviewWindowBuilder::new(app, "main", url)
                .title("REINS")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .initialization_script(
                    r#"document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    window.location.reload();
  }
});"#,
                )
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
