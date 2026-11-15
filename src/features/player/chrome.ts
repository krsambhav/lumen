import { useEffect } from "react";
import { create } from "zustand";

/**
 * Chrome starts to fade this long after the pointer stops, or leaves the
 * window. The brief said 2 s; the user asked for 0.4 s on 2026-11-14, with
 * an eased fade (see `--dur-leave` and `--ease-leave`), then for 0.2 s on
 * 2026-11-15.
 */
export const CHROME_IDLE_MS = 200;
/**
 * A pointer resting on the chrome itself keeps it this long while the film
 * plays, so a press aimed at a control does not land after it has gone; the
 * pointer left on Play after clicking it does not pin the chrome. It was
 * 3 s; the user asked for 0.4 s on 2026-11-15 (DESIGN.md §5).
 */
export const CHROME_REST_MS = 400;

interface ChromeState {
  /** Whether the title bar and control bar are showing over the video. */
  visible: boolean;
  /** Reasons the chrome must stay: a drag, an open menu, keyboard focus, the end of the film, a pointer on a control. */
  holds: ReadonlySet<string>;
  /** The parts of the chrome the pointer is resting on: the title bar, the control bar. */
  resting: ReadonlySet<string>;
  /** The film is running. While it is not, a pointer resting on the chrome keeps it. */
  playing: boolean;
  /** The pointer moved: show the chrome and restart the idle timer. */
  wake: () => void;
  hold: (reason: string) => void;
  release: (reason: string) => void;
  /** The pointer came to rest on, or left, a part of the chrome. */
  rest: (zone: string, on: boolean) => void;
  /**
   * The pointer left the window: it rests on nothing, so the chrome goes
   * as it does when the pointer stops. Holds (an open menu, keyboard focus,
   * the end of the film) still keep it.
   */
  leave: () => void;
  setPlaying: (playing: boolean) => void;
  /** Shows the chrome and forgets every hold. Used when the stage goes away. */
  reset: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useChrome = create<ChromeState>((set, get) => {
  /** How long the chrome may stay with nothing moving, or `null` for as long as that lasts. */
  function patience(): number | null {
    const { holds, resting, playing } = get();
    if (holds.size > 0) {
      return null;
    }
    if (resting.size > 0) {
      return playing ? CHROME_REST_MS : null;
    }
    return CHROME_IDLE_MS;
  }

  function schedule() {
    clearTimeout(timer);
    const wait = patience();
    if (wait === null) {
      return;
    }
    timer = setTimeout(() => {
      // Whatever changed since was followed by its own schedule; this is the
      // one that was not cancelled.
      set({ visible: false });
    }, wait);
  }

  function withMember(members: ReadonlySet<string>, member: string, present: boolean) {
    if (members.has(member) === present) {
      return members;
    }
    const next = new Set(members);
    if (present) {
      next.add(member);
    } else {
      next.delete(member);
    }
    return next;
  }

  return {
    visible: true,
    holds: new Set(),
    resting: new Set(),
    playing: false,
    wake: () => {
      if (!get().visible) {
        set({ visible: true });
      }
      schedule();
    },
    hold: (reason) => {
      set({ visible: true, holds: withMember(get().holds, reason, true) });
      schedule();
    },
    release: (reason) => {
      if (!get().holds.has(reason)) {
        return;
      }
      set({ holds: withMember(get().holds, reason, false) });
      schedule();
    },
    rest: (zone, on) => {
      const resting = withMember(get().resting, zone, on);
      if (resting === get().resting) {
        return;
      }
      set({ resting });
      // Arriving on the chrome is movement; so is leaving it.
      schedule();
    },
    leave: () => {
      if (get().resting.size > 0) {
        set({ resting: new Set() });
      }
      schedule();
    },
    setPlaying: (playing) => {
      if (get().playing === playing) {
        return;
      }
      set({ playing });
      schedule();
    },
    reset: () => {
      clearTimeout(timer);
      set({ visible: true, holds: new Set(), resting: new Set(), playing: false });
    },
  };
});

/** Keeps the chrome up for as long as `active` is true (an open menu, a drag). */
export function useChromeHold(reason: string, active: boolean): void {
  const hold = useChrome((state) => state.hold);
  const release = useChrome((state) => state.release);
  useEffect(() => {
    if (!active) {
      return;
    }
    hold(reason);
    return () => release(reason);
  }, [active, reason, hold, release]);
}

/** What counts as a control the pointer can be aimed at: while it is on one, the chrome stays. */
const CONTROL =
  "button, [role='slider'], [role='button'], input, select, a[href], [data-chrome-aim]";

/**
 * Follows the pointer for the chrome, over the whole document:
 *
 * - On a control of the stage's chrome (a button, the seek bar and the
 *   band around it, marked `data-chrome-aim`), it holds the chrome for as
 *   long as it is there, playing or not: the user asked on 2026-11-15 that
 *   it never vanish from under a pointer on a button, and on 2026-11-16
 *   anywhere over the seek bar's section.
 * - Out of the window, it rests on nothing, and the chrome goes as it does
 *   when the pointer stops. The element under it hears no `pointerleave` of
 *   its own when it goes straight out over the window's edge in every
 *   engine, so the document's is listened for.
 */
export function connectChromePointer(): () => void {
  const root = document.documentElement;
  const onOver = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(CONTROL);
    const { hold, release } = useChrome.getState();
    if (control?.closest("[data-stage-chrome]")) {
      hold("aimed");
    } else {
      release("aimed");
    }
  };
  const onLeave = () => {
    useChrome.getState().release("aimed");
    useChrome.getState().leave();
  };
  document.addEventListener("pointerover", onOver);
  root.addEventListener("mouseleave", onLeave);
  return () => {
    document.removeEventListener("pointerover", onOver);
    root.removeEventListener("mouseleave", onLeave);
  };
}
