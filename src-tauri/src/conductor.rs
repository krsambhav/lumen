//! The conductor leads the player through the queue.
//!
//! It is the one place that knows about the player, the queue, the play
//! history and what is remembered between runs, so that none of those has to
//! know about another. Commands ask it to open, add and skip. Every change
//! the player reports is shown to it, and from those it keeps the history,
//! moves on when a file ends, and steps over one that will not play.
//!
//! It never calls the player while holding its own lock: the player reports
//! changes on whichever thread caused them, so a call into it can come
//! straight back here.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::db::Db;
use crate::engine::failure::{is_address, FailureReason};
use crate::engine::player::Player;
use crate::engine::types::{FileState, PlaybackStatus, PlayerChange};
use crate::error::{AppError, AppResult};
use crate::library::history;
use crate::media::sources::{self, display_name, Entry};
use crate::playlist::queue::{Incoming, Queue, QueueSnapshot, Removed, Repeat};
use crate::playlist::saved::{self, SavedItem, SavedPlaylist};
use crate::session::SessionStore;

/// Where playback is gets written down each time it has moved this many
/// seconds, as well as on every pause, end and change of file.
const SAVE_EVERY: f64 = 5.0;

/// A file that has played this long has played: it did not fail to.
const PLAYED: f64 = 0.5;

/// While lengths are being looked up, the interface is told at most this often.
const ANNOUNCE_EVERY: Duration = Duration::from_millis(300);

/// What the conductor needs of a player.
pub trait Deck: Send + Sync {
    /// Opens something. `state` is what was chosen for it the last time it
    /// was open: its tracks, its delays, how its picture was shaped.
    fn open_at(
        &self,
        source: &str,
        title: Option<&str>,
        start: Option<f64>,
        state: Option<&FileState>,
    ) -> AppResult<()>;
    /// What has been chosen for what is open, to be kept with it.
    fn file_state(&self) -> FileState;
    /// Plays the open file again from its beginning.
    fn restart(&self) -> AppResult<()>;
    fn stop(&self) -> AppResult<()>;
    /// Plays the open file round and round without a gap, or stops doing so.
    fn set_looping(&self, looping: bool) -> AppResult<()>;
    /// Nothing is open and nothing is being opened.
    fn is_idle(&self) -> bool;
    /// What is open is playing somewhere else: its sound is not the Mac's.
    fn is_remote(&self) -> bool {
        false
    }
}

impl Deck for Player {
    fn open_at(
        &self,
        source: &str,
        title: Option<&str>,
        start: Option<f64>,
        state: Option<&FileState>,
    ) -> AppResult<()> {
        Player::open_at(self, source, title, start, state)
    }

    fn file_state(&self) -> FileState {
        Player::file_state(self)
    }

    fn restart(&self) -> AppResult<()> {
        Player::restart(self)
    }

    fn stop(&self) -> AppResult<()> {
        Player::stop(self)
    }

    fn set_looping(&self, looping: bool) -> AppResult<()> {
        Player::set_looping(self, looping)
    }

    fn is_idle(&self) -> bool {
        Player::is_idle(self)
    }

    fn is_remote(&self) -> bool {
        Player::is_remote(self)
    }
}

/// Something the conductor has to say to the interface.
#[derive(Debug, Clone, PartialEq)]
pub enum Notice {
    /// The queue is now this.
    Queue(QueueSnapshot),
    /// An item would not play, and the next one is playing instead.
    Skipped {
        source: String,
        title: String,
        reason: FailureReason,
    },
    /// Something was opened, and is now the newest thing in the history.
    Played,
}

pub type Notify = Arc<dyn Fn(Notice) + Send + Sync>;
/// The time, in Unix seconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// How long the file at a path runs, in seconds, if that can be told.
pub type Prober = Arc<dyn Fn(&Path) -> Option<f64> + Send + Sync>;

/// One file's playback, followed from the player's changes.
struct Watch {
    source: String,
    title: String,
    /// The player has it open. Until then, positions the player reports are
    /// still those of whatever this file replaced.
    loaded: bool,
    position: f64,
    duration: Option<f64>,
    /// The position last written to the history.
    saved: f64,
    /// The position has moved since it was written down.
    dirty: bool,
    /// What was chosen for it, as last written to the history by this
    /// watch; `None` until it has written any.
    kept: Option<FileState>,
}

impl Watch {
    fn new(source: &str, title: Option<&String>) -> Self {
        Self {
            source: source.to_owned(),
            title: title.cloned().unwrap_or_else(|| display_name(source)),
            loaded: false,
            position: 0.0,
            duration: None,
            saved: 0.0,
            dirty: false,
            kept: None,
        }
    }
}

struct State {
    queue: Queue,
    watch: Option<Watch>,
    /// How many files in a row have failed, or ended without playing. When
    /// it reaches the length of the queue there is no point in going on.
    barren: usize,
    /// Items whose length has already been looked for.
    probed: HashSet<u32>,
    /// What the player was last told about playing round and round.
    looping: bool,
    /// What the history knows this queue by, so every item played in it is
    /// recorded as part of the one playlist. Made when first needed, and
    /// given up when the queue is replaced or emptied.
    playlist_key: Option<String>,
}

/// How the history names a saved playlist: by its id, so it is the same
/// playlist every time it is opened.
const SAVED_KEY: &str = "saved:";

/// Tells apart playlists opened within the same second.
static OPENINGS: AtomicU64 = AtomicU64::new(0);

impl State {
    /// The playlist what is playing is part of, for the history; `None`
    /// when it plays alone.
    fn played_in(&mut self, now: i64) -> Option<history::PlayedIn> {
        if self.queue.len() < 2 {
            return None;
        }
        let key = self
            .playlist_key
            .get_or_insert_with(|| {
                format!("{now}-{}", OPENINGS.fetch_add(1, Ordering::Relaxed))
            })
            .clone();
        Some(history::PlayedIn {
            key,
            name: self.queue.snapshot().name,
            items: self
                .queue
                .items()
                .iter()
                .map(|item| history::PlayedItem {
                    source: item.source.clone(),
                    title: item.title.clone(),
                    duration: item.duration,
                })
                .collect(),
        })
    }
}

/// What to do once the lock is released.
enum Then {
    Nothing,
    Play(u32),
    Replay,
}

pub struct Conductor {
    deck: Arc<dyn Deck>,
    db: Arc<Db>,
    session: Arc<SessionStore>,
    notify: Notify,
    clock: Clock,
    prober: Prober,
    state: Mutex<State>,
    /// Bumped whenever a new search for lengths starts, so an older one stops.
    probing: AtomicU64,
    me: Weak<Conductor>,
}

impl Conductor {
    pub fn new(
        deck: Arc<dyn Deck>,
        db: Arc<Db>,
        session: Arc<SessionStore>,
        notify: Notify,
        clock: Clock,
        prober: Prober,
    ) -> Arc<Self> {
        let remembered = session.get();
        let mut queue = Queue::new(seed());
        queue.set_repeat(remembered.repeat);
        queue.set_shuffle(remembered.shuffle);
        Arc::new_cyclic(|me| Self {
            deck,
            db,
            session,
            notify,
            clock,
            prober,
            state: Mutex::new(State {
                queue,
                watch: None,
                barren: 0,
                probed: HashSet::new(),
                looping: false,
                playlist_key: None,
            }),
            probing: AtomicU64::new(0),
            me: me.clone(),
        })
    }

    pub fn snapshot(&self) -> QueueSnapshot {
        self.state.lock().queue.snapshot()
    }

    /// Replaces the queue with what is in `sources` and plays the first of
    /// it: where it was left last time if `resume` is set, else from its
    /// beginning.
    pub fn open(&self, sources: &[String], resume: bool) -> AppResult<()> {
        let mut entries = sources::expand(sources);
        if entries.is_empty() {
            // Nothing in there that Lumen plays: an empty folder, say. The
            // player is asked anyway, so that it says what is wrong with it
            // where the user is looking.
            let first = sources
                .iter()
                .map(|source| source.trim())
                .find(|source| !source.is_empty())
                .ok_or_else(|| AppError::Invalid("nothing to open".to_owned()))?;
            entries.push(Entry {
                source: first.to_owned(),
                title: display_name(first),
            });
        }
        self.replace(entries.into_iter().map(incoming).collect(), None, resume)
    }

    /// Opens something from Recently played. One that was played in a
    /// playlist brings the whole playlist back, as it stood, and plays that
    /// item of it, or the item `play` names if it is one of the playlist's
    /// (where it was left if `resume` is set); anything else opens alone,
    /// as `open` would.
    pub fn open_recent(&self, source: &str, play: Option<&str>, resume: bool) -> AppResult<()> {
        let playlist = history::find(&self.db, source)?
            .and_then(|entry| entry.playlist)
            .filter(|playlist| playlist.items.iter().any(|item| item.source == source));
        let Some(playlist) = playlist else {
            return self.open(&[source.to_owned()], resume);
        };
        // A saved playlist comes back as itself, if it is still saved.
        let kept = playlist
            .key
            .strip_prefix(SAVED_KEY)
            .and_then(|id| id.parse::<u32>().ok())
            .and_then(|id| {
                saved::name_of(&self.db, id)
                    .ok()
                    .flatten()
                    .map(|name| (id, name))
            });
        let start = play
            .filter(|play| playlist.items.iter().any(|item| item.source == *play))
            .unwrap_or(source)
            .to_owned();
        let incoming = playlist
            .items
            .into_iter()
            .map(|item| Incoming {
                source: item.source,
                title: item.title,
                duration: item.duration,
            })
            .collect();
        self.replace_at(incoming, kept, resume, Some(playlist.key), Some(&start))
    }

    /// Replaces the queue with addresses whose names are already known (a
    /// stream's address says nothing about what it is) and plays the item
    /// at `start`, from where it was left; the ones before it stay in the
    /// playlist, ahead of it.
    pub fn open_titled_at(&self, items: Vec<(String, String)>, start: usize) -> AppResult<()> {
        let chosen = items.get(start).map(|(source, _)| source.clone());
        if items.is_empty() {
            return Err(AppError::Invalid("nothing to open".to_owned()));
        }
        let incoming = items
            .into_iter()
            .map(|(source, title)| Incoming::new(source, title))
            .collect();
        self.replace_at(incoming, None, true, None, chosen.as_deref())
    }

    /// Puts addresses whose names are already known straight after what is
    /// playing, so they play when it ends or on Next. With nothing open
    /// they play at once. Returns how many were added.
    pub fn play_next_titled(&self, items: Vec<(String, String)>) -> AppResult<usize> {
        if items.is_empty() {
            return Err(AppError::Invalid("nothing to add".to_owned()));
        }
        let count = items.len();
        let incoming: Vec<Incoming> = items
            .into_iter()
            .map(|(source, title)| Incoming::new(source, title))
            .collect();
        let begin = {
            let mut state = self.state.lock();
            let current = state.queue.current().map(|item| item.id);
            let at = current
                .and_then(|id| state.queue.items().iter().position(|item| item.id == id))
                .map(|index| index + 1);
            let nothing_open = state.watch.is_none();
            let added = match at {
                Some(at) => state.queue.insert(at, incoming),
                None => state.queue.append(incoming),
            };
            let first = added.first().copied().filter(|_| nothing_open);
            if let Some(first) = first {
                state.queue.select(first);
            }
            first
        };
        self.announce();
        self.look_up_lengths();
        if let Some(id) = begin {
            self.start(id, true)?;
        }
        Ok(count)
    }

    /// Replaces the queue with a saved playlist and plays the first of it.
    pub fn open_saved(&self, id: u32) -> AppResult<()> {
        let kept = saved::name_of(&self.db, id)?.map(|name| (id, name));
        let items = saved::items(&self.db, id)?;
        let incoming = items
            .into_iter()
            .map(|item| Incoming {
                source: item.source,
                title: item.title,
                duration: item.duration,
            })
            .collect();
        self.replace(incoming, kept, true)
    }

    /// Makes `incoming` the queue and plays the first of it. `kept` is the
    /// saved playlist it is, by id and name, if it is one.
    fn replace(
        &self,
        incoming: Vec<Incoming>,
        kept: Option<(u32, String)>,
        resume: bool,
    ) -> AppResult<()> {
        // A saved playlist is the same playlist in the history every time.
        let key = kept.as_ref().map(|(id, _)| format!("{SAVED_KEY}{id}"));
        self.replace_at(incoming, kept, resume, key, None)
    }

    /// Makes `incoming` the queue, known to the history as `key` (a new
    /// playlist when `None`), and plays the item whose source is `start`,
    /// or the first.
    fn replace_at(
        &self,
        incoming: Vec<Incoming>,
        kept: Option<(u32, String)>,
        resume: bool,
        key: Option<String>,
        start: Option<&str>,
    ) -> AppResult<()> {
        let first = {
            let mut state = self.state.lock();
            state.probed.clear();
            state.barren = 0;
            state.playlist_key = key;
            let mut first = state.queue.set(incoming);
            if let Some((id, name)) = kept {
                state.queue.keep_as(id, name);
            }
            let chosen = start.and_then(|start| {
                state
                    .queue
                    .items()
                    .iter()
                    .find(|item| item.source == start)
                    .map(|item| item.id)
            });
            if let Some(chosen) = chosen.filter(|chosen| state.queue.select(*chosen)) {
                first = Some(chosen);
            }
            first
        };
        self.announce();
        self.look_up_lengths();
        match first {
            Some(id) => self.start(id, resume),
            None => Ok(()),
        }
    }

    /// Adds what is in `sources` to the queue: at `index` in the list, or at
    /// its end. If nothing is open, the first of what was added plays.
    /// Returns how many items were added.
    pub fn add(&self, sources: &[String], index: Option<usize>) -> AppResult<usize> {
        let entries = sources::expand(sources);
        if entries.is_empty() {
            return Err(AppError::Invalid(
                "there is nothing Lumen can play in what was added".to_owned(),
            ));
        }
        let count = entries.len();
        let incoming = entries.into_iter().map(incoming).collect();
        let begin = {
            let mut state = self.state.lock();
            let added = match index {
                Some(index) => state.queue.insert(index, incoming),
                None => state.queue.append(incoming),
            };
            let silent = state.queue.current().is_none() || self.deck.is_idle();
            let first = added.first().copied().filter(|_| silent);
            if let Some(first) = first {
                state.queue.select(first);
            }
            first
        };
        self.announce();
        self.look_up_lengths();
        if let Some(id) = begin {
            self.start(id, true)?;
        }
        Ok(count)
    }

    /// Plays an item of the queue. Asking for the one that is playing starts
    /// it again from its beginning.
    pub fn play(&self, id: u32) -> AppResult<()> {
        let again = {
            let mut state = self.state.lock();
            let again = state.queue.current().is_some_and(|item| item.id == id)
                && state.watch.as_ref().is_some_and(|watch| watch.loaded);
            if !again && !state.queue.select(id) {
                return Err(AppError::NotFound(
                    "that item is no longer in the playlist".to_owned(),
                ));
            }
            again
        };
        if again {
            return self.deck.restart();
        }
        self.announce();
        self.start(id, true)
    }

    /// Takes an item out of the queue. If it was playing, what followed it
    /// plays; if it was all there was, playback stops.
    pub fn remove(&self, id: u32) -> AppResult<()> {
        let removed = self.state.lock().queue.remove(id);
        match removed {
            Removed::Nothing => Ok(()),
            Removed::Other => {
                self.announce();
                Ok(())
            }
            Removed::Current { next: Some(next) } => {
                self.announce();
                self.start(next, true)
            }
            Removed::Current { next: None } => self.close(),
        }
    }

    /// Moves an item to `index` in the list.
    pub fn move_to(&self, id: u32, index: usize) {
        if self.state.lock().queue.move_to(id, index) {
            self.announce();
        }
    }

    /// Empties the queue of everything but what is playing.
    pub fn clear_others(&self) {
        let removed = self.state.lock().queue.keep_only_current();
        if !removed.is_empty() {
            self.announce();
        }
    }

    /// Goes to the next item. False if there is none.
    pub fn next(&self) -> AppResult<bool> {
        self.step(Queue::next)
    }

    /// Goes to the previous item. False if there is none.
    pub fn previous(&self) -> AppResult<bool> {
        self.step(Queue::previous)
    }

    fn step(&self, by: impl FnOnce(&mut Queue) -> Option<u32>) -> AppResult<bool> {
        let target = by(&mut self.state.lock().queue);
        let Some(id) = target else {
            return Ok(false);
        };
        self.announce();
        self.start(id, true)?;
        Ok(true)
    }

    pub fn set_repeat(&self, repeat: Repeat) {
        self.state.lock().queue.set_repeat(repeat);
        self.session.update(|session| session.repeat = repeat);
        self.announce();
    }

    pub fn set_shuffle(&self, shuffle: bool) {
        self.state.lock().queue.set_shuffle(shuffle);
        self.session.update(|session| session.shuffle = shuffle);
        self.announce();
    }

    /// Closes what is open and empties the queue.
    pub fn close(&self) -> AppResult<()> {
        {
            let mut state = self.state.lock();
            self.write_down(&mut state);
            state.queue.clear();
            state.probed.clear();
            state.playlist_key = None;
        }
        self.announce();
        self.deck.stop()
    }

    /// Saves the queue as a playlist called `name`. See `saved::save` for
    /// what `replace` allows.
    pub fn save_as(&self, name: &str, replace: bool) -> AppResult<SavedPlaylist> {
        let items: Vec<SavedItem> = self
            .state
            .lock()
            .queue
            .items()
            .iter()
            .map(|item| SavedItem {
                source: item.source.clone(),
                title: item.title.clone(),
                duration: item.duration,
            })
            .collect();
        let playlist = saved::save(&self.db, name, &items, replace, (self.clock)())?;
        self.state
            .lock()
            .queue
            .keep_as(playlist.id, playlist.name.clone());
        self.announce();
        Ok(playlist)
    }

    /// Gives a saved playlist another name. If it is the one that is open,
    /// the queue is renamed with it.
    pub fn rename_saved(&self, id: u32, name: &str) -> AppResult<SavedPlaylist> {
        let playlist = saved::rename(&self.db, id, name, (self.clock)())?;
        if self.state.lock().queue.renamed(id, &playlist.name) {
            self.announce();
        }
        Ok(playlist)
    }

    /// Deletes a saved playlist. Returns whether there was one. If it is the
    /// one that is open, the queue plays on without its name. Until Lumen is
    /// next launched, `undelete_saved` brings the playlist back.
    pub fn delete_saved(&self, id: u32) -> AppResult<bool> {
        let deleted = saved::delete(&self.db, id, (self.clock)())?;
        if deleted && self.state.lock().queue.deleted(id, true) {
            self.announce();
        }
        Ok(deleted)
    }

    /// Brings back a playlist deleted since the last launch. A queue that is
    /// still the one it was deleted from under has its name again.
    pub fn undelete_saved(&self, id: u32) -> AppResult<SavedPlaylist> {
        let playlist = saved::undelete(&self.db, id)?;
        if self.state.lock().queue.deleted(id, false) {
            self.announce();
        }
        Ok(playlist)
    }

    /// Writes down where playback is. Call before the app ends.
    pub fn shutdown(&self) {
        self.write_down(&mut self.state.lock());
    }

    /// Shown every change the player reports, on the thread that caused it.
    ///
    /// `pass_on` sends the change to the interface. The conductor calls it
    /// once it has taken the change in and before it acts on it, so that the
    /// interface hears "ended" before it hears what was opened next; and it
    /// does not call it at all for a failure it steps over, which it reports
    /// in its own words instead.
    pub fn observe(&self, change: &PlayerChange, pass_on: impl FnOnce()) {
        let mut then = Then::Nothing;
        let mut handled = false;
        let mut notices = Vec::new();
        {
            let mut state = self.state.lock();
            let now = (self.clock)();
            match change {
                PlayerChange::Media {
                    source: Some(source),
                    title,
                } => match state.watch.as_ref().map(|watch| watch.source == *source) {
                    // The same file under a better name: a stream's own title.
                    Some(true) => {
                        let played_in = state.played_in(now);
                        let watch = state.watch.as_mut().expect("matched above");
                        if let Some(title) = title.as_ref().filter(|title| **title != watch.title) {
                            watch.title.clone_from(title);
                            if watch.loaded {
                                self.note_opened(watch, played_in.as_ref(), &mut notices);
                            }
                        }
                    }
                    _ => {
                        // What was open has gone. What the player has to say
                        // about choices is already of the new file.
                        self.write_down_place(&mut state);
                        state.watch = Some(Watch::new(source, title.as_ref()));
                    }
                },
                PlayerChange::Media { source: None, .. } => {
                    self.write_down_place(&mut state);
                    state.watch = None;
                    // With nothing open there is no queue: the window is
                    // showing the home screen.
                    state.playlist_key = None;
                    if !state.queue.is_empty() {
                        state.queue.clear();
                        state.probed.clear();
                        notices.push(Notice::Queue(state.queue.snapshot()));
                    }
                }
                PlayerChange::Status { status } => {
                    then = self.on_status(&mut state, *status, &mut notices);
                }
                PlayerChange::Position { seconds } => {
                    let moved = state
                        .watch
                        .as_mut()
                        .filter(|watch| watch.loaded)
                        .map(|watch| {
                            watch.position = *seconds;
                            watch.dirty = true;
                            (watch.position - watch.saved).abs() >= SAVE_EVERY
                        });
                    if moved.is_some() && *seconds >= PLAYED {
                        state.barren = 0;
                        // It plays after all: what was said of it last time
                        // no longer holds.
                        let playing = state.queue.current().map(|item| item.id);
                        if playing.is_some_and(|id| state.queue.set_failed(id, None)) {
                            notices.push(Notice::Queue(state.queue.snapshot()));
                        }
                    }
                    if moved == Some(true) {
                        self.write_down(&mut state);
                    }
                }
                PlayerChange::Duration {
                    seconds: Some(seconds),
                } => {
                    let State { queue, watch, .. } = &mut *state;
                    if let Some(watch) = watch {
                        watch.duration = Some(*seconds);
                        let current = queue
                            .current()
                            .filter(|item| item.source == watch.source)
                            .map(|item| item.id);
                        if current.is_some_and(|id| queue.set_duration(id, *seconds)) {
                            notices.push(Notice::Queue(queue.snapshot()));
                        }
                    }
                }
                // A TV's volume is its own, not what the Mac is to start at next time.
                PlayerChange::Volume { .. } | PlayerChange::Muted { .. }
                    if self.deck.is_remote() => {}
                PlayerChange::Volume { percent } => {
                    let percent = *percent;
                    self.session.update(|session| session.volume = percent);
                }
                PlayerChange::Muted { muted } => {
                    let muted = *muted;
                    self.session.update(|session| session.muted = muted);
                }
                PlayerChange::Failed { source, reason, .. } => {
                    state.barren += 1;
                    let failed = state
                        .queue
                        .current()
                        .filter(|item| item.source == *source)
                        .map(|item| (item.id, item.title.clone()));
                    // Step over it, unless everything else has just failed too.
                    if let Some((id, title)) = failed.filter(|_| state.barren < state.queue.len()) {
                        // Its row says so for as long as it is true.
                        state.queue.set_failed(id, Some(reason.clone()));
                        if let Some(next) = state.queue.next() {
                            then = Then::Play(next);
                            handled = true;
                            notices.push(Notice::Skipped {
                                source: source.clone(),
                                title,
                                reason: reason.clone(),
                            });
                            notices.push(Notice::Queue(state.queue.snapshot()));
                        }
                    }
                }
                _ => {}
            }
        }
        if !handled {
            pass_on();
        }
        for notice in notices {
            (self.notify)(notice);
        }
        let followed = match then {
            Then::Nothing => Ok(()),
            Then::Play(id) => self.start(id, true),
            Then::Replay => self.deck.restart(),
        };
        if let Err(error) = followed {
            tracing::warn!(%error, "could not go on to the next item");
        }
    }

    fn on_status(
        &self,
        state: &mut State,
        status: PlaybackStatus,
        notices: &mut Vec<Notice>,
    ) -> Then {
        let open = matches!(
            status,
            PlaybackStatus::Playing
                | PlaybackStatus::Paused
                | PlaybackStatus::Buffering
                | PlaybackStatus::Ended
        );
        if open && state.watch.as_ref().is_some_and(|watch| !watch.loaded) {
            let played_in = state.played_in((self.clock)());
            if let Some(watch) = state.watch.as_mut() {
                watch.loaded = true;
                // Only now is it in the history: a file that never opened was
                // never played.
                self.note_opened(watch, played_in.as_ref(), notices);
            }
        }
        match status {
            PlaybackStatus::Paused => self.write_down(state),
            PlaybackStatus::Ended => {
                let played = state.watch.as_mut().is_some_and(|watch| {
                    let played = watch.position >= PLAYED;
                    // The end is the end, wherever the last report put it.
                    if let Some(duration) = watch.duration {
                        watch.position = duration;
                        watch.dirty = true;
                    }
                    played
                });
                self.write_down(state);
                if !played {
                    state.barren += 1;
                    if state.barren >= state.queue.len().max(1) {
                        return Then::Nothing;
                    }
                }
                let before = state.queue.current().map(|item| item.id);
                match state.queue.after_end() {
                    Some(id) if Some(id) == before => return Then::Replay,
                    Some(id) => {
                        notices.push(Notice::Queue(state.queue.snapshot()));
                        return Then::Play(id);
                    }
                    None => {}
                }
            }
            _ => {}
        }
        Then::Nothing
    }

    /// Opens an item of the queue in the player.
    fn start(&self, id: u32, resume: bool) -> AppResult<()> {
        let item = self.state.lock().queue.item(id).cloned().ok_or_else(|| {
            AppError::NotFound("that item is no longer in the playlist".to_owned())
        })?;
        let known = history::find(&self.db, &item.source)?;
        let at = known
            .as_ref()
            .filter(|_| resume)
            .and_then(|entry| history::resume_point(entry.position, entry.duration));
        // What was chosen for it last time is chosen again, wherever it
        // starts from: a language is about the film, not about a place in it.
        let remembered_title = known.as_ref().map(|entry| entry.title.clone());
        let chosen = known.and_then(|entry| entry.state);
        // What is open now is about to give way: where it is, and what was
        // chosen for it, are written while the player can still be asked.
        self.write_down(&mut self.state.lock());
        // A name is passed on only if it is more than the file's own, as a
        // playlist file's title for an entry is.
        // An address opened again without one (from Recently played, or a
        // restored session) keeps the name it was played under before.
        let remembered = remembered_title
            .as_deref()
            .filter(|_| is_address(&item.source))
            .and_then(|title| sources::given_name(&item.source, title))
            .map(str::to_owned);
        let named = (item.title != display_name(&item.source))
            .then_some(item.title.as_str())
            .and_then(|title| {
                if is_address(&item.source) {
                    sources::given_name(&item.source, title)
                } else {
                    Some(title)
                }
            })
            .or(remembered.as_deref());
        self.deck.open_at(&item.source, named, at, chosen.as_ref())
    }

    /// Writes to the history that `watch` was opened, and has the interface
    /// told: whatever lists what was played is out of date from now.
    fn note_opened(
        &self,
        watch: &Watch,
        played_in: Option<&history::PlayedIn>,
        notices: &mut Vec<Notice>,
    ) {
        match history::opened(
            &self.db,
            &watch.source,
            &watch.title,
            played_in,
            (self.clock)(),
        ) {
            Ok(()) => notices.push(Notice::Played),
            Err(error) => tracing::warn!(%error, "could not add to the play history"),
        }
    }

    /// Writes where playback is to the history, if it has moved.
    /// Writes to the history where playback is and what has been chosen for
    /// the file (a track, a delay, a turn of the picture), if either has
    /// changed. For while the file being watched is the one the player has
    /// open: the player is asked what was chosen.
    fn write_down(&self, state: &mut State) {
        let chosen = self.deck.file_state();
        self.write(state, Some(chosen));
    }

    /// Writes where playback was, and leaves what was chosen as it was last
    /// written. For when the file being watched has just given way: the
    /// player's choices are by then those of what replaced it.
    fn write_down_place(&self, state: &mut State) {
        self.write(state, None);
    }

    fn write(&self, state: &mut State, chosen: Option<FileState>) {
        let Some(watch) = state.watch.as_mut().filter(|watch| watch.loaded) else {
            return;
        };
        let chosen = chosen.filter(|chosen| watch.kept.as_ref() != Some(chosen));
        if !watch.dirty && chosen.is_none() {
            return;
        }
        watch.dirty = false;
        watch.saved = watch.position;
        if let Err(error) = history::progressed(
            &self.db,
            &watch.source,
            watch.position,
            watch.duration,
            chosen.as_ref(),
            (self.clock)(),
        ) {
            tracing::warn!(%error, "could not write down where playback is");
        }
        if chosen.is_some() {
            watch.kept = chosen;
        }
    }

    /// Tells the interface what the queue is now, and the player whether to
    /// play round and round.
    fn announce(&self) {
        let (snapshot, looping) = {
            let mut state = self.state.lock();
            let snapshot = state.queue.snapshot();
            // One item repeating is a loop, which the player does without a
            // gap; so is a queue of one that repeats.
            let wanted = match snapshot.repeat {
                Repeat::One => true,
                Repeat::All => snapshot.items.len() == 1,
                Repeat::Off => false,
            };
            let changed = (wanted != state.looping).then_some(wanted);
            state.looping = wanted;
            (snapshot, changed)
        };
        if let Some(looping) = looping {
            if let Err(error) = self.deck.set_looping(looping) {
                tracing::warn!(%error, "could not change looping");
            }
        }
        (self.notify)(Notice::Queue(snapshot));
    }

    /// Starts looking up, in the background, how long each item runs.
    fn look_up_lengths(&self) {
        let generation = self.probing.fetch_add(1, Ordering::AcqRel) + 1;
        let Some(conductor) = self.me.upgrade() else {
            return;
        };
        let spawned = std::thread::Builder::new()
            .name("lumen-lengths".to_owned())
            .spawn(move || conductor.find_lengths(generation));
        if let Err(error) = spawned {
            tracing::warn!(%error, "could not look up how long the items run");
        }
    }

    fn find_lengths(&self, generation: u64) {
        let mut announced = Instant::now();
        let mut unannounced = false;
        while self.probing.load(Ordering::Acquire) == generation {
            let next = {
                let mut state = self.state.lock();
                let next = state
                    .queue
                    .items()
                    .iter()
                    .find(|item| item.duration.is_none() && !state.probed.contains(&item.id))
                    .map(|item| (item.id, item.source.clone()));
                if let Some((id, _)) = &next {
                    state.probed.insert(*id);
                }
                next
            };
            let Some((id, source)) = next else {
                break;
            };
            if let Some(seconds) = self.length_of(&source) {
                unannounced |= self.state.lock().queue.set_duration(id, seconds);
            }
            if unannounced && announced.elapsed() >= ANNOUNCE_EVERY {
                self.announce();
                announced = Instant::now();
                unannounced = false;
            }
        }
        if unannounced {
            self.announce();
        }
    }

    /// How long `source` runs: from the history if it has been played, else
    /// by asking the file.
    fn length_of(&self, source: &str) -> Option<f64> {
        let remembered = history::find(&self.db, source)
            .ok()
            .flatten()
            .and_then(|entry| entry.duration);
        if remembered.is_some() || is_address(source) {
            return remembered;
        }
        (self.prober)(Path::new(source))
    }
}

fn incoming(entry: Entry) -> Incoming {
    Incoming::new(entry.source, entry.title)
}

/// A seed for the shuffle: different on every run, which is all it needs.
fn seed() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos() as u64);
    nanos ^ (u64::from(std::process::id()) << 32)
}

/// The time now, in Unix seconds.
pub fn wall_clock() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64)
}

#[cfg(test)]
mod tests;
