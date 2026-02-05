use std::env;
use std::path::PathBuf;

fn main() {
    // Get paths from environment or use defaults
    let libzdbdecode_path = env::var("LIBZDBDECODE_PATH")
        .unwrap_or_else(|_| "../native".to_string());
    let zfs_prefix = env::var("ZFS_PREFIX")
        .unwrap_or_else(|_| "../_deps/openzfs".to_string());

    println!("cargo:rerun-if-changed=../native/include/zdbdecode.h");
    println!("cargo:rerun-if-changed=../native/libzdbdecode.so");

    // Link to native library
    println!("cargo:rustc-link-search=native={}", libzdbdecode_path);
    println!("cargo:rustc-link-lib=zdbdecode");

    // Link to ZFS libraries
    println!("cargo:rustc-link-search=native={}/lib", zfs_prefix);
    println!("cargo:rustc-link-lib=zfs");
    println!("cargo:rustc-link-lib=zpool");
    println!("cargo:rustc-link-lib=nvpair");

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
