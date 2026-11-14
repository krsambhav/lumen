use std::sync::atomic::{AtomicBool, AtomicI64};

use super::*;
use crate::playlist::queue::Repeat;

/// Whether a change the conductor was shown went on to the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Pass,
    Handled,
}

#[derive(Debug, Clone, PartialEq)]
enum Call {
    Open {
        source: String,
        title: Option<String>,
        start: Option<f64>,
    },
    Restart,
    Stop,
    Looping(bool),
}

/// A player that only writes down what it was asked to do. The tests play
/// its part by showing the conductor the changes a real one would report.
#[derive(Default)]
struct FakeDeck {
    calls: Mutex<Vec<Call>>,
    busy: AtomicBool,
    /// What has been chosen for what is open: what it was opened with,
    /// until a test chooses something else.
    chosen: Mutex<FileState>,
    /// What each thing was opened with, in order.
    opened_with: Mutex<Vec<Option<FileState>>>,
}

impl Deck for FakeDeck {
    fn open_at(
        &self,
        source: &str,
        title: Option<&str>,
        start: Option<f64>,
        state: Option<&FileState>,
    ) -> AppResult<()> {
        self.busy.store(true, Ordering::Release);
        self.calls.lock().push(Call::Open {
            source: source.to_owned(),
            title: title.map(str::to_owned),
            start,
        });
        self.opened_with.lock().push(state.cloned());
        *self.chosen.lock() = state.cloned().unwrap_or_default();
        Ok(())
    }

    fn file_state(&self) -> FileState {
        self.chosen.lock().clone()
    }

    fn restart(&self) -> AppResult<()> {
        self.calls.lock().push(Call::Restart);
        Ok(())
    }

    fn stop(&self) -> AppResult<()> {
        self.busy.store(false, Ordering::Release);
        self.calls.lock().push(Call::Stop);
        Ok(())
    }

    fn set_looping(&self, looping: bool) -> AppResult<()> {
        self.calls.lock().push(Call::Looping(looping));
        Ok(())
    }

    fn is_idle(&self) -> bool {
        !self.busy.load(Ordering::Acquire)
    }
}

struct Rig {
    conductor: Arc<Conductor>,
    deck: Arc<FakeDeck>,
    db: Arc<Db>,
    session: Arc<SessionStore>,
    notices: Arc<Mutex<Vec<Notice>>>,
    time: Arc<AtomicI64>,
}

const A: &str = "/films/a.mkv";
const B: &str = "/films/b.mkv";
const C: &str = "/films/c.mkv";
const TWO_HOURS: f64 = 7305.0;

fn all(sources: &[&str]) -> Vec<String> {
    sources.iter().map(|source| (*source).to_owned()).collect()
}

impl Rig {
    fn new() -> Self {
        Self::with(Arc::new(Db::in_memory().unwrap()), Arc::new(|_| None))
    }

    fn with(db: Arc<Db>, prober: Prober) -> Self {
        let deck = Arc::new(FakeDeck::default());
        let session = Arc::new(SessionStore::load(db.clone()).unwrap());
        let notices = Arc::new(Mutex::new(Vec::new()));
        let time = Arc::new(AtomicI64::new(1_000));
        let conductor = Conductor::new(
            deck.clone(),
            db.clone(),
            session.clone(),
            {
                let notices = notices.clone();
                Arc::new(move |notice| notices.lock().push(notice))
            },
            {
                let time = time.clone();
                Arc::new(move || time.load(Ordering::Acquire))
            },
            prober,
        );
        Self {
            conductor,
            deck,
            db,
            session,
            notices,
            time,
        }
    }

    fn see(&self, change: PlayerChange) -> Verdict {
        let mut passed = false;
        self.conductor.observe(&change, || passed = true);
        if passed {
            Verdict::Pass
        } else {
            Verdict::Handled
        }
    }

    /// The player's part when a file is asked for: it names it, loads it and plays.
    fn loads(&self, source: &str, duration: Option<f64>) {
        self.see(PlayerChange::Media {
            source: Some(source.to_owned()),
            title: Some(display_name(source)),
        });
        self.see(PlayerChange::Status {
            status: PlaybackStatus::Loading,
        });
        if let Some(seconds) = duration {
            self.see(PlayerChange::Duration {
                seconds: Some(seconds),
            });
        }
        self.see(PlayerChange::Status {
            status: PlaybackStatus::Playing,
        });
    }

    fn at(&self, seconds: f64) {
        self.see(PlayerChange::Position { seconds });
    }

    fn status(&self, status: PlaybackStatus) {
        self.see(PlayerChange::Status { status });
    }

    fn fails(&self, source: &str) -> Verdict {
        self.see(PlayerChange::Media {
            source: Some(source.to_owned()),
            title: Some(display_name(source)),
        });
        self.see(PlayerChange::Failed {
            source: source.to_owned(),
            reason: FailureReason::Missing,
            reveal: None,
        })
    }

    /// The player's part when it has nothing left open.
    fn goes_idle(&self) {
        self.deck.busy.store(false, Ordering::Release);
        self.see(PlayerChange::Media {
            source: None,
            title: None,
        });
    }

    fn calls(&self) -> Vec<Call> {
        self.deck.calls.lock().clone()
    }

    /// What the player was asked to open, in order.
    fn opened(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Open { source, .. } => Some(source),
                _ => None,
            })
            .collect()
    }

    fn last_open(&self) -> Call {
        self.calls()
            .into_iter()
            .rev()
            .find(|call| matches!(call, Call::Open { .. }))
            .expect("something was opened")
    }

    fn titles(&self) -> Vec<String> {
        self.conductor
            .snapshot()
            .items
            .into_iter()
            .map(|item| item.title)
            .collect()
    }

    fn current(&self) -> Option<String> {
        let snapshot = self.conductor.snapshot();
        snapshot
            .items
            .iter()
            .find(|item| Some(item.id) == snapshot.current)
            .map(|item| item.title.clone())
    }

    fn id_of(&self, title: &str) -> u32 {
        self.conductor
            .snapshot()
            .items
            .iter()
            .find(|item| item.title == title)
            .unwrap_or_else(|| panic!("{title} is not in the queue"))
            .id
    }

    fn remembered(&self, source: &str) -> Option<history::HistoryEntry> {
        history::find(&self.db, source).unwrap()
    }

    fn skipped(&self) -> Vec<String> {
        self.notices
            .lock()
            .iter()
            .filter_map(|notice| match notice {
                Notice::Skipped { title, .. } => Some(title.clone()),
                Notice::Queue(_) | Notice::Played => None,
            })
            .collect()
    }

    /// How many times the interface was told the history had changed.
    fn played(&self) -> usize {
        self.notices
            .lock()
            .iter()
            .filter(|notice| matches!(notice, Notice::Played))
            .count()
    }
}

#[test]
fn opening_plays_the_first_item_and_says_what_the_queue_is() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    assert_eq!(
        rig.calls(),
        [Call::Open {
            source: A.to_owned(),
            // The file's own name is not passed on as a title.
            title: None,
            start: None,
        }]
    );
    assert_eq!(rig.titles(), ["a", "b"]);
    assert_eq!(rig.current().as_deref(), Some("a"));
    let told = rig.notices.lock().clone();
    assert!(matches!(told.last(), Some(Notice::Queue(queue)) if queue.items.len() == 2));
}

#[test]
fn opening_nothing_is_refused() {
    let rig = Rig::new();
    assert!(matches!(
        rig.conductor.open(&[], true),
        Err(AppError::Invalid(_))
    ));
    assert!(matches!(
        rig.conductor.open(&all(&["  "]), true),
        Err(AppError::Invalid(_))
    ));
    assert!(rig.calls().is_empty());
}

#[test]
fn an_empty_folder_is_still_put_to_the_player_so_it_can_say_what_is_wrong() {
    let dir = std::env::temp_dir().join(format!("lumen-conductor-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let rig = Rig::new();
    let folder = dir.to_string_lossy().into_owned();
    rig.conductor
        .open(std::slice::from_ref(&folder), true)
        .unwrap();
    assert_eq!(rig.opened(), [folder]);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_film_is_in_the_history_only_once_it_has_actually_opened() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.see(PlayerChange::Media {
        source: Some(A.to_owned()),
        title: Some("a".to_owned()),
    });
    rig.status(PlaybackStatus::Loading);
    assert_eq!(rig.remembered(A), None);
    assert_eq!(rig.played(), 0);

    rig.status(PlaybackStatus::Playing);
    let entry = rig.remembered(A).expect("in the history");
    assert_eq!(entry.title, "a");
    assert_eq!(entry.played_at, 1_000);
    // Whatever lists what was played is told, once: not again as it plays on.
    assert_eq!(rig.played(), 1);
    rig.status(PlaybackStatus::Paused);
    rig.at(30.0);
    rig.status(PlaybackStatus::Playing);
    assert_eq!(rig.played(), 1);
}

#[test]
fn a_file_that_would_not_open_leaves_no_history() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    assert_eq!(rig.fails(A), Verdict::Pass);
    rig.goes_idle();
    assert_eq!(rig.remembered(A), None);
    assert_eq!(rig.played(), 0);
}

#[test]
fn writes_down_the_place_every_few_seconds_of_film_and_on_pause() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));

    rig.at(1.0);
    rig.at(4.9);
    assert_eq!(rig.remembered(A).unwrap().position, 0.0);
    rig.at(5.0);
    assert_eq!(rig.remembered(A).unwrap().position, 5.0);
    assert_eq!(rig.remembered(A).unwrap().duration, Some(TWO_HOURS));

    // A pause is written down at once, however little has passed.
    rig.at(6.5);
    rig.time.store(2_000, Ordering::Release);
    rig.status(PlaybackStatus::Paused);
    let entry = rig.remembered(A).unwrap();
    assert_eq!(entry.position, 6.5);
    assert_eq!(entry.played_at, 2_000);

    // A seek back counts as movement too.
    rig.status(PlaybackStatus::Playing);
    rig.at(0.5);
    assert_eq!(rig.remembered(A).unwrap().position, 0.5);
}

#[test]
fn positions_reported_before_the_new_file_has_loaded_belong_to_the_old_one() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    rig.at(2537.0);

    rig.conductor.next().unwrap();
    rig.see(PlayerChange::Media {
        source: Some(B.to_owned()),
        title: Some("b".to_owned()),
    });
    // The old film's last report arrives late.
    rig.at(2537.1);
    rig.status(PlaybackStatus::Loading);
    rig.status(PlaybackStatus::Playing);
    rig.status(PlaybackStatus::Paused);

    assert_eq!(rig.remembered(A).unwrap().position, 2537.0);
    assert_eq!(rig.remembered(B).unwrap().position, 0.0);
}

#[test]
fn the_place_is_written_down_when_the_file_changes_and_when_the_app_ends() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    rig.at(602.0);
    rig.at(604.0);
    assert_eq!(rig.remembered(A).unwrap().position, 602.0);

    rig.conductor.next().unwrap();
    rig.loads(B, Some(TWO_HOURS));
    assert_eq!(rig.remembered(A).unwrap().position, 604.0);

    rig.at(3.0);
    rig.conductor.shutdown();
    assert_eq!(rig.remembered(B).unwrap().position, 3.0);
}

#[test]
fn a_film_left_part_way_resumes_a_little_before_and_can_be_started_over() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    rig.at(2537.0);
    rig.conductor.close().unwrap();
    rig.goes_idle();

    rig.conductor.open(&all(&[A]), true).unwrap();
    assert_eq!(
        rig.last_open(),
        Call::Open {
            source: A.to_owned(),
            title: None,
            start: Some(2534.0),
        }
    );

    rig.conductor.open(&all(&[A]), false).unwrap();
    assert!(matches!(rig.last_open(), Call::Open { start: None, .. }));
}

#[test]
fn a_film_played_to_its_end_is_finished_and_starts_from_the_top_next_time() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    rig.at(7301.2);
    rig.status(PlaybackStatus::Ended);

    let entry = rig.remembered(A).unwrap();
    assert!(entry.finished);
    assert_eq!(entry.position, 0.0);
    // Nothing follows it: the player is left on its last frame.
    assert_eq!(rig.opened(), [A]);

    rig.goes_idle();
    rig.conductor.open(&all(&[A]), true).unwrap();
    assert!(matches!(rig.last_open(), Call::Open { start: None, .. }));
}

#[test]
fn when_an_item_ends_the_next_one_plays() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(120.0));
    rig.at(119.0);
    rig.status(PlaybackStatus::Ended);
    assert_eq!(rig.opened(), [A, B]);
    assert_eq!(rig.current().as_deref(), Some("b"));

    rig.loads(B, Some(120.0));
    rig.at(119.0);
    rig.status(PlaybackStatus::Ended);
    // The last item ends and nothing wraps round.
    assert_eq!(rig.opened(), [A, B]);
    assert_eq!(rig.current().as_deref(), Some("b"));
}

#[test]
fn repeating_everything_comes_round_to_the_first_item() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.conductor.set_repeat(Repeat::All);
    rig.conductor.next().unwrap();
    rig.loads(B, Some(120.0));
    rig.at(119.0);
    rig.status(PlaybackStatus::Ended);
    assert_eq!(rig.opened(), [A, B, A]);
    assert_eq!(rig.session.get().repeat, Repeat::All);
}

#[test]
fn repeating_one_item_is_left_to_the_player_which_loops_without_a_gap() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.conductor.set_repeat(Repeat::One);
    assert_eq!(rig.calls().last(), Some(&Call::Looping(true)));
    rig.conductor.set_repeat(Repeat::All);
    assert_eq!(rig.calls().last(), Some(&Call::Looping(false)));

    // A queue of one that repeats is the same loop.
    let id = rig.id_of("b");
    rig.conductor.remove(id).unwrap();
    assert_eq!(rig.calls().last(), Some(&Call::Looping(true)));
    rig.conductor.add(&all(&[C]), None).unwrap();
    assert_eq!(rig.calls().last(), Some(&Call::Looping(false)));
}

#[test]
fn if_the_player_reports_the_end_of_a_repeating_item_it_is_started_again() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.conductor.set_repeat(Repeat::One);
    rig.loads(A, Some(120.0));
    rig.at(119.0);
    rig.status(PlaybackStatus::Ended);
    assert_eq!(rig.calls().last(), Some(&Call::Restart));
}

#[test]
fn an_item_that_will_not_play_is_stepped_over_and_the_interface_is_told() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B, C]), true).unwrap();
    rig.loads(A, Some(120.0));
    rig.at(119.0);
    rig.status(PlaybackStatus::Ended);

    // The conductor says it its own way: the failure itself is not passed on.
    assert_eq!(rig.fails(B), Verdict::Handled);
    assert_eq!(rig.skipped(), ["b"]);
    assert_eq!(rig.opened(), [A, B, C]);
    assert_eq!(rig.current().as_deref(), Some("c"));

    // Its row goes on saying so, and the others say nothing.
    let failed = |title: &str| {
        let snapshot = rig.conductor.snapshot();
        snapshot
            .items
            .iter()
            .find(|item| item.title == title)
            .and_then(|item| item.failed.clone())
    };
    assert_eq!(failed("b"), Some(FailureReason::Missing));
    assert_eq!(failed("a"), None);
    assert_eq!(failed("c"), None);

    // Until it plays after all.
    rig.conductor.play(rig.id_of("b")).unwrap();
    rig.loads(B, Some(120.0));
    assert_eq!(failed("b"), Some(FailureReason::Missing));
    rig.at(1.0);
    assert_eq!(failed("b"), None);
}

#[test]
fn the_last_item_failing_is_an_ordinary_failure() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.conductor.next().unwrap();
    assert_eq!(rig.fails(B), Verdict::Pass);
    assert!(rig.skipped().is_empty());
    rig.goes_idle();
    // Nothing is open, so there is no queue either.
    assert!(rig.titles().is_empty());
}

#[test]
fn a_queue_in_which_nothing_plays_is_given_up_on_after_one_round() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B, C]), true).unwrap();
    rig.conductor.set_repeat(Repeat::All);
    assert_eq!(rig.fails(A), Verdict::Handled);
    assert_eq!(rig.fails(B), Verdict::Handled);
    // Everything has now failed in a row: going round again would never end.
    assert_eq!(rig.fails(C), Verdict::Pass);
    assert_eq!(rig.opened(), [A, B, C]);
}

#[test]
fn one_item_playing_properly_is_enough_to_keep_going_round() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.conductor.set_repeat(Repeat::All);
    for _ in 0..3 {
        assert_eq!(rig.fails(A), Verdict::Handled);
        rig.loads(B, Some(120.0));
        rig.at(119.0);
        rig.status(PlaybackStatus::Ended);
    }
    assert_eq!(rig.opened(), [A, B, A, B, A, B, A]);
}

#[test]
fn files_that_end_at_once_do_not_spin_the_queue_for_ever() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.conductor.set_repeat(Repeat::All);
    rig.loads(A, None);
    rig.status(PlaybackStatus::Ended);
    assert_eq!(rig.opened(), [A, B]);
    rig.loads(B, None);
    rig.status(PlaybackStatus::Ended);
    // Neither played at all: stop there.
    assert_eq!(rig.opened(), [A, B]);
}

#[test]
fn adding_while_something_plays_leaves_it_playing() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.loads(A, None);
    assert_eq!(rig.conductor.add(&all(&[B, C]), None).unwrap(), 2);
    assert_eq!(rig.opened(), [A]);
    assert_eq!(rig.titles(), ["a", "b", "c"]);
}

#[test]
fn adding_at_a_place_puts_it_there() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, C]), true).unwrap();
    rig.conductor.add(&all(&[B]), Some(1)).unwrap();
    assert_eq!(rig.titles(), ["a", "b", "c"]);
}

#[test]
fn adding_when_nothing_is_open_starts_playing_what_was_added() {
    let rig = Rig::new();
    rig.conductor.add(&all(&[B, C]), None).unwrap();
    assert_eq!(rig.opened(), [B]);
    assert_eq!(rig.current().as_deref(), Some("b"));
}

#[test]
fn adding_nothing_playable_is_refused() {
    let dir = std::env::temp_dir().join(format!("lumen-conductor-add-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let rig = Rig::new();
    let refused = rig
        .conductor
        .add(&[dir.to_string_lossy().into_owned()], None);
    assert!(matches!(refused, Err(AppError::Invalid(_))), "{refused:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn playing_the_item_that_is_playing_starts_it_again() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, None);
    rig.conductor.play(rig.id_of("a")).unwrap();
    assert_eq!(rig.calls().last(), Some(&Call::Restart));

    rig.conductor.play(rig.id_of("b")).unwrap();
    assert_eq!(rig.opened(), [A, B]);
    assert!(matches!(
        rig.conductor.play(4242),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn removing_what_is_playing_moves_on_and_removing_the_last_thing_closes() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, None);
    rig.conductor.remove(rig.id_of("a")).unwrap();
    assert_eq!(rig.opened(), [A, B]);
    rig.loads(B, None);

    rig.conductor.remove(rig.id_of("b")).unwrap();
    assert_eq!(rig.calls().last(), Some(&Call::Stop));
    assert!(rig.titles().is_empty());
}

#[test]
fn removing_something_else_changes_only_the_list() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.conductor.remove(rig.id_of("b")).unwrap();
    assert_eq!(rig.opened(), [A]);
    assert_eq!(rig.titles(), ["a"]);
    // Removing it again is nothing.
    rig.conductor.remove(4242).unwrap();
}

#[test]
fn moving_and_clearing_keep_what_is_playing() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B, C]), true).unwrap();
    rig.conductor.move_to(rig.id_of("c"), 0);
    assert_eq!(rig.titles(), ["c", "a", "b"]);
    assert_eq!(rig.current().as_deref(), Some("a"));

    rig.conductor.clear_others();
    assert_eq!(rig.titles(), ["a"]);
    assert_eq!(rig.opened(), [A]);
}

#[test]
fn next_and_previous_say_whether_there_was_anywhere_to_go() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    assert!(!rig.conductor.previous().unwrap());
    assert!(rig.conductor.next().unwrap());
    assert!(!rig.conductor.next().unwrap());
    assert!(rig.conductor.previous().unwrap());
    assert_eq!(rig.opened(), [A, B, A]);
}

#[test]
fn closing_empties_the_queue_and_stops_the_player() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    rig.at(700.0);
    rig.at(703.0);
    rig.conductor.close().unwrap();
    assert_eq!(rig.calls().last(), Some(&Call::Stop));
    assert!(rig.titles().is_empty());
    // And where it was is not lost.
    assert_eq!(rig.remembered(A).unwrap().position, 703.0);
}

#[test]
fn the_player_going_idle_by_itself_empties_the_queue() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, None);
    rig.goes_idle();
    assert!(rig.titles().is_empty());
    assert!(matches!(
        rig.notices.lock().last(),
        Some(Notice::Queue(queue)) if queue.items.is_empty()
    ));
}

#[test]
fn the_volume_is_remembered_but_a_boost_is_not() {
    let rig = Rig::new();
    rig.see(PlayerChange::Volume { percent: 65.0 });
    rig.see(PlayerChange::Muted { muted: true });
    assert_eq!(rig.session.get().volume, 65.0);
    assert!(rig.session.get().muted);
    rig.see(PlayerChange::Volume { percent: 180.0 });
    assert_eq!(rig.session.get().volume, 100.0);
}

#[test]
fn shuffle_and_repeat_are_as_they_were_left() {
    let db = Arc::new(Db::in_memory().unwrap());
    {
        let rig = Rig::with(db.clone(), Arc::new(|_| None));
        rig.conductor.set_shuffle(true);
        rig.conductor.set_repeat(Repeat::All);
    }
    let rig = Rig::with(db, Arc::new(|_| None));
    let queue = rig.conductor.snapshot();
    assert!(queue.shuffle);
    assert_eq!(queue.repeat, Repeat::All);
}

#[test]
fn the_length_of_what_is_playing_is_noted_in_the_queue() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    let queue = rig.conductor.snapshot();
    assert_eq!(queue.items[0].duration, Some(TWO_HOURS));
    assert_eq!(queue.items[1].duration, None);
}

#[test]
fn a_stream_that_names_itself_is_remembered_by_that_name() {
    let rig = Rig::new();
    let address = "https://example.com/watch?v=1";
    rig.conductor.open(&all(&[address]), true).unwrap();
    rig.loads(address, None);
    rig.see(PlayerChange::Media {
        source: Some(address.to_owned()),
        title: Some("A lecture".to_owned()),
    });
    assert_eq!(rig.remembered(address).unwrap().title, "A lecture");
    // Once for being opened, once for the name it then gave itself.
    assert_eq!(rig.played(), 2);
}

#[test]
fn saving_names_the_queue_and_opening_the_saved_playlist_brings_it_back() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    let saved = rig.conductor.save_as("Evening", false).unwrap();
    assert_eq!(saved.count, 2);
    assert_eq!(rig.conductor.snapshot().name.as_deref(), Some("Evening"));
    assert!(matches!(
        rig.conductor.save_as("evening", false),
        Err(AppError::Exists(_))
    ));

    rig.conductor.open(&all(&[C]), true).unwrap();
    assert_eq!(rig.conductor.snapshot().name, None);

    rig.conductor.open_saved(saved.id).unwrap();
    let queue = rig.conductor.snapshot();
    assert_eq!(queue.name.as_deref(), Some("Evening"));
    assert_eq!(rig.titles(), ["a", "b"]);
    // The length it had when it was saved came back with it.
    assert_eq!(queue.items[0].duration, Some(TWO_HOURS));
    assert_eq!(rig.opened().last().map(String::as_str), Some(A));
    assert!(matches!(
        rig.conductor.open_saved(4242),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn the_queue_follows_the_saved_playlist_it_is() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    let saved = rig.conductor.save_as("Evening", false).unwrap();

    let renamed = rig.conductor.rename_saved(saved.id, "Night").unwrap();
    assert_eq!(renamed.name, "Night");
    assert_eq!(rig.conductor.snapshot().name.as_deref(), Some("Night"));

    // Deleted from under it: what is open plays on, without the name.
    assert!(rig.conductor.delete_saved(saved.id).unwrap());
    assert_eq!(rig.conductor.snapshot().name, None);
    assert_eq!(rig.titles(), ["a", "b"]);
    // There is nothing to delete a second time.
    assert!(!rig.conductor.delete_saved(saved.id).unwrap());
    // Undone while it is still that queue: it is that playlist again.
    rig.conductor.undelete_saved(saved.id).unwrap();
    assert_eq!(rig.conductor.snapshot().name.as_deref(), Some("Night"));

    // A queue that has become something else is not named by any of it.
    rig.conductor.open(&all(&[C]), true).unwrap();
    rig.conductor.rename_saved(saved.id, "Late").unwrap();
    assert!(rig.conductor.delete_saved(saved.id).unwrap());
    rig.conductor.undelete_saved(saved.id).unwrap();
    assert_eq!(rig.conductor.snapshot().name, None);
}

#[test]
fn what_was_chosen_for_a_file_is_written_down_and_given_back_when_it_opens_again() {
    use crate::engine::types::SubtitleChoice;

    let rig = Rig::new();
    rig.conductor.open(&all(&[A]), true).unwrap();
    rig.loads(A, Some(TWO_HOURS));
    rig.at(600.0);
    // Opened for the first time: there was nothing to give it.
    assert_eq!(*rig.deck.opened_with.lock(), [None]);

    // A track is chosen while the film is paused: nothing has moved, and
    // the choice is still written down.
    rig.status(PlaybackStatus::Paused);
    let chosen = FileState {
        audio: Some(2),
        subtitle: Some(SubtitleChoice::Track(3)),
        audio_delay: 0.1,
        ..FileState::default()
    };
    *rig.deck.chosen.lock() = chosen.clone();
    rig.status(PlaybackStatus::Playing);
    rig.status(PlaybackStatus::Paused);
    assert_eq!(rig.remembered(A).unwrap().state, Some(chosen.clone()));

    // Another file, then this one again, from its beginning: what was
    // chosen for it is about the film, not about a place in it.
    rig.conductor.open(&all(&[B]), true).unwrap();
    rig.loads(B, Some(TWO_HOURS));
    rig.conductor.open(&all(&[A]), false).unwrap();
    assert_eq!(
        *rig.deck.opened_with.lock(),
        [None, None, Some(chosen.clone())]
    );
    assert_eq!(
        rig.deck.calls.lock().last(),
        Some(&Call::Open {
            source: A.to_owned(),
            title: None,
            start: None,
        })
    );
}

#[test]
fn a_title_from_a_playlist_file_is_passed_to_the_player() {
    let dir = std::env::temp_dir().join(format!("lumen-conductor-m3u-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let list = dir.join("list.m3u");
    std::fs::write(&list, "#EXTM3U\n#EXTINF:120,Solaris\n/films/a.mkv\n").unwrap();
    let rig = Rig::new();
    rig.conductor
        .open(&[list.to_string_lossy().into_owned()], true)
        .unwrap();
    assert_eq!(
        rig.last_open(),
        Call::Open {
            source: A.to_owned(),
            title: Some("Solaris".to_owned()),
            start: None,
        }
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn lengths_are_looked_up_in_the_background_from_the_history_first() {
    let db = Arc::new(Db::in_memory().unwrap());
    history::opened(&db, A, "a", 1).unwrap();
    history::progressed(&db, A, 10.0, Some(TWO_HOURS), None, 2).unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let prober: Prober = {
        let asked = asked.clone();
        Arc::new(move |path| {
            asked.lock().push(path.to_string_lossy().into_owned());
            (path != Path::new(C)).then_some(95.0)
        })
    };
    let rig = Rig::with(db, prober);
    rig.conductor
        .open(&all(&[A, B, C, "https://example.com/live"]), false)
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let queue = rig.conductor.snapshot();
        if queue.items[0].duration.is_some() && queue.items[1].duration.is_some() {
            assert_eq!(queue.items[0].duration, Some(TWO_HOURS));
            assert_eq!(queue.items[1].duration, Some(95.0));
            break;
        }
        assert!(Instant::now() < deadline, "lengths never arrived");
        std::thread::sleep(Duration::from_millis(5));
    }
    // Let the search finish, then: the file already in the history was not
    // asked again, nor was the address, and the interface heard about it.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(*asked.lock(), [B, C]);
    assert!(rig.notices.lock().iter().any(|notice| matches!(
        notice,
        Notice::Queue(queue) if queue.items.get(1).is_some_and(|item| item.duration == Some(95.0))
    )));
}

#[test]
fn the_interface_hears_that_a_file_ended_before_it_hears_what_came_next() {
    let rig = Rig::new();
    rig.conductor.open(&all(&[A, B]), true).unwrap();
    rig.loads(A, Some(120.0));
    rig.at(119.0);
    let opened_when_passed = Mutex::new(None);
    rig.conductor.observe(
        &PlayerChange::Status {
            status: PlaybackStatus::Ended,
        },
        || *opened_when_passed.lock() = Some(rig.opened().len()),
    );
    // When the change went on to the interface, the next file had not been asked for yet.
    assert_eq!(*opened_when_passed.lock(), Some(1));
    assert_eq!(rig.opened().len(), 2);
}
