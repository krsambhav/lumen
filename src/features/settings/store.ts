import { create } from "zustand";
import { readBoot } from "@/app/boot";
import { commands, events, IpcError, type Settings, type Subscription, subscription } from "@/ipc";

interface SettingsState {
  settings: Settings;
  /** The last failure to save, cleared by the next successful save. */
  saveError: IpcError | null;
  /**
   * Applies `change` at once, then persists it. If the backend refuses, the
   * settings go back to what it last accepted and `saveError` is set. The
   * promise settles once this change, or a later one that took its place,
   * has been answered.
   */
  update: (change: (current: Settings) => Settings) => Promise<void>;
  /** Replaces the settings with what the backend says they are. */
  receive: (settings: Settings) => void;
}

/*
 * A scale being dragged changes the settings many times a second. Three
 * things keep that smooth and in order:
 *
 * - One save is on its way at a time. Sent all at once they could be taken
 *   in any order, and the last to be handled, not the last to be made,
 *   would be what was kept.
 * - While one is on its way, only the newest change waits to go next: the
 *   ones in between were never going to be seen.
 * - The backend tells every window what the settings now are, this one
 *   included. Its word on a save of our own is older than what the scale
 *   already shows, so it is not taken while a save is on its way or waiting.
 */

/** What the backend last accepted, to go back to if it refuses the next. */
let accepted: Settings | null = null;
let sending = false;
let waiting: Settings | null = null;
let settled: (() => void)[] = [];

function busy(): boolean {
  return sending || waiting !== null;
}

function send(next: Settings): void {
  if (sending) {
    waiting = next;
    return;
  }
  sending = true;
  const before = accepted ?? useSettings.getState().settings;
  void commands
    .settingsSet(next)
    .then(
      (result) => result,
      () => ({ status: "error", error: { kind: "internal", message: "no answer" } }) as const,
    )
    .then((result) => {
      sending = false;
      if (result.status === "error") {
        // Whatever was waiting was built on what has just been refused.
        waiting = null;
        accepted = before;
        useSettings.setState({ settings: before, saveError: new IpcError(result.error) });
      } else {
        accepted = next;
        useSettings.setState({ saveError: null });
      }
      const then = waiting;
      waiting = null;
      if (then !== null) {
        send(then);
        return;
      }
      const done = settled;
      settled = [];
      for (const resolve of done) {
        resolve();
      }
    });
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: readBoot().settings,
  saveError: null,

  update: (change) => {
    const previous = get().settings;
    if (accepted === null) {
      accepted = previous;
    }
    const next = change(previous);
    set({ settings: next });
    const answered = new Promise<void>((resolve) => {
      settled.push(resolve);
    });
    send(next);
    return answered;
  },

  receive: (settings) => {
    if (busy()) {
      return;
    }
    accepted = settings;
    set({ settings });
  },
}));

/** Keeps this window's settings in step with changes made in any window. */
export function subscribeToSettings(): Subscription {
  return subscription(
    events.settingsChanged.listen((event) => {
      useSettings.getState().receive(event.payload);
    }),
  );
}

/** Forgets what is on its way, between tests. */
export function resetSettingsForTests(settings: Settings): void {
  accepted = null;
  sending = false;
  waiting = null;
  settled = [];
  useSettings.setState({ settings, saveError: null });
}
