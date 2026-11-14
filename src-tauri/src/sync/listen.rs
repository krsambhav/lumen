//! Hearing what is said in a stretch of the film: FFmpeg cuts the sound
//! out, whisper.cpp writes down its words with their times. Both run on
//! this Mac; nothing is sent anywhere.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use whisper_rs::{
    DtwMode, DtwModelPreset, DtwParameters, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters,
};

use super::align::{Window, Word};
use crate::error::{AppError, AppResult};
use crate::media::tools::{self, Tool};

/// About how long a token takes to say, in seconds: the aligned times say
/// only where each one starts.
const TOKEN_LENGTH: f64 = 0.25;

/// What Whisper listens at.
const SAMPLE_RATE: usize = 16_000;

/// The sound of `window` in `source`, as Whisper takes it: 16 kHz mono,
/// samples from -1 to 1. `audio` is the index of the audio stream among
/// the file's audio streams.
pub fn sound_of(source: &str, audio: usize, window: &Window) -> AppResult<Vec<f32>> {
    let sound = cut(source, audio, window)?;
    // A track mpv knows that FFmpeg numbers differently (an audio file
    // added beside the film): the file's first track instead.
    if sound.is_empty() && audio != 0 {
        return cut(source, 0, window);
    }
    Ok(sound)
}

fn cut(source: &str, audio: usize, window: &Window) -> AppResult<Vec<f32>> {
    let Some(mut command) = tools::command(Tool::Ffmpeg) else {
        return Err(AppError::Internal("FFmpeg is missing".to_owned()));
    };
    command
        .args(["-nostdin", "-loglevel", "error", "-ss"])
        .arg(format!("{:.3}", window.start))
        .arg("-t")
        .arg(format!("{:.3}", window.length))
        .arg("-i")
        .arg(source)
        .args(["-map", &format!("0:a:{audio}?"), "-vn", "-sn", "-dn"])
        .args([
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "-",
        ]);
    let output = command.output()?;
    if !output.status.success() {
        tracing::warn!(stderr = %String::from_utf8_lossy(&output.stderr), "no sound cut out");
        return Err(AppError::Invalid(
            "the sound of this file could not be read".to_owned(),
        ));
    }
    Ok(output
        .stdout
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
        .collect())
}

/// One loaded model, kept between syncs: loading it takes seconds.
static LOADED: Mutex<Option<(std::path::PathBuf, Arc<WhisperContext>)>> = Mutex::new(None);

fn context(model: &Path) -> AppResult<Arc<WhisperContext>> {
    let mut loaded = LOADED.lock();
    if let Some((path, context)) = loaded.as_ref() {
        if path == model {
            return Ok(Arc::clone(context));
        }
    }
    // whisper.cpp's chatter goes to the log, not to the terminal.
    whisper_rs::install_logging_hooks();
    let path = model
        .to_str()
        .ok_or_else(|| AppError::Internal("the model's path is not text".to_owned()))?;
    // Word times from the decoder alone collapse onto the start of a
    // segment when it follows silence (a word said 10 s into a sample was
    // put at 0 s). Aligning the words to the sound with the model's
    // attention (DTW) puts them within about a fifth of a second.
    let mut params = WhisperContextParameters::default();
    params.dtw_parameters(DtwParameters {
        mode: DtwMode::ModelPreset {
            model_preset: DtwModelPreset::Base,
        },
        ..DtwParameters::default()
    });
    let context = WhisperContext::new_with_params(path, params)
        .map_err(|error| AppError::Internal(format!("the speech model would not load: {error}")))?;
    let context = Arc::new(context);
    *loaded = Some((model.to_owned(), Arc::clone(&context)));
    Ok(context)
}

/// Lets go of the model, which holds a few hundred megabytes.
pub fn unload() {
    LOADED.lock().take();
}

/// The words said in `sound`, which starts at `offset` on the video's clock.
pub fn words_in(
    model: &Path,
    sound: &[f32],
    offset: f64,
    cancelled: &Arc<AtomicBool>,
) -> AppResult<Vec<Word>> {
    // Under a second of sound, Whisper only makes things up.
    if sound.len() < SAMPLE_RATE {
        return Ok(Vec::new());
    }
    let context = context(model)?;
    let mut state = context
        .create_state()
        .map_err(|error| AppError::Internal(format!("no speech state: {error}")))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_token_timestamps(true);
    // Each sample stands alone: no words carried over from the last.
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    params.set_n_threads(threads as i32);
    // No abort callback: whisper-rs 0.16's `set_abort_callback_safe` hands
    // whisper.cpp a pointer of another type than its trampoline reads, and
    // the encoder then stops at random. A sample takes under a second, so
    // a cancel is seen between samples instead.

    state
        .full(params, sound)
        .map_err(|error| AppError::Internal(format!("speech recognition failed: {error}")))?;
    if cancelled.load(Ordering::Acquire) {
        return Ok(Vec::new());
    }

    let mut words: Vec<Word> = Vec::new();
    for segment in state.as_iter() {
        // A segment Whisper thinks is not speech is usually music it has
        // put words to.
        if segment.no_speech_probability() > 0.6 {
            continue;
        }
        for index in 0..segment.n_tokens() {
            let Some(token) = segment.get_token(index) else {
                continue;
            };
            let Ok(text) = token.to_str_lossy() else {
                continue;
            };
            // Timing marks and other special tokens.
            if text.starts_with("[_") || text.starts_with("<|") {
                continue;
            }
            let data = token.token_data();
            // Whisper counts in hundredths of a second. The aligned time is
            // where the token starts being said.
            let said = if data.t_dtw >= 0 { data.t_dtw } else { data.t0 };
            let start = offset + said as f64 / 100.0;
            let joins = !text.starts_with(' ') && !words.is_empty();
            match words.last_mut() {
                Some(last) if joins => {
                    last.text.push_str(&text);
                    last.end = last.end.max(start + TOKEN_LENGTH);
                }
                _ => words.push(Word {
                    start,
                    end: start + TOKEN_LENGTH,
                    text: text.trim().to_owned(),
                }),
            }
        }
    }
    words.retain(|word| !word.text.is_empty());
    Ok(words)
}
