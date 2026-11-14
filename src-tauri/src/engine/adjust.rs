//! What can be adjusted about the picture, the sound and the subtitles, as
//! plain values, and what each of them comes to in mpv's terms.
//!
//! Nothing here talks to mpv. The player applies what these functions
//! return; the settings store the values; the interface edits them. That
//! keeps the arithmetic (a strength of 40 is which thresholds? a centred
//! crop to 2.35:1 is which rectangle?) in one place that can be tested
//! without a player.

use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

// ---------------------------------------------------------------- picture

/// The picture tuner. These stay until they are changed: they are about the
/// room and the screen as much as about any one film.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    /// −100 to 100; 0 leaves the picture as it is. The same for the next four.
    pub brightness: i32,
    pub contrast: i32,
    pub saturation: i32,
    pub gamma: i32,
    pub hue: i32,
    /// 0 to 100; 0 is off.
    pub sharpness: i32,
    /// 0 to 100; 0 is off.
    pub noise_reduction: i32,
}

/// The name mpv's video filter chain knows the noise reduction by.
pub const DENOISE_LABEL: &str = "lumen-denoise";
pub const MIRROR_LABEL: &str = "lumen-mirror";
pub const FLIP_LABEL: &str = "lumen-flip";

impl Picture {
    pub fn sanitised(self) -> Self {
        Self {
            brightness: self.brightness.clamp(-100, 100),
            contrast: self.contrast.clamp(-100, 100),
            saturation: self.saturation.clamp(-100, 100),
            gamma: self.gamma.clamp(-100, 100),
            hue: self.hue.clamp(-100, 100),
            sharpness: self.sharpness.clamp(0, 100),
            noise_reduction: self.noise_reduction.clamp(0, 100),
        }
    }

    /// mpv's own five levels, by the names of their properties.
    pub fn levels(&self) -> [(&'static str, i64); 5] {
        [
            ("brightness", i64::from(self.brightness)),
            ("contrast", i64::from(self.contrast)),
            ("saturation", i64::from(self.saturation)),
            ("gamma", i64::from(self.gamma)),
            ("hue", i64::from(self.hue)),
        ]
    }

    /// The renderer's unsharp mask: 0 is off, and by 1.5 edges ring.
    pub fn sharpen(&self) -> f64 {
        f64::from(self.sharpness.clamp(0, 100)) / 100.0 * 1.5
    }

    /// The filter that takes the noise out, or `None` when it is off.
    ///
    /// It averages each pixel with the same pixel in the frames around it,
    /// wherever they differ by less than a threshold: grain goes, movement
    /// stays. Stronger means a higher threshold and more frames. (This build
    /// of FFmpeg is LGPL, which leaves out `hqdn3d`.)
    pub fn denoise(&self) -> Option<String> {
        let strength = f64::from(self.noise_reduction.clamp(0, 100)) / 100.0;
        if strength <= 0.0 {
            return None;
        }
        let a = 0.02 + 0.10 * strength;
        let b = 2.0 * a;
        let frames = if strength < 0.34 {
            5
        } else if strength < 0.67 {
            7
        } else {
            9
        };
        Some(format!(
            "atadenoise=0a={a:.3}:0b={b:.3}:1a={a:.3}:1b={b:.3}:2a={a:.3}:2b={b:.3}:s={frames}"
        ))
    }
}

// ------------------------------------------------------------------ shape

/// A shape, as two whole numbers: 16:9, 235:100.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Ratio {
    pub width: u32,
    pub height: u32,
}

impl Ratio {
    pub fn value(self) -> Option<f64> {
        (self.width > 0 && self.height > 0).then(|| f64::from(self.width) / f64::from(self.height))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Deinterlace {
    #[default]
    Off,
    /// Only frames the file marks as interlaced.
    Auto,
    On,
}

impl Deinterlace {
    pub fn as_mpv(self) -> &'static str {
        match self {
            Self::Off => "no",
            Self::Auto => "auto",
            Self::On => "yes",
        }
    }
}

/// How the picture is turned, cut and stretched. These belong to the file
/// that is open: a phone video filmed sideways says nothing about the next
/// film.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    /// The shape to show the picture in; `None` is the file's own.
    pub aspect: Option<Ratio>,
    /// Cut the picture, about its centre, to this shape; `None` shows all of it.
    pub crop: Option<Ratio>,
    /// 1 fits the picture in the window; 2 shows it twice as large.
    #[specta(type = Number)]
    pub zoom: f64,
    /// Quarter turns clockwise, 0 to 3.
    pub turns: u8,
    /// Top to bottom.
    pub flipped: bool,
    /// Left to right.
    pub mirrored: bool,
    pub deinterlace: Deinterlace,
}

pub const MIN_ZOOM: f64 = 0.5;
pub const MAX_ZOOM: f64 = 4.0;

impl Default for Shape {
    fn default() -> Self {
        Self {
            aspect: None,
            crop: None,
            zoom: 1.0,
            turns: 0,
            flipped: false,
            mirrored: false,
            deinterlace: Deinterlace::Off,
        }
    }
}

impl Shape {
    pub fn sanitised(self) -> Self {
        Self {
            aspect: self.aspect.filter(|ratio| ratio.value().is_some()),
            crop: self.crop.filter(|ratio| ratio.value().is_some()),
            zoom: if self.zoom.is_finite() {
                self.zoom.clamp(MIN_ZOOM, MAX_ZOOM)
            } else {
                1.0
            },
            turns: self.turns % 4,
            ..self
        }
    }

    /// mpv's `video-aspect-override`.
    pub fn aspect_override(&self) -> String {
        match self.aspect {
            Some(Ratio { width, height }) => format!("{width}:{height}"),
            None => "no".to_owned(),
        }
    }

    /// mpv's `video-zoom`, which counts in doublings.
    pub fn zoom_steps(&self) -> f64 {
        self.zoom.clamp(MIN_ZOOM, MAX_ZOOM).log2()
    }

    /// mpv's `video-rotate`, in degrees.
    pub fn degrees(&self) -> i64 {
        i64::from(self.turns % 4) * 90
    }
}

/// What mpv says of the frames it is decoding, as far as cropping needs it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    /// Stored size, in pixels.
    pub width: u32,
    pub height: u32,
    /// How much wider than tall each pixel is shown.
    pub pixel_aspect: f64,
    /// The picture is shown on its side: turned a quarter or three, by the
    /// file's own say-so and the user's together.
    pub sideways: bool,
}

/// The rectangle of stored pixels, `(width, height, x, y)`, that shows as
/// `shape` when cut about the centre of the frame: mpv's `video-crop`.
/// `None` if the frame already has that shape, or cannot be measured.
///
/// The cut is made in the file's pixels, before they are stretched to their
/// shown shape and before the picture is turned, so both are undone here.
pub fn crop_rect(shape: Ratio, frame: Frame) -> Option<(u32, u32, u32, u32)> {
    let wanted = shape.value()?;
    if frame.width == 0 || frame.height == 0 || !frame.pixel_aspect.is_finite() {
        return None;
    }
    let pixel_aspect = if frame.pixel_aspect > 0.0 {
        frame.pixel_aspect
    } else {
        1.0
    };
    // The shape the stored rectangle must have, in stored pixels.
    let stored = if frame.sideways { 1.0 / wanted } else { wanted } / pixel_aspect;
    let (full_w, full_h) = (f64::from(frame.width), f64::from(frame.height));
    let current = full_w / full_h;
    if (current - stored).abs() / stored < 0.005 {
        return None;
    }
    // Even numbers: chroma is stored at half the resolution.
    let even = |value: f64| ((value / 2.0).round() as u32 * 2).max(2);
    let (width, height) = if current > stored {
        (even(full_h * stored).min(frame.width), frame.height)
    } else {
        (frame.width, even(full_w / stored).min(frame.height))
    };
    let x = (frame.width - width) / 2;
    let y = (frame.height - height) / 2;
    Some((width, height, x, y))
}

/// The size the picture is shown at once `crop` has cut it, given the size it
/// is shown at uncut (already turned): the window takes this shape. A crop
/// as wide as the picture, or none, leaves it as it is.
pub fn cropped_size(width: i32, height: i32, crop: Option<Ratio>) -> (i32, i32) {
    let Some(wanted) = crop.and_then(Ratio::value) else {
        return (width, height);
    };
    if width <= 0 || height <= 0 {
        return (width, height);
    }
    let current = f64::from(width) / f64::from(height);
    if (current - wanted).abs() / wanted < 0.005 {
        (width, height)
    } else if current > wanted {
        // Narrower than the picture: its sides are cut.
        (((f64::from(height) * wanted).round() as i32).max(1), height)
    } else {
        // Wider: its top and bottom are cut.
        (width, ((f64::from(width) / wanted).round() as i32).max(1))
    }
}

// ------------------------------------------------------------- equaliser

/// The centre of each of the equaliser's ten bands, in hertz: one to an
/// octave.
pub const BANDS: [u32; 10] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/// The most a band can be raised or lowered, in decibels.
pub const MAX_GAIN: f64 = 12.0;
/// The name mpv's audio filter chain knows the equaliser by.
pub const EQUALISER_LABEL: &str = "lumen-eq";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Equaliser {
    pub enabled: bool,
    /// One gain for each of `BANDS`, in decibels.
    #[specta(type = Vec<Number>)]
    pub gains: Vec<f64>,
}

impl Default for Equaliser {
    fn default() -> Self {
        Self {
            enabled: false,
            gains: vec![0.0; BANDS.len()],
        }
    }
}

impl Equaliser {
    pub fn sanitised(mut self) -> Self {
        self.gains.resize(BANDS.len(), 0.0);
        for gain in &mut self.gains {
            *gain = if gain.is_finite() {
                // Tenths of a decibel are finer than anyone hears.
                (gain.clamp(-MAX_GAIN, MAX_GAIN) * 10.0).round() / 10.0
            } else {
                0.0
            };
        }
        self
    }

    /// The gains in effect: all level while the equaliser is off.
    pub fn in_effect(&self) -> Vec<f64> {
        (0..BANDS.len())
            .map(|band| {
                if self.enabled {
                    self.gains.get(band).copied().unwrap_or(0.0)
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// How far everything is turned down before the bands, in decibels (so,
    /// never positive): as much as the most any band is raised, so that
    /// raising a band cannot push the sound past full scale.
    pub fn headroom(&self) -> f64 {
        -self
            .in_effect()
            .into_iter()
            .fold(0.0_f64, |most, gain| most.max(gain))
    }

    /// The whole chain, as one labelled filter for mpv's `af`.
    pub fn chain(&self) -> String {
        let bands: Vec<String> = self
            .in_effect()
            .into_iter()
            .zip(BANDS)
            .enumerate()
            .map(|(index, (gain, hertz))| {
                format!("equalizer@b{index}=f={hertz}:t=o:w=1:g={gain:.1}")
            })
            .collect();
        format!(
            "@{EQUALISER_LABEL}:lavfi=[volume@pre=volume={:.1}dB,{}]",
            self.headroom(),
            bands.join(",")
        )
    }
}

/// A set of gains with a name, saved by the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EqualiserPreset {
    pub name: String,
    #[specta(type = Vec<Number>)]
    pub gains: Vec<f64>,
}

/// A set of picture adjustments with a name, saved by the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PicturePreset {
    pub name: String,
    pub picture: Picture,
}

// ---------------------------------------------------------------- output

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Channels {
    /// What the output device says it has.
    #[default]
    Auto,
    Stereo,
    Surround51,
    Surround71,
}

impl Channels {
    pub fn as_mpv(self) -> &'static str {
        match self {
            Self::Auto => "auto-safe",
            Self::Stereo => "stereo",
            Self::Surround51 => "5.1",
            Self::Surround71 => "7.1",
        }
    }
}

/// The formats handed on undecoded while passthrough is on: the two every
/// receiver takes, over optical as well as HDMI.
pub const PASSTHROUGH: &str = "ac3,dts";

// -------------------------------------------------------------- subtitles

/// How subtitles look. For subtitles that are only text; ones that carry
/// their own styling keep it unless `restyle` says otherwise.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStyle {
    /// A font family installed on this Mac; `None` is the system's own.
    pub font: Option<String>,
    /// 1 is the usual size.
    #[specta(type = Number)]
    pub scale: f64,
    pub bold: bool,
    /// `#RRGGBB`.
    pub colour: String,
    pub outline_colour: String,
    /// The outline's thickness, 0 to 4; 0 is none.
    #[specta(type = Number)]
    pub outline: f64,
    /// How opaque the box behind the words is, 0 to 1; 0 is no box.
    #[specta(type = Number)]
    pub background: f64,
    /// How far up from the bottom of the picture they stand, 0 to 100.
    #[specta(type = Number)]
    pub raise: f64,
    /// Use this style for subtitles that bring their own, too.
    pub restyle: bool,
}

pub const MIN_SUBTITLE_SCALE: f64 = 0.5;
pub const MAX_SUBTITLE_SCALE: f64 = 2.5;
pub const MAX_OUTLINE: f64 = 4.0;

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font: None,
            scale: 1.0,
            bold: false,
            colour: "#FFFFFF".to_owned(),
            outline_colour: "#000000".to_owned(),
            outline: 1.5,
            background: 0.0,
            raise: 0.0,
            restyle: false,
        }
    }
}

/// `#RRGGBB`, in capitals, or `None` if `text` is not a colour.
pub fn colour(text: &str) -> Option<String> {
    let digits = text.trim().strip_prefix('#')?;
    (digits.len() == 6 && digits.chars().all(|digit| digit.is_ascii_hexdigit()))
        .then(|| format!("#{}", digits.to_ascii_uppercase()))
}

fn within(value: f64, low: f64, high: f64, otherwise: f64) -> f64 {
    if value.is_finite() {
        value.clamp(low, high)
    } else {
        otherwise
    }
}

impl SubtitleStyle {
    pub fn sanitised(self) -> Self {
        let fallback = Self::default();
        Self {
            font: self
                .font
                .map(|font| font.trim().to_owned())
                .filter(|font| !font.is_empty() && font.len() <= 200),
            scale: within(self.scale, MIN_SUBTITLE_SCALE, MAX_SUBTITLE_SCALE, 1.0),
            colour: colour(&self.colour).unwrap_or(fallback.colour),
            outline_colour: colour(&self.outline_colour).unwrap_or(fallback.outline_colour),
            outline: within(self.outline, 0.0, MAX_OUTLINE, fallback.outline),
            background: within(self.background, 0.0, 1.0, 0.0),
            raise: within(self.raise, 0.0, 100.0, 0.0),
            ..self
        }
    }

    /// The style as mpv's properties, in the order they are to be set.
    pub fn properties(&self) -> Vec<(&'static str, String)> {
        // mpv writes a colour as #AARRGGBB.
        let opaque = |colour: &str| format!("#FF{}", colour.trim_start_matches('#'));
        let boxed = self.background > 0.0;
        let alpha = (self.background.clamp(0.0, 1.0) * 255.0).round() as u8;
        vec![
            (
                "sub-font",
                self.font.clone().unwrap_or_else(|| "sans-serif".to_owned()),
            ),
            ("sub-scale", format!("{:.3}", self.scale)),
            ("sub-bold", if self.bold { "yes" } else { "no" }.to_owned()),
            ("sub-color", opaque(&self.colour)),
            ("sub-outline-color", opaque(&self.outline_colour)),
            ("sub-outline-size", format!("{:.2}", self.outline)),
            (
                "sub-border-style",
                if boxed {
                    "background-box"
                } else {
                    "outline-and-shadow"
                }
                .to_owned(),
            ),
            ("sub-back-color", format!("#{alpha:02X}000000")),
            // With a box, this is how far it reaches past the words.
            (
                "sub-shadow-offset",
                if boxed { "4" } else { "0" }.to_owned(),
            ),
            ("sub-pos", format!("{:.1}", 100.0 - self.raise)),
            (
                "sub-ass-override",
                if self.restyle { "force" } else { "yes" }.to_owned(),
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_left_alone_asks_for_nothing() {
        let picture = Picture::default();
        assert!(picture.levels().iter().all(|(_, level)| *level == 0));
        assert_eq!(picture.sharpen(), 0.0);
        assert_eq!(picture.denoise(), None);
    }

    #[test]
    fn levels_keep_within_what_mpv_takes() {
        let picture = Picture {
            brightness: 400,
            contrast: -400,
            sharpness: -3,
            noise_reduction: 250,
            ..Picture::default()
        }
        .sanitised();
        assert_eq!(picture.brightness, 100);
        assert_eq!(picture.contrast, -100);
        assert_eq!(picture.sharpness, 0);
        assert_eq!(picture.noise_reduction, 100);
        assert_eq!(picture.levels()[0], ("brightness", 100));
    }

    #[test]
    fn stronger_noise_reduction_means_higher_thresholds_and_more_frames() {
        let at = |strength| {
            Picture {
                noise_reduction: strength,
                ..Picture::default()
            }
            .denoise()
            .unwrap()
        };
        assert_eq!(
            at(10),
            "atadenoise=0a=0.030:0b=0.060:1a=0.030:1b=0.060:2a=0.030:2b=0.060:s=5"
        );
        assert!(at(50).ends_with(":s=7"));
        assert_eq!(
            at(100),
            "atadenoise=0a=0.120:0b=0.240:1a=0.120:1b=0.240:2a=0.120:2b=0.240:s=9"
        );
    }

    #[test]
    fn a_shape_becomes_mpvs_own_terms() {
        let shape = Shape {
            aspect: Some(Ratio {
                width: 235,
                height: 100,
            }),
            zoom: 2.0,
            turns: 7,
            ..Shape::default()
        }
        .sanitised();
        assert_eq!(shape.aspect_override(), "235:100");
        assert_eq!(shape.zoom_steps(), 1.0);
        assert_eq!(shape.turns, 3);
        assert_eq!(shape.degrees(), 270);
        assert_eq!(Shape::default().aspect_override(), "no");
        assert_eq!(Shape::default().zoom_steps(), 0.0);
    }

    #[test]
    fn a_shape_from_outside_is_made_usable() {
        let shape = Shape {
            aspect: Some(Ratio {
                width: 16,
                height: 0,
            }),
            zoom: f64::NAN,
            ..Shape::default()
        }
        .sanitised();
        assert_eq!(shape.aspect, None);
        assert_eq!(shape.zoom, 1.0);
        assert_eq!(
            Shape {
                zoom: 90.0,
                ..Shape::default()
            }
            .sanitised()
            .zoom,
            MAX_ZOOM
        );
    }

    const HD: Frame = Frame {
        width: 1920,
        height: 1080,
        pixel_aspect: 1.0,
        sideways: false,
    };
    const SCOPE: Ratio = Ratio {
        width: 240,
        height: 100,
    };

    #[test]
    fn crops_about_the_centre_to_the_shape_asked_for() {
        // Letterboxed 2.40:1 in a 16:9 frame: the bars go, top and bottom.
        assert_eq!(crop_rect(SCOPE, HD), Some((1920, 800, 0, 140)));
        // 4:3 out of 16:9: the sides go.
        let four_three = Ratio {
            width: 4,
            height: 3,
        };
        assert_eq!(crop_rect(four_three, HD), Some((1440, 1080, 240, 0)));
        // Already that shape: nothing to cut.
        let sixteen_nine = Ratio {
            width: 16,
            height: 9,
        };
        assert_eq!(crop_rect(sixteen_nine, HD), None);
    }

    #[test]
    fn crops_in_stored_pixels_whatever_their_shape_and_however_it_is_turned() {
        // A DVD frame: 720×576 shown as 16:9, each pixel 1.42 times as wide
        // as tall. Cut to 4:3, three quarters of its width is left.
        let dvd = Frame {
            width: 720,
            height: 576,
            pixel_aspect: (16.0 / 9.0) / (720.0 / 576.0),
            sideways: false,
        };
        let four_three = Ratio {
            width: 4,
            height: 3,
        };
        assert_eq!(crop_rect(four_three, dvd), Some((540, 576, 90, 0)));
        // A phone video stored as 1920×1080 and shown on its side: a 9:16
        // picture. Cut to 3:4 as it is shown, which is 4:3 as it is stored.
        let phone = Frame {
            sideways: true,
            ..HD
        };
        let three_four = Ratio {
            width: 3,
            height: 4,
        };
        assert_eq!(crop_rect(three_four, phone), Some((1440, 1080, 240, 0)));
    }

    #[test]
    fn a_frame_that_cannot_be_measured_is_not_cropped() {
        let nothing = Frame {
            width: 0,
            height: 0,
            ..HD
        };
        assert_eq!(crop_rect(SCOPE, nothing), None);
        let no_shape = Ratio {
            width: 0,
            height: 9,
        };
        assert_eq!(crop_rect(no_shape, HD), None);
    }

    #[test]
    fn the_equaliser_is_one_chain_of_ten_bands_behind_its_headroom() {
        let mut equaliser = Equaliser {
            enabled: true,
            ..Equaliser::default()
        };
        equaliser.gains[0] = 6.0;
        equaliser.gains[9] = -3.0;
        let chain = equaliser.chain();
        assert!(chain.starts_with("@lumen-eq:lavfi=[volume@pre=volume=-6.0dB,"));
        assert!(chain.contains("equalizer@b0=f=31:t=o:w=1:g=6.0,"));
        assert!(chain.ends_with("equalizer@b9=f=16000:t=o:w=1:g=-3.0]"));
        assert_eq!(chain.matches("equalizer@").count(), 10);
    }

    #[test]
    fn switched_off_it_is_level_and_takes_nothing_off() {
        let mut equaliser = Equaliser::default();
        equaliser.gains[4] = 9.0;
        assert_eq!(equaliser.in_effect(), vec![0.0; 10]);
        assert_eq!(equaliser.headroom(), 0.0);
        equaliser.enabled = true;
        assert_eq!(equaliser.in_effect()[4], 9.0);
        assert_eq!(equaliser.headroom(), -9.0);
        // Only cuts: nothing can clip, so nothing is taken off.
        equaliser.gains = vec![-6.0; 10];
        assert_eq!(equaliser.headroom(), 0.0);
    }

    #[test]
    fn gains_from_outside_are_ten_finite_numbers_within_range() {
        let equaliser = Equaliser {
            enabled: true,
            gains: vec![40.0, f64::NAN, -40.0, 1.26],
        }
        .sanitised();
        assert_eq!(equaliser.gains.len(), 10);
        assert_eq!(&equaliser.gains[..4], [12.0, 0.0, -12.0, 1.3]);
    }

    #[test]
    fn reads_a_colour_and_refuses_anything_else() {
        assert_eq!(colour("#ffee00").as_deref(), Some("#FFEE00"));
        assert_eq!(colour(" #A1b2C3 ").as_deref(), Some("#A1B2C3"));
        assert_eq!(colour("ffee00"), None);
        assert_eq!(colour("#ffee0"), None);
        assert_eq!(colour("#ffee0g"), None);
    }

    fn property(style: &SubtitleStyle, name: &str) -> String {
        style
            .properties()
            .into_iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
            .unwrap_or_default()
    }

    #[test]
    fn the_usual_subtitle_style_is_white_with_a_thin_black_outline_at_the_bottom() {
        let style = SubtitleStyle::default();
        assert_eq!(property(&style, "sub-font"), "sans-serif");
        assert_eq!(property(&style, "sub-color"), "#FFFFFFFF");
        assert_eq!(property(&style, "sub-outline-color"), "#FF000000");
        assert_eq!(property(&style, "sub-outline-size"), "1.50");
        assert_eq!(property(&style, "sub-border-style"), "outline-and-shadow");
        assert_eq!(property(&style, "sub-pos"), "100.0");
        assert_eq!(property(&style, "sub-ass-override"), "yes");
    }

    #[test]
    fn a_background_is_a_box_as_opaque_as_asked() {
        let style = SubtitleStyle {
            background: 0.5,
            raise: 12.0,
            restyle: true,
            font: Some("Avenir Next".to_owned()),
            ..SubtitleStyle::default()
        };
        assert_eq!(property(&style, "sub-border-style"), "background-box");
        assert_eq!(property(&style, "sub-back-color"), "#80000000");
        assert_eq!(property(&style, "sub-shadow-offset"), "4");
        assert_eq!(property(&style, "sub-pos"), "88.0");
        assert_eq!(property(&style, "sub-ass-override"), "force");
        assert_eq!(property(&style, "sub-font"), "Avenir Next");
    }

    #[test]
    fn a_style_from_outside_is_made_usable() {
        let style = SubtitleStyle {
            font: Some("   ".to_owned()),
            scale: 40.0,
            colour: "red".to_owned(),
            outline: f64::NAN,
            background: 3.0,
            raise: -5.0,
            ..SubtitleStyle::default()
        }
        .sanitised();
        assert_eq!(style.font, None);
        assert_eq!(style.scale, MAX_SUBTITLE_SCALE);
        assert_eq!(style.colour, "#FFFFFF");
        assert_eq!(style.outline, 1.5);
        assert_eq!(style.background, 1.0);
        assert_eq!(style.raise, 0.0);
    }

    #[test]
    fn a_crop_gives_the_window_the_shape_of_what_is_left() {
        let wide = Some(Ratio {
            width: 239,
            height: 100,
        });
        let square = Some(Ratio {
            width: 1,
            height: 1,
        });
        assert_eq!(cropped_size(1920, 1080, None), (1920, 1080));
        assert_eq!(cropped_size(1920, 1080, wide), (1920, 803));
        assert_eq!(cropped_size(1920, 1080, square), (1080, 1080));
        // A crop the shape the picture already has changes nothing.
        assert_eq!(
            cropped_size(
                1920,
                1080,
                Some(Ratio {
                    width: 16,
                    height: 9
                })
            ),
            (1920, 1080)
        );
        // Turned on its side first, then cut.
        assert_eq!(cropped_size(1080, 1920, square), (1080, 1080));
    }
}
