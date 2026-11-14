//! Questions about the volume a file is on.

use std::ffi::CString;
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// Whether `path` is on a volume that cannot be written to: a mounted disk
/// image, or the read-only copy macOS runs an app from when it was opened
/// where it was downloaded. `false` when that cannot be found out.
pub fn is_on_read_only_volume(path: &Path) -> bool {
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut volume = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is a NUL-terminated string that outlives the call, and
    // `volume` is room for exactly the structure `statfs` fills in.
    let filled = unsafe { libc::statfs(path.as_ptr(), volume.as_mut_ptr()) } == 0;
    if !filled {
        return false;
    }
    // SAFETY: `statfs` returned 0, so it wrote the whole structure.
    let volume = unsafe { volume.assume_init() };
    volume.f_flags & (libc::MNT_RDONLY as u32) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_sealed_volume_from_one_that_takes_writes() {
        // The system volume is sealed on every macOS Lumen runs on.
        assert!(is_on_read_only_volume(Path::new("/System/Library")));
        assert!(!is_on_read_only_volume(&std::env::temp_dir()));
    }

    #[test]
    fn what_cannot_be_asked_about_is_not_called_read_only() {
        assert!(!is_on_read_only_volume(Path::new(
            "/no/such/folder/anywhere"
        )));
        assert!(!is_on_read_only_volume(Path::new("")));
    }
}
