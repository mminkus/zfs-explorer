use std::env;
use std::path::PathBuf;
use std::process::Command;

fn git_short_sha() -> String {
    let output = Command::new("git")
        .args(["-C", "..", "rev-parse", "--short", "HEAD"])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if sha.is_empty() {
                "unknown".to_string()
            } else {
                sha
            }
        }
        _ => "unknown".to_string(),
    }
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_else(|_| "linux".to_string());

    // Get paths from environment or use defaults
    let libzdbdecode_path =
        env::var("LIBZDBDECODE_PATH").unwrap_or_else(|_| "../native".to_string());
    let zfs_prefix = env::var("ZFS_PREFIX").unwrap_or_else(|_| "../_deps/openzfs".to_string());

    println!("cargo:rerun-if-changed=../native/include/zdbdecode.h");
    match target_os.as_str() {
        "macos" => println!("cargo:rerun-if-changed=../native/libzdbdecode.dylib"),
        _ => println!("cargo:rerun-if-changed=../native/libzdbdecode.so"),
    }
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rustc-env=ZFS_EXPLORER_GIT_SHA={}", git_short_sha());

    // Link to native library
    println!("cargo:rustc-link-search=native={}", libzdbdecode_path);
    println!("cargo:rustc-link-lib=zdbdecode");

    // Link to ZFS libraries
    println!("cargo:rustc-link-search=native={}/lib", zfs_prefix);
    println!("cargo:rustc-link-lib=zfs");
    println!("cargo:rustc-link-lib=zpool");
    println!("cargo:rustc-link-lib=nvpair");

    // Dev/runtime convenience: resolve libs relative to backend/target/debug.
    // This keeps `sudo ./backend/target/debug/zfs-explorer` working without
    // manually exporting LD_LIBRARY_PATH.
    if matches!(target_os.as_str(), "linux" | "freebsd") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../../../native");
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../../../_deps/openzfs/lib");
    }

    // Generate bindings
    let bindings = bindgen::Builder::default()
        .header(format!("{}/include/zdbdecode.h", libzdbdecode_path))
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("Unable to generate bindings");

    // Write bindings to src/ffi/bindings.rs
    let out_path = PathBuf::from("src/ffi");
    std::fs::create_dir_all(&out_path).expect("Failed to create ffi directory");
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");
}
