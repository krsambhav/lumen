//! The FFmpeg command-line tools that ship with Lumen.
//!
//! In a bundle they sit beside the executable. A development build uses the
//! ones `scripts/build-deps.sh` put in `vendor/`, which find their libraries
//! through the environment rather than through the bundle.

use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Ffmpeg,
    Ffprobe,
    AirPlay,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
            Self::AirPlay => "lumen-airplay",
        }
    }
}

/// Where a development build's native dependencies are.
fn dev_vendor() -> Option<PathBuf> {
    option_env!("LUMEN_DEV_VENDOR").map(PathBuf::from)
}

fn beside_the_executable(tool: Tool) -> Option<PathBuf> {
    let path = std::env::current_exe().ok()?.parent()?.join(tool.name());
    path.is_file().then_some(path)
}

/// A command that runs `tool`, with nothing on its standard input. `None` if
/// the tool is not there, which callers treat as "this cannot be known".
pub fn command(tool: Tool) -> Option<Command> {
    if let Some(path) = beside_the_executable(tool) {
        let mut command = Command::new(path);
        command.stdin(std::process::Stdio::null());
        return Some(command);
    }
    let vendor = dev_vendor()?;
    let path = vendor.join("bin").join(tool.name());
    if !path.is_file() {
        return None;
    }
    let mut command = Command::new(path);
    command
        .env("DYLD_LIBRARY_PATH", vendor.join("lib"))
        .stdin(std::process::Stdio::null());
    Some(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_both_tools_in_a_development_build() {
        for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
            let output = command(tool)
                .unwrap_or_else(|| panic!("{} is missing", tool.name()))
                .arg("-version")
                .output()
                .expect("run the tool");
            assert!(output.status.success(), "{tool:?}");
            let said = String::from_utf8_lossy(&output.stdout);
            assert!(said.starts_with(tool.name()), "{said}");
        }
    }
}
