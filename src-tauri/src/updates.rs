//! Keeping Lumen itself up to date.
//!
//! Every release on GitHub carries, beside the disk image people download,
//! the app as a signed archive and a small `latest.json` naming the newest
//! version. Lumen reads that file; when it names a newer version than the
//! one running, Lumen can fetch the archive, check it against the public key
//! built into this app, and put it in the running app's place. What opens
//! next is the new version.
//!
//! The fetching, checking and replacing are Tauri's updater plugin. This
//! module decides when to look, keeps how things stand, and says so to the
//! interface. Nothing is ever fetched without being asked for: looking is a
//! few hundred bytes, the update is the whole app.
//!
//! `latest.json` is not itself signed, so the signature is required to name
//! the version it was made for (`requireSignedVersion` in tauri.conf.json,
//! which `tauri build` does by itself): a tampered `latest.json` cannot then
//! pass an older, genuinely signed Lumen off as a newer one.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use specta_typescript::Number;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// How long after Lumen opens it first looks for a newer version: once the
/// window is up and whatever was opened with it has started.
const FIRST_LOOK: Duration = Duration::from_secs(5);
/// How often it looks again while it stays open.
const LOOK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How long the releases may take to answer.
const LOOK_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a connection may take to open, and how long it may then go
/// without a byte, before the fetch is given up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// The interface is told how the fetch is going no more often than this.
const SAY_EVERY: Duration = Duration::from_millis(100);

/// How Lumen stands against its newest release.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    /// Nobody has looked since Lumen opened.
    Idle,
    /// The version running is the newest there is.
    #[serde(rename_all = "camelCase")]
    Current { version: String },
    /// A newer version is published. `current` is the one running.
    #[serde(rename_all = "camelCase")]
    Available { version: String, current: String },
    /// It is being fetched. `total` is its size in bytes, when the server
    /// says.
    #[serde(rename_all = "camelCase")]
    Downloading {
        version: String,
        #[specta(type = Number)]
        received: f64,
        #[specta(type = Option<Number>)]
        total: Option<f64>,
    },
    /// It has arrived whole and signed, and is being put in place.
    #[serde(rename_all = "camelCase")]
    Installing { version: String },
    /// It is in place: the next time Lumen opens, it is this version.
    #[serde(rename_all = "camelCase")]
    Ready { version: String },
}

impl UpdateStatus {
    /// An update is on its way in: looking again would not change that.
    fn is_under_way(&self) -> bool {
        matches!(self, Self::Downloading { .. } | Self::Installing { .. })
    }
}

/// Says each new status.
pub type StatusListener = Arc<dyn Fn(UpdateStatus) + Send + Sync>;

pub struct Updates {
    app: AppHandle,
    listener: StatusListener,
    status: Mutex<UpdateStatus>,
    /// What the last look found, to be fetched when asked for.
    found: Mutex<Option<Update>>,
    /// One look or one fetch at a time.
    working: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn new(app: AppHandle, listener: StatusListener) -> Arc<Self> {
        Arc::new(Self {
            app,
            listener,
            status: Mutex::new(UpdateStatus::Idle),
            found: Mutex::new(None),
            working: tokio::sync::Mutex::new(()),
        })
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().clone()
    }

    fn say(&self, status: UpdateStatus) {
        {
            let mut current = self.status.lock();
            if *current == status {
                return;
            }
            *current = status.clone();
        }
        (self.listener)(status);
    }

    fn running_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    /// Reads the newest release and says how Lumen stands against it.
    ///
    /// A look that fails changes nothing: what was known stays known, and
    /// the failure goes back to whoever asked. `quiet` is a look nobody
    /// asked for, whose failure is only written down.
    pub async fn check(&self, quiet: bool) -> AppResult<UpdateStatus> {
        if self.status().is_under_way() {
            return Ok(self.status());
        }
        let _one = self.working.lock().await;
        let before = self.status();
        // What is already in place is the news; a look could only take it back.
        if before.is_under_way() || matches!(before, UpdateStatus::Ready { .. }) {
            return Ok(before);
        }
        let found = match self.look().await {
            Ok(found) => found,
            Err(error) => {
                if quiet {
                    tracing::info!(%error, "could not look for a newer version");
                } else {
                    tracing::warn!(%error, "could not look for a newer version");
                }
                return Err(error);
            }
        };
        let current = self.running_version();
        let status = match &found {
            Some(update) => UpdateStatus::Available {
                version: update.version.clone(),
                current,
            },
            None => UpdateStatus::Current { version: current },
        };
        tracing::info!(?status, "looked for a newer version");
        *self.found.lock() = found;
        self.say(status.clone());
        Ok(status)
    }

    async fn look(&self) -> AppResult<Option<Update>> {
        let mut builder = self
            .app
            .updater_builder()
            .timeout(LOOK_TIMEOUT)
            .configure_client(|client| {
                client
                    .connect_timeout(CONNECT_TIMEOUT)
                    .read_timeout(STALL_TIMEOUT)
            });
        if let Some(endpoint) = development_endpoint() {
            builder = builder
                .endpoints(vec![endpoint])
                .map_err(|error| explain(Stage::Look, &error))?;
        }
        let updater = builder
            .build()
            .map_err(|error| explain(Stage::Look, &error))?;
        let mut found = updater
            .check()
            .await
            .map_err(|error| explain(Stage::Look, &error))?;
        if let Some(update) = &mut found {
            // The time allowed for the look is not the time allowed for the
            // whole app to arrive: a fetch is given up when it stalls.
            update.timeout = None;
        }
        Ok(found)
    }

    /// Fetches the version that was found, checks it, and puts it in the
    /// running app's place. How it goes is said through the listener; the
    /// status it ends on is returned.
    pub async fn install(&self) -> AppResult<UpdateStatus> {
        let _one = self.working.lock().await;
        if let ready @ UpdateStatus::Ready { .. } = self.status() {
            return Ok(ready);
        }
        let update = self
            .found
            .lock()
            .clone()
            .ok_or_else(|| AppError::Invalid("no newer version has been found".to_owned()))?;
        // Before a byte is fetched: there must be an app to replace.
        replaceable_bundle()?;

        let version = update.version.clone();
        let available = UpdateStatus::Available {
            version: version.clone(),
            current: self.running_version(),
        };
        self.say(UpdateStatus::Downloading {
            version: version.clone(),
            received: 0.0,
            total: None,
        });

        let mut received = 0_u64;
        let mut said = Instant::now();
        let fetched = update
            .download(
                |chunk, total| {
                    received += chunk as u64;
                    let whole = total.is_some_and(|total| received >= total);
                    if whole || said.elapsed() >= SAY_EVERY {
                        said = Instant::now();
                        self.say(UpdateStatus::Downloading {
                            version: version.clone(),
                            received: received as f64,
                            total: total.map(|total| total as f64),
                        });
                    }
                },
                || {},
            )
            .await;
        let bytes = match fetched {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(%error, %version, "the update did not arrive");
                self.say(available);
                return Err(explain(Stage::Fetch, &error));
            }
        };

        self.say(UpdateStatus::Installing {
            version: version.clone(),
        });
        // Moving the app can wait on a password prompt: not on this thread.
        let placed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
        match placed {
            Ok(Ok(())) => {
                tracing::info!(%version, "the update is in place");
                let ready = UpdateStatus::Ready { version };
                self.say(ready.clone());
                Ok(ready)
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, %version, "the update could not be put in place");
                self.say(available);
                Err(explain(Stage::Place, &error))
            }
            Err(error) => {
                self.say(available);
                Err(AppError::Internal(format!(
                    "the update was not installed: {error}"
                )))
            }
        }
    }

    /// Closes Lumen and opens it again, as the version that is in place.
    pub fn restart(&self) -> AppResult<()> {
        if !matches!(self.status(), UpdateStatus::Ready { .. }) {
            return Err(AppError::Invalid(
                "there is no update to restart for".to_owned(),
            ));
        }
        // Through the event loop, so that where the film was is written down
        // and the player is let go of as on any other quit.
        self.app.request_restart();
        Ok(())
    }

    /// Looks by itself: a little after Lumen opens, and now and then while
    /// it stays open, for as long as the setting allows.
    ///
    /// Only an app that could take the update looks: a development run is
    /// not one. Neither is a run that only photographs the window, unless it
    /// has been told where to look: then the updater is what it is there to
    /// photograph.
    pub fn watch(self: &Arc<Self>) {
        let runs_as_app = std::env::current_exe()
            .ok()
            .is_some_and(|exe| bundle_of(&exe).is_some());
        let only_photographing = crate::is_headless_run() && development_endpoint().is_none();
        if !runs_as_app || only_photographing {
            return;
        }
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FIRST_LOOK).await;
            loop {
                if this.looks_by_itself() {
                    // Said in the log; nobody asked.
                    let _ = this.check(true).await;
                }
                tokio::time::sleep(LOOK_EVERY).await;
            }
        });
    }

    /// The setting was switched on: look now rather than in six hours.
    pub fn look_soon(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let _ = this.check(true).await;
        });
    }

    fn looks_by_itself(&self) -> bool {
        self.app
            .try_state::<AppState>()
            .is_some_and(|state| state.settings.read().general.check_for_updates)
    }
}

/// Where a development build has been told to look, in place of the releases
/// on GitHub: `LUMEN_UPDATE_ENDPOINT`, the address of a `latest.json`. A
/// release build looks nowhere but where it was built to.
fn development_endpoint() -> Option<tauri::Url> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("LUMEN_UPDATE_ENDPOINT")
        .ok()
        .and_then(|address| address.parse().ok())
}

/// The app bundle an executable is in: `Lumen.app` for
/// `Lumen.app/Contents/MacOS/lumen`. `None` for one that is not in a bundle,
/// as in a development run.
fn bundle_of(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |dir: &Path, name: &str| dir.file_name().is_some_and(|found| found == name);
    let is_app = bundle
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    (named(macos, "MacOS") && named(contents, "Contents") && is_app).then(|| bundle.to_path_buf())
}

/// The bundle Lumen runs from, if an update could take its place.
///
/// The updater would otherwise replace whatever folder holds the executable,
/// which in a development run is the build folder; and an app opened
/// straight from its disk image, or one macOS runs from a read-only copy
/// because it was never moved after downloading, cannot be replaced at all.
fn replaceable_bundle() -> AppResult<PathBuf> {
    let executable = std::env::current_exe()?;
    let bundle = bundle_of(&executable).ok_or_else(|| {
        AppError::Unsupported(
            "This is a development build, which is not an app that can be replaced".to_owned(),
        )
    })?;
    if crate::platform::is_on_read_only_volume(&bundle) {
        return Err(AppError::Unsupported(
            "Lumen is running from its disk image or a read-only copy. Move Lumen to the \
             Applications folder, open it from there, and update again"
                .to_owned(),
        ));
    }
    Ok(bundle)
}

/// Which part of an update went wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Look,
    Fetch,
    Place,
}

/// What went wrong, as a sentence for the person (DESIGN.md §10), with the
/// updater's own words kept for the log by the caller.
fn explain(stage: Stage, error: &tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error;
    let offline = "GitHub could not be reached. Check the connection and try again";
    match error {
        Error::Reqwest(_) | Error::Network(_) => AppError::Network(match stage {
            Stage::Look => offline.to_owned(),
            _ => "The download was cut short. Check the connection and try again".to_owned(),
        }),
        Error::ReleaseNotFound | Error::Serialization(_) | Error::Semver(_) => AppError::Network(
            "The newest release on GitHub does not say what it holds. Try again later".to_owned(),
        ),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            AppError::Unsupported("The newest release has no build for this Mac".to_owned())
        }
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => AppError::Invalid(
            "The download is not signed as a Lumen release, so it was not installed".to_owned(),
        ),
        Error::PreviousAppNotRestored(kept) => AppError::Io(format!(
            "The update could not be put in place, and the version you had is now at {}. Move \
             it back to the Applications folder to go on using it",
            kept.display()
        )),
        Error::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => AppError::Io(
            "macOS did not let Lumen replace itself. Move Lumen to the Applications folder and \
             update again"
                .to_owned(),
        ),
        Error::TempDirNotOnSameMountPoint => AppError::Io(
            "The update could not be put in place on the disk Lumen is on. Download the new \
             version from GitHub instead"
                .to_owned(),
        ),
        other => match stage {
            Stage::Look => AppError::Network(format!("Looking for updates failed: {other}")),
            Stage::Fetch => AppError::Network(format!("The download failed: {other}")),
            Stage::Place => AppError::Io(format!("The update could not be put in place: {other}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_an_executable_is_in() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Lumen.app/Contents/MacOS/lumen")),
            Some(PathBuf::from("/Applications/Lumen.app"))
        );
        assert_eq!(
            bundle_of(Path::new(
                "/Users/me/My Apps/Lumen Copy.APP/Contents/MacOS/lumen"
            )),
            Some(PathBuf::from("/Users/me/My Apps/Lumen Copy.APP"))
        );
    }

    #[test]
    fn a_development_build_is_in_no_bundle() {
        // The updater would take the build folder for the app and replace it.
        for executable in [
            "/Users/me/lumen/src-tauri/target/debug/lumen",
            "/usr/local/bin/lumen",
            "/Applications/Lumen.app/Contents/Helpers/lumen",
            "/Applications/Lumen/Contents/MacOS/lumen",
            "lumen",
        ] {
            assert_eq!(bundle_of(Path::new(executable)), None, "{executable}");
        }
    }

    #[test]
    fn says_how_things_stand_in_the_interface_s_own_terms() {
        let json = |status: UpdateStatus| serde_json::to_value(status).unwrap();
        assert_eq!(
            json(UpdateStatus::Idle),
            serde_json::json!({ "state": "idle" })
        );
        assert_eq!(
            json(UpdateStatus::Available {
                version: "0.3.0".into(),
                current: "0.2.7".into()
            }),
            serde_json::json!({ "state": "available", "version": "0.3.0", "current": "0.2.7" })
        );
        assert_eq!(
            json(UpdateStatus::Downloading {
                version: "0.3.0".into(),
                received: 1024.0,
                total: None
            }),
            serde_json::json!({
                "state": "downloading", "version": "0.3.0", "received": 1024.0, "total": null
            })
        );
    }

    #[test]
    fn only_a_fetch_or_a_move_is_under_way() {
        let version = || "0.3.0".to_owned();
        assert!(UpdateStatus::Downloading {
            version: version(),
            received: 0.0,
            total: None
        }
        .is_under_way());
        assert!(UpdateStatus::Installing { version: version() }.is_under_way());
        for settled in [
            UpdateStatus::Idle,
            UpdateStatus::Current { version: version() },
            UpdateStatus::Available {
                version: version(),
                current: version(),
            },
            UpdateStatus::Ready { version: version() },
        ] {
            assert!(!settled.is_under_way(), "{settled:?}");
        }
    }

    #[test]
    fn failures_are_said_for_a_person_and_never_lose_what_went_wrong() {
        use tauri_plugin_updater::Error;
        // No connection: the same words whether looking or fetching would do,
        // but each says what it was doing.
        let looked = explain(Stage::Look, &Error::Network("503".into()));
        let fetched = explain(Stage::Fetch, &Error::Network("503".into()));
        assert!(matches!(&looked, AppError::Network(message) if message.contains("GitHub")));
        assert!(matches!(&fetched, AppError::Network(message) if message.contains("download")));
        assert_ne!(looked, fetched);

        // A release with nothing for this Mac is not a network failure.
        assert!(matches!(
            explain(Stage::Look, &Error::TargetNotFound("darwin-x86_64".into())),
            AppError::Unsupported(_)
        ));
        // A download that is not signed as ours is refused in so many words.
        assert!(matches!(
            explain(Stage::Fetch, &Error::MissingSignedVersion),
            AppError::Invalid(message) if message.contains("not signed")
        ));
        // Where the old version went is the one thing the person must know.
        let kept = PathBuf::from("/Applications/Lumen (previous version).app");
        assert!(matches!(
            explain(Stage::Place, &Error::PreviousAppNotRestored(kept.clone())),
            AppError::Io(message) if message.contains(&kept.display().to_string())
        ));
        // Anything unforeseen keeps the updater's own words.
        assert!(matches!(
            explain(Stage::Place, &Error::BinaryNotFoundInArchive),
            AppError::Io(message) if message.contains("binary for the current target")
        ));
    }
}
