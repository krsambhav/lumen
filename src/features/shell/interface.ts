import { create } from "zustand";
import { isTauri, readBoot } from "@/app/boot";
import { commands, type InspectorTab, type Interface } from "@/ipc";

/** How many recently used actions the palette keeps; `RECENT_ACTIONS` in src-tauri/src/session.rs. */
export const RECENT_ACTIONS = 8;

/** The width of the panel beside the picture, in CSS pixels: `--inspector-w` in the design tokens. */
export const INSPECTOR_WIDTH = 348;

/** How long after the last change the interface's state is sent to be stored. */
const STORE_AFTER_MS = 250;

interface InterfaceState extends Interface {
  /**
   * The panel beside the picture is open. Not remembered between runs: it
   * always starts closed (DESIGN.md §7).
   */
  panelOpen: boolean;
  /**
   * The panel has been closed and is still sliding out (DESIGN.md §5). It
   * stays in the window until it has gone, then calls `panelLeft`.
   */
  panelLeaving: boolean;
  /**
   * The panel was just opened from the keyboard and has yet to take the
   * keyboard to its list (DESIGN.md §7). The panel clears it when it has.
   */
  panelWantsKeyboard: boolean;
  setTimeRemaining: (remaining: boolean) => void;
  /** Opens the panel, on `tab` if given. */
  showPanel: (tab?: InspectorTab) => void;
  hidePanel: () => void;
  /** The panel has finished sliding out, or has nowhere to slide out from. */
  panelLeft: () => void;
  /**
   * Opens the panel on `tab`, or closes it if it is already showing that
   * tab. `byKeyboard` says the request came from a key, so the keyboard
   * should go with it.
   */
  togglePanel: (tab: InspectorTab, byKeyboard?: boolean) => void;
  keyboardTaken: () => void;
  setTab: (tab: InspectorTab) => void;
  /** Notes that an action was run from the palette, for "recently used". */
  noteAction: (id: string) => void;
}

/**
 * How the interface has been left: what the backend remembers between runs
 * (`Interface` in the session), and what lasts only as long as the window.
 */
export const useInterface = create<InterfaceState>((set, get) => ({
  ...readBoot().session.interface,
  panelOpen: false,
  panelLeaving: false,
  panelWantsKeyboard: false,
  setTimeRemaining: (timeRemaining) => set({ timeRemaining }),
  showPanel: (tab) =>
    set({ panelOpen: true, panelLeaving: false, inspectorTab: tab ?? get().inspectorTab }),
  hidePanel: () =>
    set({ panelOpen: false, panelLeaving: get().panelOpen, panelWantsKeyboard: false }),
  panelLeft: () => set({ panelLeaving: false }),
  togglePanel: (tab, byKeyboard = false) => {
    const { panelOpen, inspectorTab } = get();
    set(
      panelOpen && inspectorTab === tab
        ? { panelOpen: false, panelLeaving: true, panelWantsKeyboard: false }
        : {
            panelOpen: true,
            panelLeaving: false,
            inspectorTab: tab,
            panelWantsKeyboard: byKeyboard,
          },
    );
  },
  keyboardTaken: () => set({ panelWantsKeyboard: false }),
  setTab: (inspectorTab) => set({ inspectorTab }),
  noteAction: (id) =>
    set({
      recentActions: [id, ...get().recentActions.filter((other) => other !== id)].slice(
        0,
        RECENT_ACTIONS,
      ),
    }),
}));

/** The part of the state the backend keeps. */
function remembered(state: InterfaceState): Interface {
  return {
    timeRemaining: state.timeRemaining,
    inspectorTab: state.inspectorTab,
    recentActions: state.recentActions,
  };
}

/**
 * Sends the interface's state to be stored whenever the remembered part of
 * it changes. Returns a function that stops doing so.
 */
export function rememberInterface(): () => void {
  if (!isTauri()) {
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stored = JSON.stringify(remembered(useInterface.getState()));
  const unsubscribe = useInterface.subscribe((state) => {
    const next = JSON.stringify(remembered(state));
    if (next === stored) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      stored = next;
      // Not being able to remember is not worth a message: the choice still holds for this run.
      void commands.sessionSetInterface(remembered(useInterface.getState()));
    }, STORE_AFTER_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
