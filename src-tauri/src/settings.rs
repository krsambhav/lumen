//! User settings: typed, sectioned, and stored one JSON document per section.
//!
//! On the wire every field is required, so the TypeScript types are exact.
//! Stored rows are instead merged over the defaults when loaded, so a row
//! written by an older version (or missing altogether) still loads cleanly,
//! and unknown fields are ignored.

use rusqlite::params;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use specta_typescript::Number;

use crate::db::Db;
use crate::engine::adjust::{
    Channels, Equaliser, EqualiserPreset, Picture, PicturePreset, SubtitleStyle,
};
use crate::error::AppResult;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub video: VideoSettings,
    pub audio: AudioSettings,
    pub subtitles: SubtitleSettings,
}

/// How Lumen itself behaves, whatever is playing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    /// Look for a newer version of Lumen by itself, when it opens and now
    /// and then while it is open. Nothing is fetched until it is asked for.
    pub check_for_updates: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            check_for_updates: true,
        }
    }
}

/// The picture tuner, and the adjustments saved from it by name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub picture: Picture,
    pub presets: Vec<PicturePreset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub equaliser: Equaliser,
    /// Gains saved by name. The ones Lumen comes with are not stored.
    pub presets: Vec<EqualiserPreset>,
    /// Where sound goes, as one of the player's `audio_devices`; `None`
    /// follows the Mac's own output.
    pub device: Option<String>,
    pub channels: Channels,
    /// Hand Dolby Digital and DTS to the output undecoded, for a receiver
    /// to decode.
    pub passthrough: bool,
    /// Give a file that has no picture a drawing of its sound.
    pub visualiser: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            equaliser: Equaliser::default(),
            presets: Vec::new(),
            device: None,
            channels: Channels::default(),
            passthrough: false,
            visualiser: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSettings {
    pub style: SubtitleStyle,
    pub search: SubtitleSearch,
}

/// What looking for subtitles online needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSearch {
    /// The user's own key for the OpenSubtitles service; empty until they
    /// give one.
    pub api_key: String,
    /// The languages to look for, most wanted first, as two-letter codes.
    pub languages: Vec<String>,
}

impl Default for SubtitleSearch {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            languages: vec!["en".to_owned()],
        }
    }
}

/// The most presets of one kind that are kept.
const MOST_PRESETS: usize = 40;
/// The longest a preset's name may be, in characters.
const LONGEST_NAME: usize = 60;

/// A name as it is kept: trimmed, and not too long. `None` if nothing is left.
fn preset_name(name: &str) -> Option<String> {
    let name: String = name.trim().chars().take(LONGEST_NAME).collect();
    (!name.is_empty()).then_some(name)
}

/// Presets as they are kept: each with a usable name, the later of two of
/// the same name (whatever its capitals), and no more than `MOST_PRESETS`.
fn presets<T>(
    given: Vec<T>,
    name: impl Fn(&T) -> &str,
    renamed: impl Fn(T, String) -> T,
) -> Vec<T> {
    let mut kept: Vec<T> = Vec::new();
    for preset in given {
        let Some(clean) = preset_name(name(&preset)) else {
            continue;
        };
        kept.retain(|other| name(other).to_lowercase() != clean.to_lowercase());
        kept.push(renamed(preset, clean));
    }
    let extra = kept.len().saturating_sub(MOST_PRESETS);
    kept.drain(..extra);
    kept
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub theme: ThemeMode,
    pub accent: AccentChoice,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    /// Follow the macOS appearance.
    System,
    /// Lumen is dark-first.
    #[default]
    Dark,
    Light,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AccentChoice {
    /// One of the named accents in `design/color.ts`.
    Preset { id: String },
    /// Any OKLCH hue, 0–360.
    Custom {
        #[specta(type = Number)]
        hue: f64,
    },
}

impl Default for AccentChoice {
    fn default() -> Self {
        Self::Preset {
            id: "limelight".to_owned(),
        }
    }
}

impl Settings {
    pub fn load(db: &Db) -> AppResult<Self> {
        Ok(Self {
            general: load_section(db, "general")?,
            appearance: load_section(db, "appearance")?,
            video: load_section(db, "video")?,
            audio: load_section(db, "audio")?,
            subtitles: load_section(db, "subtitles")?,
        }
        .sanitised())
    }

    #[cfg(test)]
    pub fn save(&self, db: &Db) -> AppResult<()> {
        save_section(db, "general", &self.general)?;
        save_section(db, "appearance", &self.appearance)?;
        save_section(db, "video", &self.video)?;
        save_section(db, "audio", &self.audio)?;
        save_section(db, "subtitles", &self.subtitles)
    }

    /// Writes the sections that are not as they are in `before`. A scale
    /// being dragged changes one section many times a second; the others
    /// are not written again each time.
    pub fn save_changes(&self, db: &Db, before: &Self) -> AppResult<()> {
        if self.general != before.general {
            save_section(db, "general", &self.general)?;
        }
        if self.appearance != before.appearance {
            save_section(db, "appearance", &self.appearance)?;
        }
        if self.video != before.video {
            save_section(db, "video", &self.video)?;
        }
        if self.audio != before.audio {
            save_section(db, "audio", &self.audio)?;
        }
        if self.subtitles != before.subtitles {
            save_section(db, "subtitles", &self.subtitles)?;
        }
        Ok(())
    }

    /// Clamps values that came from outside to what the app can use.
    pub fn sanitised(mut self) -> Self {
        if let AccentChoice::Custom { hue } = &mut self.appearance.accent {
            *hue = if hue.is_finite() {
                hue.rem_euclid(360.0)
            } else {
                106.0
            };
        }

        self.video.picture = self.video.picture.sanitised();
        self.video.presets = presets(
            self.video.presets,
            |preset| &preset.name,
            |preset, name| PicturePreset {
                name,
                picture: preset.picture.sanitised(),
            },
        );

        self.audio.equaliser = self.audio.equaliser.sanitised();
        self.audio.presets = presets(
            self.audio.presets,
            |preset| &preset.name,
            |preset, name| {
                let gains = Equaliser {
                    enabled: true,
                    gains: preset.gains,
                }
                .sanitised()
                .gains;
                EqualiserPreset { name, gains }
            },
        );
        self.audio.device = self
            .audio
            .device
            .map(|device| device.trim().to_owned())
            .filter(|device| !device.is_empty() && device != "auto");

        self.subtitles.style = self.subtitles.style.sanitised();
        let search = &mut self.subtitles.search;
        search.api_key = search.api_key.trim().chars().take(200).collect();
        let mut languages: Vec<String> = Vec::new();
        for language in &search.languages {
            let code = language.trim().to_lowercase();
            let plausible = (2..=3).contains(&code.len())
                && code.chars().all(|letter| letter.is_ascii_lowercase());
            if plausible && !languages.contains(&code) {
                languages.push(code);
            }
        }
        languages.truncate(5);
        if languages.is_empty() {
            languages.push("en".to_owned());
        }
        search.languages = languages;
        self
    }
}

/// Writes one section as a JSON document, replacing what was stored.
pub(crate) fn save_section<T: Serialize>(db: &Db, key: &str, section: &T) -> AppResult<()> {
    let document = serde_json::to_string(section)?;
    db.write(|tx| {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
            params![key, document],
        )?;
        Ok(())
    })
}

/// Reads one section, laying the stored document over the defaults.
///
/// A row that no longer parses falls back to the defaults: a damaged
/// preference must never stop the app from starting.
pub(crate) fn load_section<T: DeserializeOwned + Serialize + Default>(
    db: &Db,
    key: &str,
) -> AppResult<T> {
    let raw: Option<String> = db.read(|conn| {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    })?;
    let Some(raw) = raw else {
        return Ok(T::default());
    };
    let mut document = serde_json::to_value(T::default())?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(stored) => merge(&mut document, stored),
        Err(error) => {
            tracing::warn!(key, %error, "settings section is not JSON; using defaults");
        }
    }
    Ok(serde_json::from_value(document).unwrap_or_else(|error| {
        tracing::warn!(key, %error, "settings section is unreadable; using defaults");
        T::default()
    }))
}

/// Deep-merges `overlay` into `base`: objects merge key by key, anything else
/// is replaced.
pub(crate) fn merge(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                match base.get_mut(&key) {
                    Some(slot) => merge(slot, value),
                    None => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (slot, value) => *slot = value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_dark_with_the_limelight_accent() {
        let db = Db::in_memory().unwrap();
        let settings = Settings::load(&db).unwrap();
        assert_eq!(settings.appearance.theme, ThemeMode::Dark);
        assert_eq!(
            settings.appearance.accent,
            AccentChoice::Preset {
                id: "limelight".into()
            }
        );
    }

    #[test]
    fn looks_for_updates_by_itself_until_told_not_to() {
        let db = Db::in_memory().unwrap();
        let before = Settings::load(&db).unwrap();
        assert!(before.general.check_for_updates);

        let mut settings = before.clone();
        settings.general.check_for_updates = false;
        settings.save_changes(&db, &before).unwrap();
        assert!(!Settings::load(&db).unwrap().general.check_for_updates);
        // Only that section was written.
        let rows: i64 = db
            .read(|conn| conn.query_row("SELECT count(*) FROM settings", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn round_trips_through_the_database() {
        let db = Db::in_memory().unwrap();
        let mut settings = Settings::default();
        settings.appearance.theme = ThemeMode::Light;
        settings.appearance.accent = AccentChoice::Custom { hue: 245.0 };
        settings.general.check_for_updates = false;
        settings.save(&db).unwrap();
        settings.save(&db).unwrap(); // upsert, not a second row
        assert_eq!(Settings::load(&db).unwrap(), settings);
    }

    #[test]
    fn every_section_round_trips_and_only_what_changed_is_written() {
        let db = Db::in_memory().unwrap();
        let before = Settings::default();
        before.save(&db).unwrap();
        let written = |key: &str| -> i64 {
            db.read(|conn| {
                conn.query_row(
                    "SELECT updated_at FROM settings WHERE key = ?1",
                    [key],
                    |row| row.get(0),
                )
            })
            .unwrap()
        };
        // Mark the rows, to see which are written again.
        db.write(|tx| tx.execute("UPDATE settings SET updated_at = 1", []))
            .unwrap();

        let mut settings = before.clone();
        settings.video.picture.brightness = 12;
        settings.audio.equaliser.enabled = true;
        settings.audio.equaliser.gains[2] = 4.5;
        settings.save_changes(&db, &before).unwrap();
        assert_eq!(Settings::load(&db).unwrap(), settings);
        assert_eq!(written("appearance"), 1);
        assert_eq!(written("subtitles"), 1);
        assert_ne!(written("video"), 1);
        assert_ne!(written("audio"), 1);
    }

    #[test]
    fn sound_and_subtitles_start_as_a_new_listener_would_want() {
        let settings = Settings::default();
        assert!(!settings.audio.equaliser.enabled);
        assert!(!settings.audio.passthrough);
        assert!(settings.audio.visualiser);
        assert_eq!(settings.audio.device, None);
        assert_eq!(settings.video.picture, Picture::default());
        assert_eq!(settings.subtitles.search.languages, ["en"]);
        assert_eq!(settings.subtitles.search.api_key, "");
    }

    #[test]
    fn presets_keep_usable_names_and_the_later_of_two_alike() {
        let mut settings = Settings::default();
        let named = |name: &str, brightness: i32| PicturePreset {
            name: name.to_owned(),
            picture: Picture {
                brightness,
                ..Picture::default()
            },
        };
        settings.video.presets = vec![
            named("  Projector ", 10),
            named("", 20),
            named("projector", 400),
            named("Evening", 5),
        ];
        let presets = settings.sanitised().video.presets;
        let names: Vec<&str> = presets.iter().map(|preset| preset.name.as_str()).collect();
        assert_eq!(names, ["projector", "Evening"]);
        // And what they hold is made usable too.
        assert_eq!(presets[0].picture.brightness, 100);
    }

    #[test]
    fn what_came_from_outside_is_made_usable() {
        let mut settings = Settings::default();
        settings.audio.device = Some("  auto ".to_owned());
        settings.audio.equaliser.gains = vec![99.0];
        settings.audio.presets = vec![EqualiserPreset {
            name: "Mine".to_owned(),
            gains: vec![3.0, -30.0],
        }];
        settings.subtitles.search.api_key = "  key  ".to_owned();
        settings.subtitles.search.languages =
            vec!["EN".into(), "en".into(), "français".into(), " de ".into()];
        let settings = settings.sanitised();
        assert_eq!(settings.audio.device, None);
        assert_eq!(settings.audio.equaliser.gains.len(), 10);
        assert_eq!(settings.audio.equaliser.gains[0], 12.0);
        assert_eq!(settings.audio.presets[0].gains.len(), 10);
        assert_eq!(settings.audio.presets[0].gains[1], -12.0);
        assert_eq!(settings.subtitles.search.api_key, "key");
        assert_eq!(settings.subtitles.search.languages, ["en", "de"]);
        // No language at all is not a search anyone can make.
        let mut none = Settings::default();
        none.subtitles.search.languages = vec![];
        assert_eq!(none.sanitised().subtitles.search.languages, ["en"]);
    }

    #[test]
    fn missing_and_unknown_fields_are_tolerated() {
        let db = Db::in_memory().unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('appearance', ?1)",
                [r#"{"theme":"light","somethingFromTheFuture":true}"#],
            )
        })
        .unwrap();
        let settings = Settings::load(&db).unwrap();
        assert_eq!(settings.appearance.theme, ThemeMode::Light);
        assert_eq!(settings.appearance.accent, AccentChoice::default());
    }

    #[test]
    fn a_corrupt_section_falls_back_to_defaults() {
        let db = Db::in_memory().unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('appearance', 'not json')",
                [],
            )
        })
        .unwrap();
        assert_eq!(Settings::load(&db).unwrap(), Settings::default());
    }

    #[test]
    fn a_wrongly_typed_value_falls_back_to_defaults() {
        let db = Db::in_memory().unwrap();
        db.write(|tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('appearance', ?1)",
                [r#"{"theme":42}"#],
            )
        })
        .unwrap();
        assert_eq!(Settings::load(&db).unwrap(), Settings::default());
    }

    #[test]
    fn merge_overlays_nested_objects() {
        let mut base = serde_json::json!({ "a": { "x": 1, "y": 2 }, "b": [1, 2] });
        merge(
            &mut base,
            serde_json::json!({ "a": { "y": 3, "z": 4 }, "b": [9] }),
        );
        assert_eq!(
            base,
            serde_json::json!({ "a": { "x": 1, "y": 3, "z": 4 }, "b": [9] })
        );
    }

    #[test]
    fn custom_hues_are_wrapped_into_range() {
        let mut settings = Settings::default();
        settings.appearance.accent = AccentChoice::Custom { hue: 725.0 };
        assert_eq!(
            settings.sanitised().appearance.accent,
            AccentChoice::Custom { hue: 5.0 }
        );
        let mut settings = Settings::default();
        settings.appearance.accent = AccentChoice::Custom { hue: f64::NAN };
        assert_eq!(
            settings.sanitised().appearance.accent,
            AccentChoice::Custom { hue: 106.0 }
        );
    }
}
