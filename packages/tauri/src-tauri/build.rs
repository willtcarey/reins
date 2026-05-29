fn main() {
    println!("cargo:rerun-if-env-changed=REINS_BACKEND_URL");
    tauri_build::build()
}
