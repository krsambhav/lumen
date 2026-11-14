use std::path::PathBuf;

fn main() {
    link_native_libraries();
    link_compiler_runtime();
    tauri_build::build();
}

/// Links clang's runtime library, which holds `__isPlatformVersionAtLeast`:
/// the check behind Objective-C's `@available`, used by whisper.cpp's Metal
/// code. rustc links with `cc` but not always against this archive, and a
/// release build then fails with that symbol undefined.
fn link_compiler_runtime() {
    let Ok(output) = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
    else {
        return;
    };
    let resources = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let darwin = PathBuf::from(resources).join("lib/darwin");
    if darwin.join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={}", darwin.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}

/// Links libmpv from `vendor/`, built by `scripts/build-deps.sh`.
///
/// The app finds its dylibs through `@rpath`. In a bundle that is
/// `Contents/Frameworks`; for `cargo run` and `cargo test` the vendor
/// directory itself is added, in debug builds only.
fn link_native_libraries() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let vendor = manifest.join("../vendor");
    let lib = vendor.join("lib");

    println!(
        "cargo:rerun-if-changed={}",
        vendor.join("VERSIONS").display()
    );
    println!("cargo:rerun-if-env-changed=PROFILE");

    if !lib.join("libmpv.dylib").exists() {
        panic!(
            "libmpv is missing from {}. Run scripts/build-deps.sh first.",
            lib.display()
        );
    }
    let lib = lib.canonicalize().expect("vendor/lib");
    let vendor = vendor.canonicalize().expect("vendor");

    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-lib=dylib=mpv");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
        // Where development builds find ffmpeg and ffprobe.
        println!("cargo:rustc-env=LUMEN_DEV_VENDOR={}", vendor.display());
    }
}
