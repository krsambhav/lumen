//! The queue: what is lined up to play, in what order, and which of it is
//! playing. It knows nothing about the player; it only answers "what next?".

use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use crate::engine::failure::FailureReason;

/// One thing in the queue.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// Unique within this run of the app; the interface refers to items by it.
    pub id: u32,
    pub source: String,
    pub title: String,
    /// Seconds, once known.
    #[specta(type = Option<Number>)]
    pub duration: Option<f64>,
    /// Why it was stepped over the last time its turn came, if it was. It is
    /// forgotten once the item does play.
    pub failed: Option<FailureReason>,
}

/// Something on its way into the queue.
#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    pub source: String,
    pub title: String,
    /// Seconds, if already known.
    pub duration: Option<f64>,
}

impl Incoming {
    pub fn new(source: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            title: title.into(),
            duration: None,
        }
    }
}

/// What happens when the queue runs out, or an item ends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Repeat {
    /// Stop after the last item.
    #[default]
    Off,
    /// Start again from the first.
    All,
    /// Play the current item again when it ends.
    One,
}

/// The queue as the interface sees it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    /// In the order they are listed, which is the order they play in unless
    /// shuffle is on.
    pub items: Vec<QueueItem>,
    /// The id of the item that is open, if any.
    pub current: Option<u32>,
    /// The saved playlist this queue was opened from or last saved as.
    pub name: Option<String>,
    pub repeat: Repeat,
    pub shuffle: bool,
    /// Whether Next and Previous have somewhere to go.
    pub has_next: bool,
    pub has_previous: bool,
}

/// What removing an item did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removed {
    /// There was no such item.
    Nothing,
    /// An item that was not playing went; playback carries on.
    Other,
    /// The playing item went. `next` is what should play instead: what
    /// followed it, or failing that what came before it, or nothing if it
    /// was the only item.
    Current { next: Option<u32> },
}

/// The saved playlist a queue is: the one it was opened from or saved as.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Kept {
    id: u32,
    name: String,
    /// It has been deleted and may yet be brought back. Until it is, the
    /// queue has no name to show.
    deleted: bool,
}

pub struct Queue {
    items: Vec<QueueItem>,
    current: Option<u32>,
    kept: Option<Kept>,
    repeat: Repeat,
    shuffle: bool,
    /// The ids in the order they play while shuffle is on.
    shuffled: Vec<u32>,
    next_id: u32,
    random: u64,
}

impl Queue {
    /// An empty queue. `seed` drives the shuffle.
    pub fn new(seed: u64) -> Self {
        Self {
            items: Vec::new(),
            current: None,
            kept: None,
            repeat: Repeat::Off,
            shuffle: false,
            shuffled: Vec::new(),
            next_id: 1,
            // xorshift must not start at zero.
            random: seed | 1,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn item(&self, id: u32) -> Option<&QueueItem> {
        self.items.iter().find(|item| item.id == id)
    }

    pub fn current(&self) -> Option<&QueueItem> {
        self.current.and_then(|id| self.item(id))
    }

    pub fn items(&self) -> &[QueueItem] {
        &self.items
    }

    /// Says which saved playlist this queue is: it takes that one's name.
    pub fn keep_as(&mut self, id: u32, name: String) {
        self.kept = Some(Kept {
            id,
            name,
            deleted: false,
        });
    }

    /// The saved playlist `id` has another name. Returns true if this queue
    /// is that playlist, whose name it now has too.
    pub fn renamed(&mut self, id: u32, name: &str) -> bool {
        match &mut self.kept {
            Some(kept) if kept.id == id && kept.name != name => {
                name.clone_into(&mut kept.name);
                true
            }
            _ => false,
        }
    }

    /// The saved playlist `id` has been deleted, or brought back. Returns
    /// true if this queue is that playlist: it goes on without the name, and
    /// has it again if the playlist comes back while it is still this queue.
    pub fn deleted(&mut self, id: u32, deleted: bool) -> bool {
        match &mut self.kept {
            Some(kept) if kept.id == id && kept.deleted != deleted => {
                kept.deleted = deleted;
                true
            }
            _ => false,
        }
    }

    /// Replaces the queue with `incoming`, in that order, and makes the
    /// first of them current. Returns its id. The new queue has no name.
    pub fn set(&mut self, incoming: Vec<Incoming>) -> Option<u32> {
        self.items.clear();
        self.shuffled.clear();
        self.current = None;
        self.kept = None;
        let at = self.items.len();
        let added = self.push(at, incoming);
        self.current = added.first().copied();
        if self.shuffle {
            self.reshuffle();
        }
        self.current
    }

    /// Adds `incoming` to the end. Returns their ids. Nothing becomes current.
    pub fn append(&mut self, incoming: Vec<Incoming>) -> Vec<u32> {
        self.insert(self.items.len(), incoming)
    }

    /// Adds `incoming` so that the first of them is at `index` in the list
    /// (or at the end, if the list is shorter). Returns their ids. Nothing
    /// becomes current.
    pub fn insert(&mut self, index: usize, incoming: Vec<Incoming>) -> Vec<u32> {
        let added = self.push(index.min(self.items.len()), incoming);
        if self.shuffle {
            // Each newcomer goes somewhere after what is playing, so it is
            // neither skipped nor guaranteed to be last.
            for id in &added {
                let after = self
                    .current
                    .and_then(|current| self.shuffled.iter().position(|other| *other == current))
                    .map_or(0, |at| at + 1);
                let span = self.shuffled.len() - after + 1;
                let at = after + self.below(span);
                self.shuffled.insert(at, *id);
            }
        }
        added
    }

    fn push(&mut self, at: usize, incoming: Vec<Incoming>) -> Vec<u32> {
        let mut added = Vec::with_capacity(incoming.len());
        let mut fresh = Vec::with_capacity(incoming.len());
        for Incoming {
            source,
            title,
            duration,
        } in incoming
        {
            let id = self.next_id;
            self.next_id += 1;
            fresh.push(QueueItem {
                id,
                source,
                title,
                duration: duration.filter(|seconds| seconds.is_finite() && *seconds > 0.0),
                failed: None,
            });
            added.push(id);
        }
        self.items.splice(at..at, fresh);
        added
    }

    /// Takes an item out.
    pub fn remove(&mut self, id: u32) -> Removed {
        let Some(index) = self.items.iter().position(|item| item.id == id) else {
            return Removed::Nothing;
        };
        if self.current != Some(id) {
            self.items.remove(index);
            self.shuffled.retain(|other| *other != id);
            return Removed::Other;
        }
        // What would have followed it plays instead; at the end of the
        // order, what came before it. Nothing wraps round just because
        // something was removed.
        let order = self.order();
        let place = order.iter().position(|other| *other == id);
        let next = place
            .and_then(|at| {
                order
                    .get(at + 1)
                    .or_else(|| at.checked_sub(1).and_then(|before| order.get(before)))
            })
            .copied();
        self.items.remove(index);
        self.shuffled.retain(|other| *other != id);
        self.current = next;
        Removed::Current { next }
    }

    /// Moves an item to `index` in the list. The play order under shuffle is
    /// not the list's order and does not change.
    pub fn move_to(&mut self, id: u32, index: usize) -> bool {
        let Some(from) = self.items.iter().position(|item| item.id == id) else {
            return false;
        };
        let item = self.items.remove(from);
        let to = index.min(self.items.len());
        self.items.insert(to, item);
        true
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.shuffled.clear();
        self.current = None;
        self.kept = None;
    }

    /// Takes everything out except what is playing. Returns what went, with
    /// where each was in the list, so that it can be put back.
    pub fn keep_only_current(&mut self) -> Vec<(usize, QueueItem)> {
        let current = self.current;
        let mut removed = Vec::new();
        let mut kept = Vec::new();
        for (index, item) in std::mem::take(&mut self.items).into_iter().enumerate() {
            if Some(item.id) == current {
                kept.push(item);
            } else {
                removed.push((index, item));
            }
        }
        self.items = kept;
        self.shuffled.retain(|id| Some(*id) == current);
        if !removed.is_empty() {
            self.kept = None;
        }
        removed
    }

    /// Makes `id` the current item. False if there is no such item.
    pub fn select(&mut self, id: u32) -> bool {
        if self.item(id).is_none() {
            return false;
        }
        self.current = Some(id);
        true
    }

    /// Records an item's length once the player knows it.
    pub fn set_duration(&mut self, id: u32, duration: f64) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) if item.duration != Some(duration) => {
                item.duration = Some(duration);
                true
            }
            _ => false,
        }
    }

    /// Notes that an item would not play, or (`None`) that it has now
    /// played after all. True if that changed anything.
    pub fn set_failed(&mut self, id: u32, failed: Option<FailureReason>) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) if item.failed != failed => {
                item.failed = failed;
                true
            }
            _ => false,
        }
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.repeat = repeat;
    }

    /// Turns shuffle on or off. Turning it on deals a new order that starts
    /// with what is playing; turning it off goes back to the list's order.
    pub fn set_shuffle(&mut self, shuffle: bool) {
        self.shuffle = shuffle;
        if shuffle {
            self.reshuffle();
        } else {
            self.shuffled.clear();
        }
    }

    /// What plays after the current item ends by itself. Makes it current.
    pub fn after_end(&mut self) -> Option<u32> {
        if self.repeat == Repeat::One && self.current.is_some() {
            return self.current;
        }
        self.step(1)
    }

    /// What the Next command goes to. Makes it current. Repeating one item
    /// does not trap Next on it.
    pub fn next(&mut self) -> Option<u32> {
        self.step(1)
    }

    /// What the Previous command goes to. Makes it current.
    pub fn previous(&mut self) -> Option<u32> {
        self.step(-1)
    }

    fn step(&mut self, by: isize) -> Option<u32> {
        let target = self.neighbour(by)?;
        // Coming round again under shuffle deals a fresh order, so the second
        // pass is not the first one over again.
        let wrapped = self.wraps(by);
        if wrapped && self.shuffle && by > 0 && self.items.len() > 1 {
            let last = self.current;
            self.current = None;
            self.reshuffle();
            // Do not open the new pass with what has only just played.
            if self.shuffled.first().copied() == last && self.shuffled.len() > 1 {
                self.shuffled.swap(0, 1);
            }
            self.current = self.shuffled.first().copied();
            return self.current;
        }
        self.current = Some(target);
        self.current
    }

    /// Whether stepping `by` from the current item leaves the end of the order.
    fn wraps(&self, by: isize) -> bool {
        let order = self.order();
        let Some(place) = self
            .current
            .and_then(|current| order.iter().position(|id| *id == current))
        else {
            return false;
        };
        let target = place as isize + by;
        target < 0 || target >= order.len() as isize
    }

    /// The item `by` places from the current one in play order, wrapping
    /// round only when the queue repeats.
    fn neighbour(&self, by: isize) -> Option<u32> {
        let order = self.order();
        if order.is_empty() {
            return None;
        }
        let Some(place) = self
            .current
            .and_then(|current| order.iter().position(|id| *id == current))
        else {
            // Nothing is current: Next starts at the beginning.
            return (by > 0).then(|| order[0]);
        };
        let count = order.len() as isize;
        let target = place as isize + by;
        if (0..count).contains(&target) {
            return Some(order[target as usize]);
        }
        if self.repeat == Repeat::Off {
            return None;
        }
        Some(order[target.rem_euclid(count) as usize])
    }

    /// The ids in the order they play.
    fn order(&self) -> Vec<u32> {
        if self.shuffle {
            self.shuffled.clone()
        } else {
            self.items.iter().map(|item| item.id).collect()
        }
    }

    /// Deals a new shuffled order, with the current item first.
    fn reshuffle(&mut self) {
        let mut ids: Vec<u32> = self
            .items
            .iter()
            .map(|item| item.id)
            .filter(|id| Some(*id) != self.current)
            .collect();
        // Fisher–Yates.
        for index in (1..ids.len()).rev() {
            let other = self.below(index + 1);
            ids.swap(index, other);
        }
        self.shuffled = self.current.into_iter().chain(ids).collect();
    }

    /// A number in `0..bound`. xorshift64*: plenty for dealing a playlist.
    fn below(&mut self, bound: usize) -> usize {
        self.random ^= self.random >> 12;
        self.random ^= self.random << 25;
        self.random ^= self.random >> 27;
        let value = self.random.wrapping_mul(0x2545_F491_4F6C_DD1D);
        ((value >> 33) as usize) % bound.max(1)
    }

    pub fn snapshot(&self) -> QueueSnapshot {
        QueueSnapshot {
            items: self.items.clone(),
            current: self.current,
            name: self
                .kept
                .as_ref()
                .filter(|kept| !kept.deleted)
                .map(|kept| kept.name.clone()),
            repeat: self.repeat,
            shuffle: self.shuffle,
            has_next: self.neighbour(1).is_some(),
            has_previous: self.neighbour(-1).is_some(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(names: &[&str]) -> Vec<Incoming> {
        names
            .iter()
            .map(|name| Incoming::new(format!("/films/{name}.mkv"), *name))
            .collect()
    }

    fn titles(queue: &Queue) -> Vec<&str> {
        queue
            .items()
            .iter()
            .map(|item| item.title.as_str())
            .collect()
    }

    fn queue_of(names: &[&str]) -> Queue {
        let mut queue = Queue::new(7);
        queue.set(named(names));
        queue
    }

    fn title(queue: &Queue) -> Option<&str> {
        queue.current().map(|item| item.title.as_str())
    }

    #[test]
    fn opens_at_the_first_item() {
        let queue = queue_of(&["a", "b", "c"]);
        assert_eq!(title(&queue), Some("a"));
        assert_eq!(queue.len(), 3);
    }

    #[test]
    fn plays_through_in_order_and_stops_at_the_end() {
        let mut queue = queue_of(&["a", "b", "c"]);
        queue.after_end();
        assert_eq!(title(&queue), Some("b"));
        queue.after_end();
        assert_eq!(title(&queue), Some("c"));
        assert_eq!(queue.after_end(), None);
        // The last item stays current: the film is still on screen, ended.
        assert_eq!(title(&queue), Some("c"));
    }

    #[test]
    fn previous_stops_at_the_beginning() {
        let mut queue = queue_of(&["a", "b"]);
        assert_eq!(queue.previous(), None);
        queue.next();
        queue.previous();
        assert_eq!(title(&queue), Some("a"));
    }

    #[test]
    fn repeat_all_goes_round_in_both_directions() {
        let mut queue = queue_of(&["a", "b", "c"]);
        queue.set_repeat(Repeat::All);
        queue.previous();
        assert_eq!(title(&queue), Some("c"));
        queue.after_end();
        assert_eq!(title(&queue), Some("a"));
    }

    #[test]
    fn repeat_one_replays_at_the_end_but_does_not_trap_next() {
        let mut queue = queue_of(&["a", "b"]);
        queue.set_repeat(Repeat::One);
        queue.after_end();
        assert_eq!(title(&queue), Some("a"));
        queue.next();
        assert_eq!(title(&queue), Some("b"));
        // Next from the last item comes round, as it does when repeating all.
        queue.next();
        assert_eq!(title(&queue), Some("a"));
    }

    #[test]
    fn says_whether_next_and_previous_have_somewhere_to_go() {
        let mut queue = queue_of(&["a", "b"]);
        let at_start = queue.snapshot();
        assert!(at_start.has_next);
        assert!(!at_start.has_previous);
        queue.next();
        let at_end = queue.snapshot();
        assert!(!at_end.has_next);
        assert!(at_end.has_previous);
        queue.set_repeat(Repeat::All);
        assert!(queue.snapshot().has_next);

        let single = queue_of(&["only"]).snapshot();
        assert!(!single.has_next && !single.has_previous);
    }

    #[test]
    fn appending_leaves_what_is_playing_alone() {
        let mut queue = queue_of(&["a"]);
        let added = queue.append(named(&["b", "c"]));
        assert_eq!(added.len(), 2);
        assert_eq!(title(&queue), Some("a"));
        queue.next();
        assert_eq!(title(&queue), Some("b"));
    }

    #[test]
    fn ids_are_never_reused() {
        let mut queue = queue_of(&["a", "b"]);
        let first: Vec<u32> = queue.snapshot().items.iter().map(|item| item.id).collect();
        queue.set(named(&["c"]));
        let second = queue.snapshot().items[0].id;
        assert!(!first.contains(&second));
    }

    #[test]
    fn removing_another_item_does_not_disturb_playback() {
        let mut queue = queue_of(&["a", "b", "c"]);
        let b = queue.snapshot().items[1].id;
        assert_eq!(queue.remove(b), Removed::Other);
        assert_eq!(title(&queue), Some("a"));
        queue.next();
        assert_eq!(title(&queue), Some("c"));
        assert_eq!(queue.remove(b), Removed::Nothing);
    }

    #[test]
    fn removing_what_is_playing_moves_on_to_what_followed_it() {
        let mut queue = queue_of(&["a", "b", "c"]);
        let ids: Vec<u32> = queue.snapshot().items.iter().map(|item| item.id).collect();
        assert_eq!(
            queue.remove(ids[0]),
            Removed::Current { next: Some(ids[1]) }
        );
        assert_eq!(title(&queue), Some("b"));

        // Removing the last one goes back to the one before it; it does not
        // come round to the first, even when repeating.
        queue.set_repeat(Repeat::All);
        queue.next();
        assert_eq!(
            queue.remove(ids[2]),
            Removed::Current { next: Some(ids[1]) }
        );
        assert_eq!(title(&queue), Some("b"));

        // Removing the only one leaves nothing to play.
        assert_eq!(queue.remove(ids[1]), Removed::Current { next: None });
        assert_eq!(queue.current(), None);
        assert!(queue.is_empty());
    }

    #[test]
    fn inserting_puts_new_items_where_they_were_dropped() {
        let mut queue = queue_of(&["a", "d"]);
        queue.insert(1, named(&["b", "c"]));
        assert_eq!(titles(&queue), ["a", "b", "c", "d"]);
        // Past the end means the end.
        queue.insert(99, named(&["e"]));
        assert_eq!(titles(&queue), ["a", "b", "c", "d", "e"]);
        assert_eq!(title(&queue), Some("a"));
    }

    #[test]
    fn keeps_a_length_it_was_told_and_drops_one_that_is_not_a_length() {
        let mut queue = Queue::new(3);
        queue.set(vec![
            Incoming {
                duration: Some(7305.0),
                ..Incoming::new("/a.mkv", "a")
            },
            Incoming {
                duration: Some(f64::NAN),
                ..Incoming::new("/b.mkv", "b")
            },
        ]);
        assert_eq!(queue.items()[0].duration, Some(7305.0));
        assert_eq!(queue.items()[1].duration, None);
    }

    #[test]
    fn clearing_the_rest_keeps_what_is_playing_and_says_what_went() {
        let mut queue = queue_of(&["a", "b", "c"]);
        queue.next();
        queue.set_shuffle(true);
        let removed = queue.keep_only_current();
        assert_eq!(titles(&queue), ["b"]);
        assert_eq!(title(&queue), Some("b"));
        let places: Vec<(usize, &str)> = removed
            .iter()
            .map(|(index, item)| (*index, item.title.as_str()))
            .collect();
        assert_eq!(places, [(0, "a"), (2, "c")]);
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn a_name_lasts_until_the_queue_becomes_something_else() {
        let mut queue = queue_of(&["a", "b"]);
        queue.keep_as(7, "Evening".to_owned());
        assert_eq!(queue.snapshot().name.as_deref(), Some("Evening"));
        // Adding to a named playlist leaves it that playlist, changed.
        queue.append(named(&["c"]));
        assert_eq!(queue.snapshot().name.as_deref(), Some("Evening"));
        queue.set(named(&["d"]));
        assert_eq!(queue.snapshot().name, None);
    }

    #[test]
    fn follows_the_saved_playlist_it_is_and_no_other() {
        let mut queue = queue_of(&["a", "b"]);
        queue.keep_as(7, "Evening".to_owned());

        // Another playlist's changes are not this one's.
        assert!(!queue.renamed(8, "Night"));
        assert!(!queue.deleted(8, true));
        assert_eq!(queue.snapshot().name.as_deref(), Some("Evening"));

        assert!(queue.renamed(7, "Night"));
        assert_eq!(queue.snapshot().name.as_deref(), Some("Night"));
        // Told the name it already has, nothing changed.
        assert!(!queue.renamed(7, "Night"));

        // Deleted: it plays on without the name, and has it again if the
        // playlist is brought back.
        assert!(queue.deleted(7, true));
        assert_eq!(queue.snapshot().name, None);
        assert!(queue.deleted(7, false));
        assert_eq!(queue.snapshot().name.as_deref(), Some("Night"));
    }

    #[test]
    fn a_playlist_brought_back_does_not_name_a_queue_that_is_something_else_by_then() {
        let mut queue = queue_of(&["a", "b"]);
        queue.keep_as(7, "Evening".to_owned());
        assert!(queue.deleted(7, true));
        queue.set(named(&["c"]));
        assert!(!queue.deleted(7, false));
        assert_eq!(queue.snapshot().name, None);
    }

    #[test]
    fn moving_reorders_the_list_and_so_the_play_order() {
        let mut queue = queue_of(&["a", "b", "c"]);
        let c = queue.snapshot().items[2].id;
        assert!(queue.move_to(c, 1));
        let titles: Vec<String> = queue
            .snapshot()
            .items
            .into_iter()
            .map(|item| item.title)
            .collect();
        assert_eq!(titles, ["a", "c", "b"]);
        queue.next();
        assert_eq!(title(&queue), Some("c"));
        // Past the end means the end.
        assert!(queue.move_to(c, 99));
        assert_eq!(queue.snapshot().items[2].title, "c");
        assert!(!queue.move_to(4242, 0));
    }

    #[test]
    fn selecting_jumps_to_an_item() {
        let mut queue = queue_of(&["a", "b", "c"]);
        let c = queue.snapshot().items[2].id;
        assert!(queue.select(c));
        assert_eq!(title(&queue), Some("c"));
        assert!(!queue.select(4242));
    }

    #[test]
    fn shuffle_plays_every_item_once_starting_with_what_is_playing() {
        let names: Vec<String> = (0..20).map(|index| format!("film {index:02}")).collect();
        let borrowed: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut queue = queue_of(&borrowed);
        queue.next();
        queue.set_shuffle(true);
        assert_eq!(title(&queue), Some("film 01"));

        let mut played = vec![title(&queue).unwrap().to_owned()];
        while queue.after_end().is_some() {
            played.push(title(&queue).unwrap().to_owned());
        }
        assert_eq!(played.len(), 20);
        let mut sorted = played.clone();
        sorted.sort();
        assert_eq!(sorted, names);
        // And not in the list's own order.
        assert_ne!(played[1..], names[2..]);
    }

    #[test]
    fn shuffle_with_repeat_deals_a_new_order_each_time_round() {
        let names: Vec<String> = (0..12).map(|index| format!("{index:02}")).collect();
        let borrowed: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut queue = queue_of(&borrowed);
        queue.set_shuffle(true);
        queue.set_repeat(Repeat::All);

        let pass = |queue: &mut Queue| {
            let mut played = vec![title(queue).unwrap().to_owned()];
            for _ in 1..12 {
                queue.after_end();
                played.push(title(queue).unwrap().to_owned());
            }
            played
        };
        let first = pass(&mut queue);
        let last_of_first = first.last().unwrap().clone();
        queue.after_end();
        // The new pass does not open with what has only just played.
        assert_ne!(title(&queue), Some(last_of_first.as_str()));
        let second = pass(&mut queue);
        assert_ne!(first, second);
        let mut sorted = second.clone();
        sorted.sort();
        assert_eq!(sorted, names);
    }

    #[test]
    fn something_added_while_shuffling_is_played_later_not_skipped() {
        let mut queue = queue_of(&["a", "b", "c"]);
        queue.set_shuffle(true);
        let added = queue.append(named(&["late"]));
        let mut played = vec![queue.current().unwrap().id];
        while let Some(id) = queue.after_end() {
            played.push(id);
        }
        assert_eq!(played.len(), 4);
        assert!(played[1..].contains(&added[0]));
    }

    #[test]
    fn turning_shuffle_off_returns_to_the_list() {
        let mut queue = queue_of(&["a", "b", "c", "d"]);
        queue.set_shuffle(true);
        queue.set_shuffle(false);
        queue.next();
        assert_eq!(title(&queue), Some("b"));
    }

    #[test]
    fn learns_how_long_an_item_is() {
        let mut queue = queue_of(&["a"]);
        let id = queue.current().unwrap().id;
        assert!(queue.set_duration(id, 7305.0));
        // Telling it again is not a change.
        assert!(!queue.set_duration(id, 7305.0));
        assert_eq!(queue.snapshot().items[0].duration, Some(7305.0));
    }

    #[test]
    fn an_empty_queue_has_nowhere_to_go() {
        let mut queue = Queue::new(1);
        assert!(queue.is_empty());
        assert_eq!(queue.next(), None);
        assert_eq!(queue.previous(), None);
        assert_eq!(queue.after_end(), None);
        assert_eq!(queue.snapshot(), QueueSnapshot::default());
    }

    #[test]
    fn next_with_nothing_current_starts_at_the_beginning() {
        let mut queue = queue_of(&["a", "b"]);
        queue.current = None;
        queue.next();
        assert_eq!(title(&queue), Some("a"));
    }

    #[test]
    fn clearing_empties_it() {
        let mut queue = queue_of(&["a", "b"]);
        queue.clear();
        assert!(queue.is_empty());
        assert_eq!(queue.current(), None);
    }
}
