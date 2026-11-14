import { create } from "zustand";
import { commands, events, type QueueSnapshot, type Subscription, subscription } from "@/ipc";

/** Mirrors `QueueSnapshot::default()` in src-tauri/src/playlist/queue.rs. */
export const EMPTY_QUEUE: QueueSnapshot = {
  items: [],
  current: null,
  name: null,
  repeat: "off",
  shuffle: false,
  hasNext: false,
  hasPrevious: false,
};

/** The queue, exactly as the backend last said it is. */
export const useQueue = create<QueueSnapshot>(() => EMPTY_QUEUE);

/** True when there is more than one thing to play, so Next and Previous mean something. */
export function hasSeveral(queue: Pick<QueueSnapshot, "items">): boolean {
  return queue.items.length > 1;
}

/** Where the open item is in the list, counting from zero, or -1. */
export function currentIndex(queue: Pick<QueueSnapshot, "items" | "current">): number {
  return queue.items.findIndex((item) => item.id === queue.current);
}

/** The length of the items whose length is known, in seconds, and whether that is all of them. */
export function totalLength(queue: Pick<QueueSnapshot, "items">): {
  seconds: number;
  complete: boolean;
} {
  let seconds = 0;
  let complete = true;
  for (const item of queue.items) {
    if (item.duration === null) {
      complete = false;
    } else {
      seconds += item.duration;
    }
  }
  return { seconds, complete };
}

/**
 * Loads the queue and keeps it current. The backend sends the whole queue
 * with every change, so whichever arrives last is the truth.
 */
export function connectQueue(): Subscription {
  let heard = false;
  let stopped = false;
  const listening = subscription(
    events.queueChanged.listen((event) => {
      heard = true;
      useQueue.setState(event.payload, true);
    }),
  );
  void commands.playlistSnapshot().then((snapshot) => {
    // A change that arrived while the snapshot was on its way is newer.
    if (!stopped && !heard) {
      useQueue.setState(snapshot, true);
    }
  });
  return {
    ready: listening.ready,
    stop: () => {
      stopped = true;
      listening.stop();
    },
  };
}
