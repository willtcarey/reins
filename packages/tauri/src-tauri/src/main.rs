// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

use tauri::{
    menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    webview::DownloadEvent,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Wry,
};

const DEFAULT_BACKEND_URL: &str = "http://localhost:3100";
const MENU_RELOAD: &str = "reload";
const MENU_TOGGLE_DEVTOOLS: &str = "toggle_devtools";

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

fn open_external_url(url: &str) {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();

    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", url]).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();

    if let Err(error) = result {
        eprintln!("failed to open external URL `{url}`: {error}");
    }
}

fn app_menu(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let about_metadata = AboutMetadata {
        name: Some("REINS".to_string()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "REINS",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &PredefinedMenuItem::close_window(app, None)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &MenuItemBuilder::with_id(MENU_RELOAD, "Reload")
                        .accelerator("CmdOrCtrl+R")
                        .build(app)?,
                    &MenuItemBuilder::with_id(MENU_TOGGLE_DEVTOOLS, "Toggle Developer Tools")
                        .accelerator("CmdOrCtrl+Alt+I")
                        .build(app)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Help",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                ],
            )?,
        ],
    )
}

fn main() {
    let backend_url = backend_url();

    tauri::Builder::default()
        .setup(move |app| {
            app.set_menu(app_menu(app.handle())?)?;

            let backend_url: Url = backend_url.parse().unwrap_or_else(|error| {
                panic!("invalid REINS_BACKEND_URL `{backend_url}`: {error}")
            });
            let backend_origin = backend_url.origin().ascii_serialization();
            let url = WebviewUrl::External(backend_url);

            WebviewWindowBuilder::new(app, "main", url)
                .title("REINS")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .on_navigation(move |url| {
                    if url.origin().ascii_serialization() == backend_origin {
                        return true;
                    }

                    if matches!(url.scheme(), "http" | "https") {
                        open_external_url(url.as_str());
                        return false;
                    }

                    true
                })
                .on_download(|_, event| match event {
                    DownloadEvent::Requested { destination, .. } => {
                        let mut dialog = rfd::FileDialog::new();

                        if let Some(directory) = destination.parent() {
                            dialog = dialog.set_directory(directory);
                        }

                        if let Some(file_name) = destination.file_name() {
                            dialog = dialog.set_file_name(file_name.to_string_lossy());
                        }

                        if let Some(path) = dialog.save_file() {
                            *destination = path;
                            true
                        } else {
                            false
                        }
                    }
                    DownloadEvent::Finished { .. } => true,
                    _ => true,
                })
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
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_RELOAD => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.reload();
                }
            }
            MENU_TOGGLE_DEVTOOLS => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
