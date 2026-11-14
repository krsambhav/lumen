import { toast } from "sonner";
import { skippedBecause } from "@/features/shell/failure";
import { useInterface } from "@/features/shell/interface";
import { events, type Subscription, subscription } from "@/ipc";
import { TWO_LINES_MS } from "@/lib/notify";
import { useQueue } from "./store";

const SKIPPED = "playlist-skipped";
const OPENED = "playlist-opened";

/**
 * Says what the playlist did on its own account: that it stepped over an
 * item that would not play, and, when several things are opened at once,
 * that there is now a playlist to look at.
 */
export function connectPlaylistNotices(): Subscription {
  /** Items stepped over since the toast about them was last closed. */
  let skipped = 0;

  const listening = subscription(
    events.playbackSkipped.listen((event) => {
      const { title, reason } = event.payload;
      skipped += 1;
      const forget = () => {
        skipped = 0;
      };
      // The film goes on past it, so this leaves on its own like any other
      // event (DESIGN.md §7); the item's row goes on saying it would not play.
      toast.error(
        skipped === 1 ? skippedBecause(reason) : `Skipped ${skipped} items that would not play`,
        {
          id: SKIPPED,
          // The name on a line of its own, cut to fit: the last one, if there were several.
          description: title,
          classNames: { description: "truncate text-ink-2" },
          duration: TWO_LINES_MS,
          onDismiss: forget,
          onAutoClose: forget,
        },
      );
    }),
  );

  // Once the playlist is on show, the offer to show it has nothing left to offer.
  const unsubscribeFromPanel = useInterface.subscribe((state, before) => {
    if (state.panelOpen && !before.panelOpen) {
      toast.dismiss(OPENED);
    }
  });

  const unsubscribe = useQueue.subscribe((queue, before) => {
    // A new playlist of several things, not one that merely grew or shrank.
    const fresh =
      queue.items.length > 1 &&
      (before.items.length === 0 || queue.items[0]?.id !== before.items[0]?.id) &&
      !queue.items.some((item) => before.items.some((old) => old.id === item.id));
    if (!fresh || useInterface.getState().panelOpen) {
      return;
    }
    toast(`${queue.items.length} items in the playlist`, {
      id: OPENED,
      action: {
        label: "Show playlist",
        onClick: () => useInterface.getState().showPanel("playlist"),
      },
    });
  });

  return {
    ready: listening.ready,
    stop: () => {
      unsubscribe();
      unsubscribeFromPanel();
      listening.stop();
    },
  };
}
