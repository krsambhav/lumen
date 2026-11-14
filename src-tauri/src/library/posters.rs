//! Posters for what has been played: made one at a time in the background,
//! kept on disk, and shown by the home screen.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::engine::failure::is_address;
use crate::media::thumbnails::{asset_url, PosterCache};

/// Told when a poster that was asked for exists: the source it is for, and
/// the address the web view loads it from.
pub type Ready = Arc<dyn Fn(String, String) + Send + Sync>;

struct Job {
    source: String,
    duration: Option<f64>,
}

pub struct Posters {
    cache: Arc<PosterCache>,
    /// Sources waiting for a poster or having one made.
    queued: Arc<Mutex<HashSet<String>>>,
    jobs: Mutex<mpsc::Sender<Job>>,
}

impl Posters {
    /// Keeps posters in `dir`, and starts the one thread that makes them.
    pub fn new(dir: PathBuf, ready: Ready) -> Self {
        let cache = Arc::new(PosterCache::new(dir));
        let queued = Arc::new(Mutex::new(HashSet::new()));
        let (jobs, waiting) = mpsc::channel::<Job>();
        let spawned = std::thread::Builder::new()
            .name("lumen-posters".to_owned())
            .spawn({
                let cache = cache.clone();
                let queued = queued.clone();
                move || {
                    // Ends when the `Posters` is dropped and the channel closes.
                    for job in waiting {
                        let made = cache.make(Path::new(&job.source), job.duration);
                        queued.lock().remove(&job.source);
                        if let Some(poster) = made {
                            ready(job.source, asset_url(&poster));
                        }
                    }
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "posters will not be made");
        }
        Self {
            cache,
            queued,
            jobs: Mutex::new(jobs),
        }
    }

    /// Where posters are kept.
    pub fn dir(&self) -> &Path {
        self.cache.dir()
    }

    /// The address of the poster for `source`, if it has one.
    pub fn url_for(&self, source: &str) -> Option<String> {
        if is_address(source) {
            return None;
        }
        self.cache
            .find(Path::new(source))
            .map(|poster| asset_url(&poster))
    }

    /// Asks for a poster for `source`, unless it has one, is known to have
    /// none, or is already being seen to. `ready` hears when it exists.
    pub fn request(&self, source: &str, duration: Option<f64>) {
        if is_address(source) || !self.cache.wants(Path::new(source)) {
            return;
        }
        if !self.queued.lock().insert(source.to_owned()) {
            return;
        }
        let sent = self.jobs.lock().send(Job {
            source: source.to_owned(),
            duration,
        });
        if sent.is_err() {
            self.queued.lock().remove(source);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::engine::test_support::test_clip;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lumen-posters-svc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn makes_a_poster_in_the_background_and_says_when_it_is_ready() {
        let (told, hears) = mpsc::channel();
        let told = Mutex::new(told);
        let posters = Posters::new(
            scratch("ready"),
            Arc::new(move |source, url| {
                let _ = told.lock().send((source, url));
            }),
        );
        let clip = test_clip().to_string_lossy().into_owned();
        assert_eq!(posters.url_for(&clip), None);

        posters.request(&clip, Some(2.0));
        // Asking twice while it is being made is one job, not two.
        posters.request(&clip, Some(2.0));
        let (source, url) = hears
            .recv_timeout(Duration::from_secs(10))
            .expect("the poster");
        assert_eq!(source, clip);
        assert!(url.starts_with("asset://localhost/"), "{url}");
        assert_eq!(posters.url_for(&clip), Some(url));
        assert!(hears.recv_timeout(Duration::from_millis(300)).is_err());

        // It has one now: asking again does nothing.
        posters.request(&clip, Some(2.0));
        assert!(hears.recv_timeout(Duration::from_millis(300)).is_err());
        std::fs::remove_dir_all(posters.dir()).unwrap();
    }

    #[test]
    fn has_nothing_for_an_address_or_a_file_that_is_gone() {
        let posters = Posters::new(
            scratch("none"),
            Arc::new(|_, _| panic!("nothing to report")),
        );
        posters.request("https://example.com/a.mp4", Some(60.0));
        posters.request("/no/such/film.mkv", Some(60.0));
        assert_eq!(posters.url_for("https://example.com/a.mp4"), None);
        assert_eq!(posters.url_for("/no/such/film.mkv"), None);
        assert!(posters.queued.lock().is_empty());
    }
}
