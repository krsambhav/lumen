//! The search server's JSON, as it sends it.

use std::collections::HashMap;

use serde::Deserialize;

use super::{file_of, TorrentProgress, TorrentResult};

#[derive(Debug, Deserialize)]
pub struct Search {
    #[serde(default)]
    pub results: Vec<Found>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    info_hash: Option<String>,
    #[serde(default)]
    magnet: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    uploaded: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    trusted: Option<bool>,
    #[serde(default)]
    seeders: Option<f64>,
    #[serde(default)]
    leechers: Option<f64>,
}

impl Found {
    /// A result Lumen can use: one with a name, a well-formed hash and a magnet.
    pub fn into_result(self) -> Option<TorrentResult> {
        let hash = self.info_hash?.to_ascii_lowercase();
        if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let name = self
            .name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())?;
        let magnet = self
            .magnet
            .filter(|magnet| magnet.starts_with("magnet:?"))?;
        let count = |value: Option<f64>| value.map_or(0, |value| value.max(0.0) as u32);
        Some(TorrentResult {
            name,
            hash,
            magnet,
            size: self.size.unwrap_or_default(),
            seeders: count(self.seeders),
            leechers: count(self.leechers),
            uploaded: self.uploaded.map(|day| day.chars().take(10).collect()),
            category: self.category.filter(|category| !category.is_empty()),
            trusted: self.trusted.unwrap_or(false),
            ready: None,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct Cache {
    #[serde(default)]
    pub cached: HashMap<String, bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    #[serde(default)]
    pub torrent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Failure {
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Item {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    progress: Option<f64>,
    #[serde(default)]
    speed: Option<f64>,
    #[serde(default)]
    seeders: Option<f64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    links: Vec<Link>,
}

#[derive(Debug, Deserialize)]
struct Link {
    url: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    size: Option<f64>,
}

impl Item {
    pub fn into_progress(self) -> TorrentProgress {
        let name = self.name.unwrap_or_default();
        let state = self.status.unwrap_or_default();
        if let Some(message) = self.error.filter(|message| !message.trim().is_empty()) {
            return TorrentProgress::Failed { message };
        }
        match state.as_str() {
            "error" | "unavailable" | "cancelled" => {
                return TorrentProgress::Failed {
                    message: "This one could not be fetched. Try another result.".to_owned(),
                }
            }
            "downloaded" => {
                let files = self
                    .links
                    .into_iter()
                    .filter_map(|link| {
                        // The index is the last part of `/dl/<id>/<index>`.
                        let index = link.url.rsplit('/').next()?.parse().ok()?;
                        let name = link.filename.unwrap_or_else(|| format!("File {index}"));
                        Some(file_of(
                            index,
                            &name,
                            link.size.unwrap_or(0.0).max(0.0) as u64,
                        ))
                    })
                    .collect();
                return TorrentProgress::Ready { name, files };
            }
            _ => {}
        }
        TorrentProgress::Working {
            name,
            state,
            progress: self.progress.unwrap_or(0.0).clamp(0.0, 100.0),
            speed: self.speed.unwrap_or(0.0).max(0.0),
            seeders: self.seeders.map_or(0, |value| value.max(0.0) as u32),
        }
    }
}
