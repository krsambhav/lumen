//! Lining subtitles up with what is said: arithmetic only, no files, no
//! engine. Everything here works in seconds.
//!
//! Times on the picture's clock are "video" times; times written in the
//! subtitle file are "cue" times. mpv shows a cue timed `cue` at
//! `cue * speed + delay` on the video's clock (`sub-speed`, `sub-delay`), so
//! that is the model fitted here.
//!
//! Two ways of finding it, tried in this order:
//!
//! 1. **Words.** What was heard in a few samples of the film is matched
//!    against the cues' text, three words at a time. Each match is a pair of
//!    times, video and cue, and the pairs that agree on one timing give it.
//! 2. **When people speak.** Subtitles in another language than the sound
//!    share no words with it, but they still come and go when someone
//!    speaks. The moments of speech in the samples are slid against the
//!    moments a cue is up, and the timing where they coincide best wins.

/// One subtitle, on the file's clock.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// One word heard, on the video's clock.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A stretch of the film to listen to, on the video's clock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub start: f64,
    pub length: f64,
}

impl Window {
    #[cfg(test)]
    pub fn end(&self) -> f64 {
        self.start + self.length
    }
}

/// A cue timed `cue` is shown at `cue * speed + delay`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    pub speed: f64,
    pub delay: f64,
}

impl Timing {
    pub fn shown_at(&self, cue: f64) -> f64 {
        cue * self.speed + self.delay
    }
}

/// How a timing was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Words,
    Speech,
}

/// A timing, with how sure of it there is reason to be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Found {
    pub timing: Timing,
    pub method: Method,
    /// Samples that agree with it.
    pub agreeing: usize,
    /// Samples in which anything was heard at all.
    pub heard: usize,
}

/// How long each sample is: what Whisper takes in one pass.
pub const WINDOW_LENGTH: f64 = 30.0;

/// The most samples taken, however long the film.
pub const MAX_WINDOWS: usize = 8;

/// How far either way a delay is looked for, in seconds.
pub const SEARCH_REACH: f64 = 600.0;

/// The frame rates subtitles are commonly timed for. A file timed for one
/// and played at another drifts by their ratio, so those ratios are the
/// speeds worth trying; nothing else drifts in practice.
const FRAME_RATES: [f64; 3] = [24_000.0 / 1001.0, 24.0, 25.0];

/// The speeds tried: 1 first, then every ratio of two frame rates.
pub fn candidate_speeds() -> Vec<f64> {
    let mut speeds = vec![1.0];
    for a in FRAME_RATES {
        for b in FRAME_RATES {
            let ratio = a / b;
            if !speeds.iter().any(|known| (known - ratio).abs() < 1e-6) {
                speeds.push(ratio);
            }
        }
    }
    speeds
}

/// Where to listen: one window in each of `count` equal parts of the film,
/// placed where its cues are thickest (assuming, for now, that they are
/// roughly in time), so that a sample is not wasted on music or silence.
pub fn plan_windows(cues: &[Cue], duration: f64) -> Vec<Window> {
    if !(duration.is_finite() && duration > 0.0) {
        return Vec::new();
    }
    let length = WINDOW_LENGTH.min(duration);
    // About one sample every two minutes, at least three if the film is
    // long enough to hold them apart.
    let count = ((duration / 120.0).round() as usize).clamp(1, MAX_WINDOWS);
    let count = count
        .max((duration / length).floor().min(3.0) as usize)
        .max(1);
    let part = duration / count as f64;
    (0..count)
        .map(|index| {
            let from = index as f64 * part;
            let latest = (from + part - length).max(from).min(duration - length);
            let mut best = (f64::NEG_INFINITY, from + (latest - from) / 2.0);
            let mut start = from;
            while start <= latest + 1e-9 {
                let covered = speech_covered(cues, start, start + length);
                // A little preference for the middle of the part breaks ties
                // between equally busy places (for example, no cues at all).
                let centred = -((start - (from + latest) / 2.0).abs()) * 1e-6;
                if covered + centred > best.0 {
                    best = (covered + centred, start);
                }
                start += 5.0;
            }
            Window {
                start: best.1.max(0.0),
                length,
            }
        })
        .collect()
}

/// Seconds of `[from, to)` that some cue covers.
fn speech_covered(cues: &[Cue], from: f64, to: f64) -> f64 {
    cues.iter()
        .map(|cue| (cue.end.min(to) - cue.start.max(from)).max(0.0))
        .sum()
}

/// The words of a line, as they are compared: lower case, without
/// punctuation, styling tags or sound descriptions ("[door slams]").
pub fn words_of(text: &str) -> Vec<String> {
    let mut plain = String::with_capacity(text.len());
    let mut skip_until: Option<char> = None;
    for ch in text.chars() {
        if let Some(close) = skip_until {
            if ch == close {
                skip_until = None;
            }
            continue;
        }
        match ch {
            '{' => skip_until = Some('}'),
            '<' => skip_until = Some('>'),
            '[' => skip_until = Some(']'),
            '(' => skip_until = Some(')'),
            // Kept inside words ("don't" and "dont" are the same word).
            '\'' | '’' | '‘' | '`' => {}
            ch if ch.is_alphanumeric() => plain.extend(ch.to_lowercase()),
            _ => plain.push(' '),
        }
    }
    // ASS writes a line break as "\N", which is a backslash and a letter by
    // the time it gets here.
    plain
        .split_whitespace()
        .map(str::to_owned)
        .filter(|word| !word.is_empty())
        .collect()
}

/// A pair of times that say the same moment, and how much to trust it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub video: f64,
    pub cue: f64,
    /// The sample it was heard in.
    pub window: usize,
    pub weight: f64,
}

/// A phrase heard more often than this in the subtitles says nothing about
/// where it was heard.
const MAX_REPEATS: usize = 4;

/// Pairs of times from three-word phrases heard in a sample and written in
/// a cue. `heard` holds the words of each sample, in order.
pub fn word_anchors(heard: &[Vec<Word>], cues: &[Cue]) -> Vec<Anchor> {
    // Every word of the subtitles, with where in its cue it is.
    struct Written {
        word: String,
        /// When it is likely said, on the file's clock.
        at: f64,
        /// It opens its cue, whose start is when it is said.
        first: bool,
    }
    let mut written = Vec::new();
    for cue in cues {
        let words = words_of(&cue.text);
        let count = words.len() as f64;
        for (index, word) in words.into_iter().enumerate() {
            written.push(Written {
                word,
                at: cue.start + (cue.end - cue.start) * index as f64 / count,
                first: index == 0,
            });
        }
    }
    let mut phrases: std::collections::HashMap<[&str; 3], Vec<usize>> =
        std::collections::HashMap::new();
    for (index, three) in written.windows(3).enumerate() {
        phrases
            .entry([&three[0].word, &three[1].word, &three[2].word])
            .or_default()
            .push(index);
    }

    let mut anchors = Vec::new();
    for (window, words) in heard.iter().enumerate() {
        // Each heard word may carry several of the spoken words once split
        // the way the subtitles are ("o'clock", "twenty-two").
        let mut spoken: Vec<(String, f64)> = Vec::new();
        for word in words {
            for part in words_of(&word.text) {
                spoken.push((part, word.start));
            }
        }
        for three in spoken.windows(3) {
            let key = [
                three[0].0.as_str(),
                three[1].0.as_str(),
                three[2].0.as_str(),
            ];
            let Some(places) = phrases.get(&key) else {
                continue;
            };
            if places.len() > MAX_REPEATS {
                continue;
            }
            for &place in places {
                let written = &written[place];
                anchors.push(Anchor {
                    video: three[0].1,
                    cue: written.at,
                    window,
                    // A cue's start is set where its first word is said; a
                    // word inside it is only guessed at from its place.
                    weight: if written.first { 1.0 } else { 0.4 } / places.len() as f64,
                });
            }
        }
    }
    anchors
}

/// How far an anchor may be from a timing and still agree with it.
const AGREE: f64 = 0.6;

/// The timing most anchors agree on, if enough samples do.
pub fn fit_anchors(anchors: &[Anchor], windows: usize) -> Option<Found> {
    let heard = distinct_windows(anchors.iter().map(|anchor| anchor.window));
    if heard == 0 {
        return None;
    }
    // Each speed's best cluster: (agreeing samples, weight, timing).
    let mut per_speed: Vec<(usize, f64, Timing)> = Vec::new();
    for speed in candidate_speeds() {
        // Every anchor proposes a delay for this speed; the densest cluster
        // of proposals is this speed's answer.
        let mut proposals: Vec<(f64, &Anchor)> = anchors
            .iter()
            .map(|anchor| (anchor.video - anchor.cue * speed, anchor))
            .filter(|(delay, _)| delay.abs() <= SEARCH_REACH)
            .collect();
        proposals.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut best: Option<(usize, f64, Timing)> = None;
        let mut low = 0;
        for high in 0..proposals.len() {
            while proposals[high].0 - proposals[low].0 > 2.0 * AGREE {
                low += 1;
            }
            let cluster = &proposals[low..=high];
            let weight: f64 = cluster.iter().map(|(_, anchor)| anchor.weight).sum();
            let agreeing = distinct_windows(cluster.iter().map(|(_, anchor)| anchor.window));
            // Agreement across samples counts for far more than many matches
            // in one sample, which may all be one repeated mistake.
            let better = best.is_none_or(|(known_agreeing, known_weight, _)| {
                (agreeing, weight) > (known_agreeing, known_weight + 1e-9)
            });
            if better {
                let delay = weighted_median(cluster);
                best = Some((agreeing, weight, Timing { speed, delay }));
            }
        }
        if let Some(best) = best {
            per_speed.push(best);
        }
    }
    let top_agreeing = per_speed.iter().map(|(agreeing, _, _)| *agreeing).max()?;
    let top_weight = per_speed
        .iter()
        .filter(|(agreeing, _, _)| *agreeing == top_agreeing)
        .map(|(_, weight, _)| *weight)
        .fold(0.0, f64::max);
    // Speeds close to each other (24/23.976 and 25/23.976 differ by a
    // tenth of a percent) can gather nearly the same anchors; of those, the
    // one they lie closest to is the speed. 1 wins unless another is clearly
    // closer, since most subtitles do not drift at all.
    let mut contenders: Vec<(f64, Timing)> = per_speed
        .iter()
        .filter(|(agreeing, weight, _)| *agreeing == top_agreeing && *weight >= top_weight * 0.85)
        .map(|(_, _, timing)| (spread(anchors, *timing), *timing))
        .collect();
    contenders.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (closest, mut timing) = *contenders.first()?;
    if let Some((unchanged, at_one)) = contenders.iter().find(|(_, t)| t.speed == 1.0) {
        if *unchanged <= closest + 0.03 {
            timing = *at_one;
        }
    }
    let agreeing = top_agreeing;
    // Refine: every anchor that agrees with the timing found, not only those
    // in the window that found it.
    let inliers: Vec<(f64, &Anchor)> = anchors
        .iter()
        .filter(|anchor| (timing.shown_at(anchor.cue) - anchor.video).abs() <= AGREE)
        .map(|anchor| (anchor.video - anchor.cue * timing.speed, anchor))
        .collect();
    let timing = Timing {
        delay: if inliers.is_empty() {
            timing.delay
        } else {
            weighted_median(&inliers)
        },
        ..timing
    };
    trusted(agreeing, heard, windows).then_some(Found {
        timing,
        method: Method::Words,
        agreeing,
        heard,
    })
}

/// Enough samples agree to act on: three, or every sample when fewer were
/// taken (a short clip), and at least half of those in which anything was
/// heard.
fn trusted(agreeing: usize, heard: usize, windows: usize) -> bool {
    let needed = 3.min(windows.max(1));
    agreeing >= needed && agreeing * 2 >= heard
}

/// How far, on average, the anchors that agree with `timing` lie from it.
fn spread(anchors: &[Anchor], timing: Timing) -> f64 {
    let (mut sum, mut weight) = (0.0, 0.0);
    for anchor in anchors {
        let off = (timing.shown_at(anchor.cue) - anchor.video).abs();
        if off <= AGREE {
            sum += off * anchor.weight;
            weight += anchor.weight;
        }
    }
    if weight == 0.0 {
        f64::INFINITY
    } else {
        sum / weight
    }
}

fn distinct_windows(windows: impl Iterator<Item = usize>) -> usize {
    let mut seen: Vec<usize> = windows.collect();
    seen.sort_unstable();
    seen.dedup();
    seen.len()
}

fn weighted_median(proposals: &[(f64, &Anchor)]) -> f64 {
    let mut sorted: Vec<(f64, f64)> = proposals
        .iter()
        .map(|(delay, anchor)| (*delay, anchor.weight))
        .collect();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = sorted.iter().map(|(_, weight)| weight).sum();
    let mut running = 0.0;
    for (delay, weight) in &sorted {
        running += weight;
        if running >= total / 2.0 {
            return *delay;
        }
    }
    sorted.last().map_or(0.0, |(delay, _)| *delay)
}

/// The resolution speech and cues are compared at, in seconds.
const STEP: f64 = 0.1;

/// Gaps between words shorter than this are still one stretch of speech.
const BREATH: f64 = 0.4;

/// When people spoke in one sample, as on/off at each `STEP` from its start.
pub fn speech_in(window: &Window, words: &[Word]) -> Vec<bool> {
    let bins = (window.length / STEP).round() as usize;
    let mut speaking = vec![false; bins];
    let mut stretches: Vec<(f64, f64)> = Vec::new();
    for word in words {
        match stretches.last_mut() {
            Some(last) if word.start - last.1 <= BREATH => last.1 = last.1.max(word.end),
            _ => stretches.push((word.start, word.end)),
        }
    }
    for (from, to) in stretches {
        // A hair added so that a time on a boundary is not taken for the
        // bin before it.
        let first = ((from - window.start) / STEP + 1e-6).floor().max(0.0) as usize;
        let last = ((to - window.start) / STEP).ceil().max(0.0) as usize;
        for bin in speaking.iter_mut().take(last.min(bins)).skip(first) {
            *bin = true;
        }
    }
    speaking
}

/// A sample that is speech for less than this share of its length, or more
/// than the rest, says too little about where cues should be.
const MIN_SPEECH_SHARE: f64 = 0.08;

/// The timing at which cues are up while people speak, and down while they
/// do not, across all the samples. Works whatever language either is in.
pub fn fit_speech(samples: &[(Window, Vec<bool>)], cues: &[Cue]) -> Option<Found> {
    let usable: Vec<&(Window, Vec<bool>)> = samples
        .iter()
        .filter(|(_, speaking)| {
            let share =
                speaking.iter().filter(|on| **on).count() as f64 / speaking.len().max(1) as f64;
            (MIN_SPEECH_SHARE..=1.0 - MIN_SPEECH_SHARE).contains(&share)
        })
        .collect();
    let heard = usable.len();
    if heard == 0 || cues.is_empty() {
        return None;
    }
    // Whether a cue is up, at each `STEP / 2` of the file's clock.
    let fine = STEP / 2.0;
    let last = cues.iter().map(|cue| cue.end).fold(0.0, f64::max);
    let mut up = vec![false; (last / fine).ceil() as usize + 1];
    for cue in cues {
        let from = (cue.start.max(0.0) / fine).floor() as usize;
        let to = ((cue.end / fine).ceil() as usize).min(up.len());
        for bin in up.iter_mut().take(to).skip(from) {
            *bin = true;
        }
    }
    let cue_up = |cue: f64| -> bool {
        if cue < 0.0 {
            return false;
        }
        up.get((cue / fine) as usize).copied().unwrap_or(false)
    };

    let steps = (SEARCH_REACH / STEP).round() as i64;
    let mut best: Option<(f64, Timing)> = None;
    let mut per_speed: Vec<(f64, Vec<f64>)> = Vec::new();
    for speed in candidate_speeds() {
        let mut scores = Vec::with_capacity((2 * steps + 1) as usize);
        for step in -steps..=steps {
            let delay = step as f64 * STEP;
            let mut agree = 0.0;
            let mut total = 0.0;
            for (window, speaking) in &usable {
                for (index, on) in speaking.iter().enumerate() {
                    let video = window.start + index as f64 * STEP;
                    let cue = (video - delay) / speed;
                    agree += if *on == cue_up(cue) { 1.0 } else { -1.0 };
                    total += 1.0;
                }
            }
            let score = agree / total;
            scores.push(score);
            if best.is_none_or(|(known, _)| score > known + 1e-9) {
                best = Some((score, Timing { speed, delay }));
            }
        }
        per_speed.push((speed, scores));
    }
    let (peak, timing) = best?;
    // The peak must stand clear of every other way of lining them up: the
    // best score at least 3 seconds away, at any speed.
    let mut runner_up = f64::NEG_INFINITY;
    for (speed, scores) in &per_speed {
        for (index, score) in scores.iter().enumerate() {
            if *score <= runner_up {
                continue;
            }
            let delay = (index as i64 - steps) as f64 * STEP;
            // Nearby, or another speed placing the cues nearly where this one
            // does at every sample: the same answer, not a rival.
            if !placements_close(*speed, delay, timing, &usable) {
                runner_up = *score;
            }
        }
    }
    tracing::debug!(peak, runner_up, ?timing, "speech pattern");
    if peak < 0.2 || peak - runner_up < 0.06 {
        return None;
    }
    // Which samples on their own agree with the timing found.
    let agreeing = usable
        .iter()
        .filter(|(window, speaking)| {
            let at = |delay: f64| sample_score(window, speaking, timing.speed, delay, &cue_up);
            let here = at(timing.delay);
            // Compared with the same sample slid well away.
            let elsewhere = [-20.0, -10.0, 10.0, 20.0]
                .iter()
                .map(|shift| at(timing.delay + shift))
                .fold(f64::NEG_INFINITY, f64::max);
            here > elsewhere
        })
        .count();
    trusted(agreeing, heard, samples.len()).then_some(Found {
        timing,
        method: Method::Speech,
        agreeing,
        heard,
    })
}

fn sample_score(
    window: &Window,
    speaking: &[bool],
    speed: f64,
    delay: f64,
    cue_up: &impl Fn(f64) -> bool,
) -> f64 {
    let agree: f64 = speaking
        .iter()
        .enumerate()
        .map(|(index, on)| {
            let video = window.start + index as f64 * STEP;
            if *on == cue_up((video - delay) / speed) {
                1.0
            } else {
                -1.0
            }
        })
        .sum();
    agree / speaking.len().max(1) as f64
}

/// Two timings put the cues within 3 seconds of each other at every sample.
fn placements_close(
    speed: f64,
    delay: f64,
    other: Timing,
    samples: &[&(Window, Vec<bool>)],
) -> bool {
    samples.iter().all(|(window, _)| {
        let middle = window.start + window.length / 2.0;
        let cue_a = (middle - delay) / speed;
        let cue_b = (middle - other.delay) / other.speed;
        (cue_a - cue_b).abs() < 3.0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A film's worth of cues, every 4 seconds a line of distinct words.
    fn script(duration: f64) -> Vec<Cue> {
        let mut cues = Vec::new();
        let mut at = 5.0;
        let mut n = 0;
        let mut seed: u64 = 7;
        while at + 3.0 < duration {
            cues.push(Cue {
                start: at,
                end: at + 2.5,
                text: format!("line{n} alpha{n} bravo{n} charlie{n}"),
            });
            // Uneven gaps, as real dialogue has, so that no slide of the
            // pattern matches it again.
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            at += 3.0 + (seed >> 40) as f64 / (1u64 << 24) as f64 * 6.0;
            n += 1;
        }
        cues
    }

    /// What would be heard in `window` if the cues were shown with `truth`:
    /// each cue's words, evenly through the time it is up.
    fn hear(cues: &[Cue], window: &Window, truth: Timing) -> Vec<Word> {
        let mut words = Vec::new();
        for cue in cues {
            let start = truth.shown_at(cue.start);
            let end = truth.shown_at(cue.end);
            if start < window.start || start > window.end() {
                continue;
            }
            let parts = words_of(&cue.text);
            let each = (end - start) / parts.len() as f64;
            for (index, part) in parts.iter().enumerate() {
                let from = start + each * index as f64;
                words.push(Word {
                    start: from,
                    end: from + each * 0.9,
                    text: part.clone(),
                });
            }
        }
        words
    }

    fn found_by_words(cues: &[Cue], duration: f64, truth: Timing) -> Option<Found> {
        let windows = plan_windows(cues, duration);
        let heard: Vec<Vec<Word>> = windows.iter().map(|w| hear(cues, w, truth)).collect();
        fit_anchors(&word_anchors(&heard, cues), windows.len())
    }

    fn found_by_speech(cues: &[Cue], duration: f64, truth: Timing) -> Option<Found> {
        let windows = plan_windows(cues, duration);
        let samples: Vec<(Window, Vec<bool>)> = windows
            .iter()
            .map(|w| (*w, speech_in(w, &hear(cues, w, truth))))
            .collect();
        fit_speech(&samples, cues)
    }

    fn close(found: Timing, truth: Timing) {
        assert!(
            (found.speed - truth.speed).abs() < 1e-6,
            "speed {found:?} vs {truth:?}"
        );
        assert!(
            (found.delay - truth.delay).abs() < 0.3,
            "delay {found:?} vs {truth:?}"
        );
    }

    #[test]
    fn words_are_compared_without_case_punctuation_or_styling() {
        assert_eq!(
            words_of("{\\an8}<i>Don't</i> GO, Sam!\\N[door slams] - Why?"),
            vec!["dont", "go", "sam", "n", "why"]
        );
        assert_eq!(words_of("¿Qué pasó, Mamá?"), vec!["qué", "pasó", "mamá"]);
    }

    #[test]
    fn speeds_tried_start_with_one_and_cover_the_frame_rate_ratios() {
        let speeds = candidate_speeds();
        assert_eq!(speeds[0], 1.0);
        assert_eq!(speeds.len(), 7);
        assert!(speeds
            .iter()
            .any(|s| (s - 25.0 / (24_000.0 / 1001.0)).abs() < 1e-9));
        assert!(speeds.iter().any(|s| (s - 24.0 / 25.0).abs() < 1e-9));
    }

    #[test]
    fn samples_are_spread_over_the_film_and_land_on_dialogue() {
        let mut cues = script(7200.0);
        // A long silent stretch at the start of the second part.
        cues.retain(|cue| !(900.0..1500.0).contains(&cue.start));
        let windows = plan_windows(&cues, 7200.0);
        assert_eq!(windows.len(), MAX_WINDOWS);
        for (index, window) in windows.iter().enumerate() {
            let part = 7200.0 / MAX_WINDOWS as f64;
            assert!(window.start >= index as f64 * part - 1e-9);
            assert!(window.end() <= (index + 1) as f64 * part + 1e-9);
            assert!(
                speech_covered(&cues, window.start, window.end()) > 10.0,
                "{window:?}"
            );
        }
    }

    #[test]
    fn a_short_clip_gets_as_many_samples_as_fit() {
        assert_eq!(
            plan_windows(&[], 20.0),
            vec![Window {
                start: 0.0,
                length: 20.0
            }]
        );
        assert_eq!(plan_windows(&[], 100.0).len(), 3);
        assert!(plan_windows(&[], f64::NAN).is_empty());
    }

    #[test]
    fn finds_a_plain_delay_from_words() {
        let cues = script(5400.0);
        for delay in [-42.7, -2.3, 0.0, 1.5, 95.0] {
            let truth = Timing { speed: 1.0, delay };
            let found = found_by_words(&cues, 5400.0, truth).expect("found");
            assert_eq!(found.method, Method::Words);
            close(found.timing, truth);
            assert_eq!(found.agreeing, found.heard);
        }
    }

    #[test]
    fn finds_frame_rate_drift_from_words() {
        let cues = script(6000.0);
        for speed in [
            24.0 / 25.0,
            25.0 / (24_000.0 / 1001.0),
            24_000.0 / 1001.0 / 24.0,
        ] {
            let truth = Timing { speed, delay: 3.2 };
            let found = found_by_words(&cues, 6000.0, truth).expect("found");
            close(found.timing, truth);
        }
    }

    #[test]
    fn a_few_wrong_matches_do_not_move_the_answer() {
        let cues = script(3600.0);
        let truth = Timing {
            speed: 1.0,
            delay: -4.0,
        };
        let windows = plan_windows(&cues, 3600.0);
        let mut heard: Vec<Vec<Word>> = windows.iter().map(|w| hear(&cues, w, truth)).collect();
        // One sample misheard as a line from far away in the film.
        let stray = &cues[cues.len() / 2];
        heard[0] = words_of(&stray.text)
            .into_iter()
            .enumerate()
            .map(|(i, text)| Word {
                start: windows[0].start + 2.0 + i as f64 * 0.4,
                end: windows[0].start + 2.3 + i as f64 * 0.4,
                text,
            })
            .collect();
        let found = fit_anchors(&word_anchors(&heard, &cues), windows.len()).expect("found");
        close(found.timing, truth);
        assert_eq!(found.agreeing, windows.len() - 1);
    }

    #[test]
    fn nothing_matching_is_no_answer() {
        let cues = script(3600.0);
        let windows = plan_windows(&cues, 3600.0);
        let heard: Vec<Vec<Word>> = windows
            .iter()
            .map(|w| {
                (0..40)
                    .map(|i| Word {
                        start: w.start + i as f64 * 0.5,
                        end: w.start + i as f64 * 0.5 + 0.3,
                        text: format!("other{i}"),
                    })
                    .collect()
            })
            .collect();
        assert_eq!(
            fit_anchors(&word_anchors(&heard, &cues), windows.len()),
            None
        );
        assert_eq!(fit_anchors(&[], 8), None);
    }

    #[test]
    fn one_sample_agreeing_is_not_enough() {
        let cues = script(3600.0);
        let truth = Timing {
            speed: 1.0,
            delay: 7.0,
        };
        let windows = plan_windows(&cues, 3600.0);
        let heard: Vec<Vec<Word>> = windows
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if i == 2 {
                    hear(&cues, w, truth)
                } else {
                    Vec::new()
                }
            })
            .collect();
        assert_eq!(
            fit_anchors(&word_anchors(&heard, &cues), windows.len()),
            None
        );
    }

    #[test]
    fn finds_a_delay_from_when_people_speak_alone() {
        let cues = script(5400.0);
        for delay in [-12.4, 0.0, 2.0, 61.3] {
            let truth = Timing { speed: 1.0, delay };
            let found = found_by_speech(&cues, 5400.0, truth).expect("found");
            assert_eq!(found.method, Method::Speech);
            close(found.timing, truth);
        }
    }

    #[test]
    fn finds_drift_from_when_people_speak_alone() {
        let cues = script(5400.0);
        let truth = Timing {
            speed: 25.0 / (24_000.0 / 1001.0),
            delay: -1.0,
        };
        let found = found_by_speech(&cues, 5400.0, truth).expect("found");
        close(found.timing, truth);
    }

    #[test]
    fn silence_is_no_answer() {
        let cues = script(3600.0);
        let windows = plan_windows(&cues, 3600.0);
        let samples: Vec<(Window, Vec<bool>)> =
            windows.iter().map(|w| (*w, speech_in(w, &[]))).collect();
        assert_eq!(fit_speech(&samples, &cues), None);
    }

    #[test]
    fn speech_is_marked_where_words_are_with_breaths_filled() {
        let window = Window {
            start: 100.0,
            length: 2.0,
        };
        let words = [
            Word {
                start: 100.2,
                end: 100.5,
                text: "a".into(),
            },
            Word {
                start: 100.7,
                end: 101.0,
                text: "b".into(),
            },
            Word {
                start: 101.6,
                end: 101.8,
                text: "c".into(),
            },
        ];
        let speaking = speech_in(&window, &words);
        let on: Vec<usize> = (0..speaking.len()).filter(|i| speaking[*i]).collect();
        assert_eq!(on, vec![2, 3, 4, 5, 6, 7, 8, 9, 16, 17]);
    }
}
