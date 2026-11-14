//! Finding films and shows on the user's own torrent search server, and
//! playing them straight from it.
//!
//! The server (by default the one the user hosts) searches the public
//! indexes, asks TorBox to fetch a torrent, and streams the finished files
//! back with seeking. Lumen only talks to that server's JSON API; the TorBox
//! account and its key never leave it. A file is played from the server's
//! `/dl/<torrent>/<index>` address like any other stream.

mod wire;

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use specta_typescript::Number;

use crate::error::{AppError, AppResult};
use crate::media::formats::{self, MediaKind};

/// Where the search server is when nothing says otherwise.
const DEFAULT_SERVER: &str = "https://iamapirate.duckdns.org";
/// The most results shown for one search.
const MOST_RESULTS: usize = 40;
/// The most results asked about at once: what the server checks in one go.
const MOST_CHECKED: usize = 100;

/// One torrent found by a search.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TorrentResult {
    pub name: String,
    /// Lower-case hex, 40 characters.
    pub hash: String,
    pub magnet: String,
    /// As the index gives it: "1.4 GB".
    pub size: String,
    pub seeders: u32,
    pub leechers: u32,
    /// The day it was added, as `YYYY-MM-DD`, if known.
    pub uploaded: Option<String>,
    pub category: Option<String>,
    /// The uploader is one the index vouches for.
    pub trusted: bool,
    /// TorBox already has it, so it plays in seconds. `None` if that could
    /// not be found out.
    pub ready: Option<bool>,
}

/// One file of a fetched torrent.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFile {
    pub index: u32,
    /// The file's name, without the folders it is in.
    pub name: String,
    #[specta(type = Number)]
    pub size: u64,
    /// Lumen plays it: a video or an audio file.
    pub playable: bool,
}

/// How a torrent that was asked for is getting on.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum TorrentProgress {
    /// Being fetched. `progress` is 0–100; `speed` in bytes a second.
    #[serde(rename_all = "camelCase")]
    Working {
        name: String,
        state: String,
        #[specta(type = Number)]
        progress: f64,
        #[specta(type = Number)]
        speed: f64,
        seeders: u32,
    },
    /// Fetched: its files can be played.
    #[serde(rename_all = "camelCase")]
    Ready {
        name: String,
        files: Vec<TorrentFile>,
    },
    /// It will not come. `message` is for the user.
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

/// The search server's API.
pub struct Torrents {
    base: String,
    http: reqwest::Client,
}

impl Default for Torrents {
    fn default() -> Self {
        let base = std::env::var("LUMEN_TORRENT_SERVER")
            .ok()
            .filter(|base| !base.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_SERVER.to_owned());
        Self::new(&base)
    }
}

impl Torrents {
    pub fn new(base: &str) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("Lumen/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Self {
            base: base.trim_end_matches('/').to_owned(),
            http,
        }
    }

    /// Searches the indexes, best shared first, and says which results are
    /// ready to play at once.
    pub async fn search(&self, query: &str) -> AppResult<Vec<TorrentResult>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let found: wire::Search = self
            .get_json(&format!("/api/search?q={}", encode(query)))
            .await?;
        let mut results: Vec<TorrentResult> = found
            .results
            .into_iter()
            .filter_map(wire::Found::into_result)
            .collect();
        results.sort_by(|a, b| b.seeders.cmp(&a.seeders));
        let mut seen = std::collections::HashSet::new();
        results.retain(|result| seen.insert(result.hash.clone()));
        // As many as the server checks at once.
        results.truncate(MOST_CHECKED);

        // Only what TorBox already has is offered: it plays at once.
        let hashes: Vec<&str> = results.iter().map(|result| result.hash.as_str()).collect();
        let ready = tokio::time::timeout(Duration::from_secs(10), self.ready(&hashes))
            .await
            .map_err(|_| {
                AppError::Network("the search server took too long to say what is ready".to_owned())
            })??;
        Ok(only_ready(results, &ready))
    }

    async fn ready(&self, hashes: &[&str]) -> AppResult<std::collections::HashMap<String, bool>> {
        if hashes.is_empty() {
            return Ok(Default::default());
        }
        let cache: wire::Cache = self
            .get_json(&format!("/api/cache?hash={}", hashes.join(",")))
            .await?;
        Ok(cache.cached)
    }

    /// Asks for a torrent to be fetched. Returns the id to follow it by.
    pub async fn prepare(&self, magnet: &str) -> AppResult<String> {
        if !magnet.starts_with("magnet:?") {
            return Err(AppError::Invalid("that is not a magnet link".to_owned()));
        }
        let response = self
            .http
            .post(format!("{}/api/download", self.base))
            .json(&serde_json::json!({ "magnet": magnet }))
            .send()
            .await
            .map_err(unreachable)?;
        let added: wire::Added = read(response).await?;
        added.torrent_id.ok_or_else(|| {
            AppError::Network("the server did not take that torrent; try again".to_owned())
        })
    }

    /// How a torrent asked for with `prepare` is getting on.
    pub async fn status(&self, id: &str) -> AppResult<TorrentProgress> {
        let id = checked_id(id)?;
        let response = self
            .http
            .get(format!("{}/api/download/{id}", self.base))
            .send()
            .await
            .map_err(unreachable)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            // The server drops a torrent that has stopped moving.
            return Ok(TorrentProgress::Failed {
                message: "No one is sharing this right now. Try another result.".to_owned(),
            });
        }
        let item: wire::Item = read(response).await?;
        Ok(item.into_progress())
    }

    /// The address a file of a fetched torrent streams from.
    pub fn address(&self, id: &str, index: u32) -> AppResult<String> {
        Ok(format!("{}/dl/{}/{index}", self.base, checked_id(id)?))
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .map_err(unreachable)?;
        read(response).await
    }
}

/// The results TorBox already has, marked ready, best shared first.
fn only_ready(
    results: Vec<TorrentResult>,
    ready: &std::collections::HashMap<String, bool>,
) -> Vec<TorrentResult> {
    results
        .into_iter()
        .filter(|result| ready.get(&result.hash).copied().unwrap_or(false))
        .map(|result| TorrentResult {
            ready: Some(true),
            ..result
        })
        .take(MOST_RESULTS)
        .collect()
}

/// What a file is called once the folders it is in are taken off, and
/// whether Lumen plays it.
pub(crate) fn file_of(index: u32, path: &str, size: u64) -> TorrentFile {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned();
    let playable = formats::kind_of(Path::new(&name)).is_some() && !is_sample(&name);
    TorrentFile {
        index,
        name,
        size,
        playable,
    }
}

/// A short excerpt some releases include beside the film.
fn is_sample(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower
        .rsplit_once('.')
        .map_or(lower.as_str(), |(stem, _)| stem);
    stem == "sample" || stem.ends_with("-sample") || stem.ends_with(".sample")
}

/// The files to queue when `chosen` is picked: it, and the playable files
/// after it in name order, so that the next episode follows.
pub fn queue_from(files: &[TorrentFile], chosen: u32) -> Vec<&TorrentFile> {
    let mut playable: Vec<&TorrentFile> = files.iter().filter(|file| file.playable).collect();
    playable.sort_by(|a, b| natural(&a.name, &b.name));
    match playable.iter().position(|file| file.index == chosen) {
        Some(at) => playable.split_off(at),
        None => files.iter().filter(|file| file.index == chosen).collect(),
    }
}

/// The title a file is shown under: its name without the extension.
pub fn title_of(file: &TorrentFile) -> String {
    let path = Path::new(&file.name);
    match formats::kind_of(path) {
        Some(MediaKind::Video | MediaKind::Audio) => path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| file.name.clone()),
        None => file.name.clone(),
    }
}

/// Orders names as a person would: "E2" before "E10".
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    fn chunks(text: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in text.to_lowercase().chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((was, chunk)) if *was == digit => chunk.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (a, b) = (chunks(a), chunks(b));
    for (x, y) in a.iter().zip(&b) {
        let order = match (x.0, y.0) {
            (true, true) => {
                let (x, y) = (x.1.trim_start_matches('0'), y.1.trim_start_matches('0'));
                x.len().cmp(&y.len()).then_with(|| x.cmp(y))
            }
            _ => x.1.cmp(&y.1),
        };
        if order.is_ne() {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

/// A torrent id as the server makes them: `tb-` and an info hash.
fn checked_id(id: &str) -> AppResult<&str> {
    let hash = id.strip_prefix("tb-").unwrap_or("");
    if hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(id)
    } else {
        Err(AppError::Invalid(format!("“{id}” is not a torrent id")))
    }
}

fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn unreachable(error: reqwest::Error) -> AppError {
    tracing::warn!(%error, "torrent server request failed");
    if error.is_timeout() {
        AppError::Network("the search server took too long to answer".to_owned())
    } else {
        AppError::Network("the search server cannot be reached; check the connection".to_owned())
    }
}

/// Reads a JSON answer, turning the server's `{ error }` into words for the user.
async fn read<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> AppResult<T> {
    let status = response.status();
    let body = response.bytes().await.map_err(unreachable)?;
    if !status.is_success() {
        let said = serde_json::from_slice::<wire::Failure>(&body)
            .ok()
            .and_then(|failure| failure.error)
            .filter(|said| !said.trim().is_empty());
        let message = match (status.as_u16(), said) {
            (451, _) => "TorBox will not fetch this one. Try another result.".to_owned(),
            (429, _) => "The server is busy. Try again in a moment.".to_owned(),
            (_, Some(said)) => said,
            (code, None) => format!("the search server answered with an error ({code})"),
        };
        return Err(AppError::Network(message));
    }
    serde_json::from_slice(&body).map_err(|error| {
        tracing::warn!(%error, "torrent server sent something unreadable");
        AppError::Network("the search server sent an answer Lumen cannot read".to_owned())
    })
}

#[cfg(test)]
mod tests;
