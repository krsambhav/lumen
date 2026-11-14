//! Asking a file about itself without playing it.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::tools::{self, Tool};

/// A file that takes longer than this to answer is left unanswered: a
/// playlist is not worth waiting on a sleeping disk for.
const PATIENCE: Duration = Duration::from_secs(4);

/// How long the media at `path` runs, in seconds, if it can be told.
pub fn duration(path: &Path) -> Option<f64> {
    let mut child = tools::command(Tool::Ffprobe)?
        .args(["-v", "error", "-show_entries", "format=duration"])
        .args(["-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + PATIENCE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // One short line: it was all in the pipe before the process ended.
    let mut said = String::new();
    child.stdout.take()?.read_to_string(&mut said).ok()?;
    parse_duration(&said)
}

fn parse_duration(said: &str) -> Option<f64> {
    said.lines()
        .find_map(|line| line.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::test_support::test_clip;

    #[test]
    fn reads_what_ffprobe_says() {
        assert_eq!(parse_duration("7305.216000\n"), Some(7305.216));
        // A stream with no length says so in words.
        assert_eq!(parse_duration("N/A\n"), None);
        assert_eq!(parse_duration(""), None);
        assert_eq!(parse_duration("0.000000\n"), None);
    }

    #[test]
    fn tells_how_long_a_real_file_runs() {
        let seconds = duration(test_clip()).expect("a duration");
        assert!((seconds - 2.0).abs() < 0.2, "{seconds}");
    }

    #[test]
    fn says_nothing_about_what_is_not_media_or_not_there() {
        let text = std::env::temp_dir().join(format!("lumen-probe-{}.txt", std::process::id()));
        std::fs::write(&text, "not a film").unwrap();
        assert_eq!(duration(&text), None);
        std::fs::remove_file(&text).unwrap();
        assert_eq!(duration(Path::new("/no/such/film.mkv")), None);
    }
}
