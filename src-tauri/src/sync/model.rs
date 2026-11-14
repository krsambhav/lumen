//! The speech-recognition model, fetched the first time it is needed.
//!
//! It is Whisper's multilingual "base" model in whisper.cpp's format,
//! quantised to 5 bits (MIT licence, see NOTICES). It is not shipped inside
//! the app: most people never sync a subtitle, and it is 60 MB.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::error::{AppError, AppResult};

pub const FILE_NAME: &str = "ggml-base-q5_1.bin";
const URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin";
pub const SIZE: u64 = 59_707_625;
const SHA256: &str = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898";

/// Where the model is kept: beside Lumen's other data, but in a folder of
/// its own so that a reset of the library leaves it alone.
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join("models").join(FILE_NAME)
}

/// The model is there and whole. Its size is checked here, its contents
/// when it was downloaded.
pub fn is_installed(dir: &Path) -> bool {
    std::fs::metadata(path_in(dir)).is_ok_and(|meta| meta.len() == SIZE)
}

/// Downloads the model into `dir`, calling `progress` with the share done
/// (0–1) as it arrives. Stops early, with an error, once `cancelled` is set.
///
/// The download goes to a side file, is checked against the known digest,
/// and only then takes the model's name, so a model that is there is whole.
/// macOS's own `curl` does the transfer: it uses the system's certificates
/// and proxy settings, and resumes a download that was cut short.
pub fn install(
    dir: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> AppResult<PathBuf> {
    let target = path_in(dir);
    if is_installed(dir) {
        return Ok(target);
    }
    let folder = target.parent().expect("the model has a folder");
    std::fs::create_dir_all(folder)?;
    let partial = target.with_extension("part");
    // A side file larger than the model is not a part of it.
    if std::fs::metadata(&partial).is_ok_and(|meta| meta.len() > SIZE) {
        std::fs::remove_file(&partial)?;
    }

    let mut child = Command::new("/usr/bin/curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--retry",
            "3",
            "--connect-timeout",
            "20",
            // Resume where an earlier attempt stopped.
            "--continue-at",
            "-",
            "--output",
        ])
        .arg(&partial)
        .arg(URL)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::Internal(format!("curl would not start: {error}")))?;

    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled_error());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let have = std::fs::metadata(&partial).map_or(0, |meta| meta.len());
        progress((have as f64 / SIZE as f64).min(1.0));
        std::thread::sleep(Duration::from_millis(150));
    };
    if !status.success() {
        let mut said = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut said);
        }
        tracing::warn!(?status, said = %said.trim(), "the model did not download");
        return Err(AppError::Network(
            "The speech model could not be downloaded. Check the connection and try again."
                .to_owned(),
        ));
    }
    progress(1.0);

    if digest_of(&partial)? != SHA256 {
        // Not what was published: start again next time rather than keep it.
        let _ = std::fs::remove_file(&partial);
        return Err(AppError::Network(
            "The speech model arrived damaged. Try again.".to_owned(),
        ));
    }
    std::fs::rename(&partial, &target)?;
    tracing::info!(path = %target.display(), "speech model installed");
    Ok(target)
}

pub fn cancelled_error() -> AppError {
    AppError::Invalid("cancelled".to_owned())
}

/// The file's SHA-256, in lower-case hex.
fn digest_of(file: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut reader = std::fs::File::open(file)?;
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_a_file() {
        let dir = std::env::temp_dir().join(format!("lumen-model-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(
            digest_of(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(!is_installed(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
