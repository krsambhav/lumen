import { create } from "zustand";
import { commands, events, type Subscription, subscription } from "@/ipc";

interface WindowState {
  fullscreen: boolean;
  /** The window stays above the windows of other apps. */
  keptOnTop: boolean;
  /**
   * The picture is shown in high dynamic range: its highlights can be far
   * brighter than the interface's white, which the scrims cannot hold back.
   */
  hdr: boolean;
}

export const useWindowState = create<WindowState>(() => ({
  fullscreen: false,
  keptOnTop: false,
  hdr: false,
}));

/** Follows the window's full-screen state and its dynamic range, however they change. */
export function connectWindow(): Subscription {
  const fullscreen = subscription(
    events.fullscreenChanged.listen((event) => {
      useWindowState.setState({ fullscreen: event.payload });
    }),
  );
  const range = subscription(
    events.dynamicRangeChanged.listen((event) => {
      useWindowState.setState({ hdr: event.payload });
    }),
  );
  // Said on the root, where the stylesheet outlines the stage's chrome while it is true.
  const marking = useWindowState.subscribe((state, before) => {
    if (state.hdr !== before.hdr) {
      markDynamicRange(state.hdr);
    }
  });
  void commands.windowIsFullscreen().then((result) => {
    if (result.status === "ok") {
      useWindowState.setState({ fullscreen: result.data });
    }
  });
  void Promise.resolve(commands.windowIsHdr()).then((hdr) => {
    useWindowState.setState({ hdr });
  });
  return {
    ready: Promise.all([fullscreen.ready, range.ready]).then(() => undefined),
    stop: () => {
      fullscreen.stop();
      range.stop();
      marking();
      markDynamicRange(false);
    },
  };
}

/** Marks the document while the picture is HDR (DESIGN.md §2, "Over video"). */
function markDynamicRange(hdr: boolean): void {
  if (hdr) {
    document.documentElement.dataset.hdr = "";
  } else {
    delete document.documentElement.dataset.hdr;
  }
}
