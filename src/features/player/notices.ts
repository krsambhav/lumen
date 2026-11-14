import { toast } from "sonner";
import { runAction } from "@/actions/registry";
import { events, type Subscription, subscription } from "@/ipc";
import { formatTimecode } from "@/lib/timecode";
import { useChrome } from "./chrome";
import { showOsd } from "./osd";
import { usePlayer } from "./store";

/**
 * The toast that says a film was resumed, if one is up. Each gets an id of
 * its own: a toast made under an id that was dismissed a frame earlier can
 * be taken for the one that was dismissed and removed with it, and one film
 * giving way to another does exactly that.
 */
let resumed: string | null = null;
let resumes = 0;

/**
 * Says what the player did on its own account (DESIGN.md §7): that a film
 * started where it was left, with the way to start it over; and, when the
 * chrome is not there to show it, what has just started playing.
 */
export function connectPlaybackNotices(): Subscription {
  const listening = subscription(
    events.playerChanged.listen((event) => {
      const change = event.payload;
      if (change.type === "resumed") {
        const { duration } = usePlayer.getState();
        // A toast, not the on-screen display: it has a follow-up to offer.
        if (resumed !== null) {
          toast.dismiss(resumed);
        }
        resumes += 1;
        const id = `resumed-${resumes}`;
        resumed = id;
        const gone = () => {
          if (resumed === id) {
            resumed = null;
          }
        };
        toast(`Resumed at ${formatTimecode(change.seconds, duration ?? change.seconds)}`, {
          id,
          action: {
            label: "Start over",
            onClick: () => runAction("playback.start", "control"),
          },
          onDismiss: gone,
          onAutoClose: gone,
        });
      }
    }),
  );

  // One item giving way to the next: with the chrome up the title bar says
  // what is playing; without it, this does.
  const unsubscribe = usePlayer.subscribe((state, before) => {
    const changed = state.source !== before.source || state.title !== before.title;
    if (changed && resumed !== null) {
      // What it said was about the film that was open.
      toast.dismiss(resumed);
      resumed = null;
    }
    if (changed && state.source !== null && before.source !== null && state.title) {
      if (!useChrome.getState().visible) {
        showOsd({ label: state.title });
      }
    }
  });

  return {
    ready: listening.ready,
    stop: () => {
      unsubscribe();
      listening.stop();
    },
  };
}
