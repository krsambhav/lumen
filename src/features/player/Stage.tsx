import { getCurrentWindow } from "@tauri-apps/api/window";
import { ListVideo } from "lucide-react";
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { runAction } from "@/actions/registry";
import { isTauri } from "@/app/boot";
import { SurfaceProvider } from "@/components/ui/surface";
import { CastStage } from "@/features/cast/CastStage";
import { usePlaylistUi } from "@/features/playlist/ui";
import { nameOf } from "@/features/shell/failure";
import { INSPECTOR_WIDTH, useInterface } from "@/features/shell/interface";
import { TitleBar } from "@/features/shell/TitleBar";
import { commands } from "@/ipc";
import { cn } from "@/lib/cn";
import { focusedFromKeyboard } from "@/lib/focus-origin";
import { ActionButton } from "./ActionButton";
import { ControlBar } from "./ControlBar";
import { useChrome, useChromeHold } from "./chrome";
import { OnScreenDisplay } from "./OnScreenDisplay";
import { SkipButton } from "./SkipButton";
import { usePlayer } from "./store";

/** The working indicator appears only if opening takes this long. */
const SLOW_OPEN_MS = 400;
/** The pointer must travel this far with the button down to start a window drag. */
const DRAG_THRESHOLD_PX = 4;
/** And this far, from where it last counted, to count as movement at all. */
const WAKE_TRAVEL_PX = 4;
/**
 * A press this soon after the window came forward is the click that brought
 * it forward. The window takes that click (so a control can be used at once),
 * but on the picture it must not also pause the film.
 */
const ACTIVATION_MS = 250;
/**
 * Under these widths the transport row gives way (DESIGN.md §4): first the
 * volume scale folds into Mute, then the time readout drops its second figure.
 */
const NARROW_PX = 720;
const TIGHT_PX = 600;

type Width = "wide" | "narrow" | "tight";

function widthOf(pixels: number): Width {
  // Zero means not laid out (a test without a layout engine): assume room.
  if (pixels === 0 || pixels >= NARROW_PX) {
    return "wide";
  }
  return pixels < TIGHT_PX ? "tight" : "narrow";
}

/**
 * How wide the stage is, in the three steps the transport row cares about.
 * It is measured rather than asked of the window, because with the panel
 * open the stage is narrower than the window; and measured in script rather
 * than with a container query, which the WebKit of macOS 12 does not have.
 *
 * The first answer is worked out from the window before anything is drawn,
 * so the row appears already arranged instead of folding as it arrives.
 */
function useStageWidth(panelOpen: boolean): [React.RefObject<HTMLDivElement>, Width] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<Width>(() =>
    widthOf(Math.max(1, window.innerWidth - (panelOpen ? INSPECTOR_WIDTH : 0))),
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setWidth(widthOf(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Everything drawn over the video. The picture itself is a native layer
 * beneath the web view; this element is transparent and carries the chrome,
 * which dims after two seconds without pointer movement (DESIGN.md §5).
 *
 * On the picture: a click plays or pauses, a double-click toggles full
 * screen, and a drag moves the window (DESIGN.md §8).
 */
export function Stage() {
  const title = usePlayer((state) => state.title ?? "");
  const source = usePlayer((state) => state.source);
  const loading = usePlayer((state) => state.status === "loading");
  const ended = usePlayer((state) => state.status === "ended");
  const playing = usePlayer((state) => state.status === "playing" || state.status === "buffering");
  const panelOpen = useInterface((state) => state.panelOpen);
  const [stageRef, width] = useStageWidth(panelOpen);
  const visible = useChrome((state) => state.visible);
  const wake = useChrome((state) => state.wake);
  const rest = useChrome((state) => state.rest);
  const setPlaying = useChrome((state) => state.setPlaying);
  const hold = useChrome((state) => state.hold);
  const release = useChrome((state) => state.release);
  const reset = useChrome((state) => state.reset);

  // While the film runs, a pointer resting on the chrome does not keep it.
  useEffect(() => setPlaying(playing), [playing, setPlaying]);

  // The traffic lights dim and return with the rest of the chrome.
  useEffect(() => {
    if (isTauri()) {
      void commands.windowSetChromeVisible(visible);
    }
  }, [visible]);

  useEffect(() => {
    wake();
    return () => {
      reset();
      if (isTauri()) {
        void commands.windowSetChromeVisible(true);
      }
    };
  }, [wake, reset]);

  // A film that has ended says so: the chrome comes back and stays, with
  // Play ready to start it again.
  useChromeHold("ended", ended);

  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number; wasFocused: boolean } | null>(null);

  /** When the window last came forward. */
  const activatedAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const onFocus = () => {
      activatedAt.current = performance.now();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  function onStageMove(event: PointerEvent<HTMLDivElement>) {
    // Movement means travel. WebKit reports a move when content changes
    // under a still pointer, and a nudge of the desk moves it a pixel or two;
    // neither should raise the chrome, or it could never dim.
    const last = lastPointer.current;
    if (!last) {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      return;
    }
    if (Math.hypot(event.clientX - last.x, event.clientY - last.y) < WAKE_TRAVEL_PX) {
      return;
    }
    lastPointer.current = { x: event.clientX, y: event.clientY };
    wake();
  }

  function onPicturePress(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    // Back to the film: a row left selected in the panel should not go on
    // answering Return and Delete from here (DESIGN.md §7, "List row").
    usePlaylistUi.getState().select(null);
    // Engines differ on whether the window already counts as focused when
    // the click that activates it arrives, so both signs are checked.
    const wasFocused =
      document.hasFocus() && performance.now() - activatedAt.current > ACTIVATION_MS;
    press.current = { x: event.clientX, y: event.clientY, wasFocused };
  }

  function onPictureMove(event: PointerEvent<HTMLDivElement>) {
    const start = press.current;
    if (!start || event.buttons !== 1) {
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= DRAG_THRESHOLD_PX) {
      press.current = null;
      if (isTauri()) {
        void getCurrentWindow().startDragging();
      }
    }
  }

  function onPictureClick(event: React.MouseEvent<HTMLDivElement>) {
    const start = press.current;
    press.current = null;
    if (!start) {
      return;
    }
    // A click on the picture does nothing (asked for, 2026-11-14): Space, K
    // and the Play button pause. A double-click goes in or out of full screen.
    if (event.detail === 2) {
      runAction("view.fullscreen", "pointer");
    }
  }

  return (
    <SurfaceProvider value="stage">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it only hears focus move among the controls inside it */}
      <div
        ref={stageRef}
        // What the transport row reads to know how much room it has.
        data-narrow={width === "wide" ? undefined : ""}
        data-tight={width === "tight" ? "" : undefined}
        className={cn(
          "group/stage stage relative h-full overflow-hidden",
          !visible && "cursor-none",
        )}
        onPointerMove={onStageMove}
        // While a control on the stage has keyboard focus the chrome stays
        // up, wherever on the stage that control is (DESIGN.md §8). A control
        // that was only clicked does not keep it.
        onFocus={(event) => {
          if (focusedFromKeyboard(event.target)) {
            hold("focus");
          }
        }}
        onBlur={() => release("focus")}
      >
        {/* The picture is a pointer convenience only; the keyboard has Space, F and the control bar. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
        <div
          // What scrolling is tested against: see scroll.ts.
          data-picture=""
          className="absolute inset-0"
          onPointerDown={onPicturePress}
          onPointerMove={onPictureMove}
          onClick={onPictureClick}
        />

        <LoadingIndicator loading={loading} />

        {/* Beneath the chrome, so the controls stay on top of it. */}
        <CastStage />

        {/* Resting on the title bar, where the traffic lights are, keeps the chrome as resting on the controls does. */}
        <div
          data-stage-chrome=""
          className={cn(
            "absolute inset-x-0 top-0 z-chrome transition-opacity ease-out",
            visible
              ? "opacity-100 duration-fast"
              : "pointer-events-none opacity-0 duration-[var(--dur-leave)] [transition-timing-function:var(--ease-leave)]",
          )}
          onPointerEnter={() => rest("titlebar", true)}
          onPointerLeave={() => rest("titlebar", false)}
        >
          <TitleBar
            title={title}
            fullTitle={source === null ? undefined : nameOf(source)}
            overVideo
            // With the panel open, the control that closes it is in the panel's own header.
            actions={
              panelOpen ? undefined : (
                <ActionButton action="view.playlist" tooltipSide="bottom">
                  <ListVideo />
                </ActionButton>
              )
            }
          />
        </div>
        <div
          data-stage-chrome=""
          className={cn(
            "absolute inset-x-0 bottom-0 z-chrome transition-opacity ease-out",
            visible
              ? "opacity-100 duration-fast"
              : "pointer-events-none opacity-0 duration-[var(--dur-leave)] [transition-timing-function:var(--ease-leave)]",
          )}
        >
          <ControlBar />
        </div>

        {/* An offer to skip a recap or an intro: it stays while the chrome dims. */}
        <SkipButton />

        {/* Last, so it is drawn above the chrome and its scrims. */}
        <OnScreenDisplay />
      </div>
    </SurfaceProvider>
  );
}

/**
 * The working indicator, shown only if opening takes long enough to notice.
 *
 * The status region is always in the tree and is filled when the indicator
 * appears, so assistive technology hears "Opening" at the same moment a
 * sighted user sees it, and not at all when a file opens at once.
 */
function LoadingIndicator({ loading }: { loading: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_OPEN_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      {slow ? (
        <span className="flex animate-fade-in items-center text-osd">
          {/*
            A needle sweeping a hairline, drawn like the on-screen display's
            scale: every shape again one unit larger in void beneath, so it is
            seen over any picture. Sized in ems of the display's type, so it
            is seen from the sofa too.
          */}
          <svg
            aria-hidden="true"
            viewBox="0 0 40 14"
            className="outlined-shape h-[0.7em] w-[2em] flex-none overflow-visible [--sweep:38px]"
          >
            <rect x="-1" y="5" width="42" height="4" rx="2" className="fill-void" />
            <rect x="-1" y="-1" width="4" height="16" rx="2" className="animate-sweep fill-void" />
            <rect x="0" y="6" width="40" height="2" rx="1" className="fill-stage-ink" />
            <rect x="0" y="0" width="2" height="14" rx="1" className="animate-sweep fill-accent" />
          </svg>
          <span className="sr-only">Opening</span>
        </span>
      ) : null}
    </div>
  );
}
