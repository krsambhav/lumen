import { toast } from "sonner";
import { create } from "zustand";
import { type CastSnapshot, commands, events, type Subscription, subscription } from "@/ipc";

export const NO_CASTING: CastSnapshot = { searching: false, devices: [], session: null };

interface CastState extends CastSnapshot {
  /** The device menu is open. An action can open it too. */
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

export const useCast = create<CastState>((set) => ({
  ...NO_CASTING,
  menuOpen: false,
  setMenuOpen: (menuOpen) => set({ menuOpen }),
}));

/** True while a film is on a TV, or on its way there. */
export function isCasting(state: Pick<CastSnapshot, "session">): boolean {
  return state.session !== null && state.session.phase !== "choosing";
}

/** Loads casting's state and keeps it current; says when a session fails. */
export function connectCast(): Subscription {
  const changes = subscription(
    events.castChanged.listen((event) => {
      useCast.setState(event.payload);
    }),
  );
  const failures = subscription(
    events.castFailed.listen((event) => {
      toast.error("Casting stopped", {
        id: "cast-failed",
        description: event.payload,
        // A failure stays until it is closed (DESIGN.md §7).
        duration: Number.POSITIVE_INFINITY,
      });
    }),
  );
  void Promise.resolve(commands.castSnapshot()).then((snapshot) => {
    useCast.setState(snapshot);
  });
  return {
    ready: Promise.all([changes.ready, failures.ready]).then(() => undefined),
    stop: () => {
      changes.stop();
      failures.stop();
    },
  };
}
