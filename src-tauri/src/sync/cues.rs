//! Reading a subtitle file's cues: their times and words.
//!
//! FFmpeg reads every format Lumen opens (SubRip, ASS/SSA, WebVTT, SAMI…)
//! and writes it out as SubRip, which is then read here. So there is one
//! small reader rather than one per format.

use std::path::Path;

use super::align::Cue;
use crate::error::{AppError, AppResult};
use crate::media::tools::{self, Tool};

/// The cues of a subtitle file, in time order.
pub fn read(file: &Path) -> AppResult<Vec<Cue>> {
    if !file.is_file() {
        return Err(AppError::NotFound(
            "the subtitle file is no longer where it was".to_owned(),
        ));
    }
    // A file that is not UTF-8 makes FFmpeg stop; most such files are in
    // the Western Windows encoding, which is tried next.
    for encoding in [None, Some("CP1252")] {
        let Some(mut command) = tools::command(Tool::Ffmpeg) else {
            return Err(AppError::Internal("FFmpeg is missing".to_owned()));
        };
        command.args(["-nostdin", "-loglevel", "error"]);
        if let Some(encoding) = encoding {
            command.args(["-sub_charenc", encoding]);
        }
        command.arg("-i").arg(file);
        command.args(["-map", "0:s:0", "-f", "srt", "-"]);
        let output = command.output()?;
        if output.status.success() {
            let cues = parse_srt(&String::from_utf8_lossy(&output.stdout));
            if cues.is_empty() {
                return Err(AppError::Invalid(
                    "the subtitle file has no lines with text".to_owned(),
                ));
            }
            return Ok(cues);
        }
        tracing::debug!(
            stderr = %String::from_utf8_lossy(&output.stderr),
            ?encoding,
            "FFmpeg could not read the subtitles"
        );
    }
    Err(AppError::Invalid(
        "the subtitle file could not be read".to_owned(),
    ))
}

/// Reads SubRip text. Malformed blocks are skipped, not fatal.
pub fn parse_srt(text: &str) -> Vec<Cue> {
    let text = text.replace("\r\n", "\n");
    let mut cues = Vec::new();
    for block in text.split("\n\n") {
        let mut lines = block.lines().map(str::trim).skip_while(|l| l.is_empty());
        let Some(first) = lines.next() else { continue };
        // The counter line is optional in practice.
        let timing = if first.contains("-->") {
            first
        } else {
            match lines.next() {
                Some(line) if line.contains("-->") => line,
                _ => continue,
            }
        };
        let Some((start, end)) = timing.split_once("-->") else {
            continue;
        };
        let (Some(start), Some(end)) = (timestamp(start), timestamp(end)) else {
            continue;
        };
        let words: Vec<&str> = lines.collect();
        let text = words.join("\n");
        if text.trim().is_empty() || end < start {
            continue;
        }
        cues.push(Cue { start, end, text });
    }
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    cues
}

/// `01:02:03,456` (or with a full stop, or without hours) in seconds.
fn timestamp(text: &str) -> Option<f64> {
    // A WebVTT-style cue setting may follow the time.
    let text = text.split_whitespace().next()?;
    let (clock, fraction) = match text.rsplit_once([',', '.']) {
        Some((clock, fraction)) => (clock, fraction),
        None => (text, "0"),
    };
    let mut seconds = 0.0;
    for part in clock.split(':') {
        seconds = seconds * 60.0 + part.parse::<u32>().ok()? as f64;
    }
    let digits = fraction.len() as i32;
    let fraction = fraction.parse::<u32>().ok()? as f64 / 10f64.powi(digits);
    Some(seconds + fraction)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_subrip_blocks() {
        let cues = parse_srt(
            "1\r\n00:00:01,500 --> 00:00:03,000\r\nHello there.\r\nSecond line\r\n\r\n\
             2\n00:01:02.25 --> 00:01:04.250 X:1\n<i>Later</i>\n\n\
             junk\n\n\
             3\n00:01:05,000 --> 00:01:06,000\n\n",
        );
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start, 1.5);
        assert_eq!(cues[0].end, 3.0);
        assert_eq!(cues[0].text, "Hello there.\nSecond line");
        assert!((cues[1].start - 62.25).abs() < 1e-9);
        assert_eq!(cues[1].text, "<i>Later</i>");
    }

    #[test]
    fn reads_hours_and_short_forms() {
        assert_eq!(timestamp("01:00:00,000"), Some(3600.0));
        assert_eq!(timestamp("02:03.5"), Some(123.5));
        assert_eq!(timestamp("nonsense"), None);
    }

    #[test]
    fn reads_other_formats_through_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("lumen-cues-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let vtt = dir.join("a.vtt");
        std::fs::write(
            &vtt,
            "WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nFirst words\n\n00:00:05.000 --> 00:00:06.500\nMore\n",
        )
        .unwrap();
        let cues = read(&vtt).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[1].start, 5.0);
        assert_eq!(cues[1].text, "More");

        // Western Windows encoding: "café" with é as 0xE9.
        let latin = dir.join("b.srt");
        std::fs::write(&latin, b"1\n00:00:01,000 --> 00:00:02,000\ncaf\xe9\n\n").unwrap();
        let cues = read(&latin).unwrap();
        assert_eq!(cues[0].text, "café");

        assert!(read(&dir.join("missing.srt")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
