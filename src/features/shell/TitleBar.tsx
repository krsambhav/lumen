import type { ReactNode } from "react";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { SurfaceProvider } from "@/components/ui/surface";
import { cn } from "@/lib/cn";

interface TitleBarProps {
  /** The window's title: the app name, or what is playing. */
  title: string;
  /** What is playing by its whole file name, for the tooltip of a title that is cut. */
  fullTitle?: string | undefined;
  /** Controls at the trailing edge. */
  actions?: ReactNode;
  /** Draw over video, on the stage's scrim and with the stage's colours. */
  overVideo?: boolean;
  className?: string;
}

/**
 * The custom title bar. The native traffic lights are drawn by macOS in the
 * leading 88 px, which this component keeps clear; everything in the bar that
 * is not a control drags the window, and a double-click zooms it.
 */
export function TitleBar({
  title,
  fullTitle,
  actions,
  overVideo = false,
  className,
}: TitleBarProps) {
  return (
    <SurfaceProvider value={overVideo ? "stage" : "app"}>
      <header
        data-tauri-drag-region
        className={cn(
          // Three grid columns. The outer two are both 1fr, so the title is
          // centred on the window itself; padding lives inside the cells, where
          // it cannot make one side wider than the other.
          "relative grid h-titlebar flex-none grid-cols-[1fr_minmax(0,auto)_1fr] items-center",
          // The scrim is longer than the bar, so it is painted by a child that
          // may overflow it rather than by the bar's own background.
          overVideo &&
            "stage before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-scrim-top before:bg-scrim-top before:content-['']",
          className,
        )}
      >
        <div data-tauri-drag-region className="relative h-full min-w-titlebar-lead" />
        <h1
          data-tauri-drag-region
          // Raised one pixel: the family's tall ascent leaves its capitals
          // sitting low, and they should share a centre line with the lights.
          className="relative -top-px flex min-w-0 justify-center px-3 text-body font-semibold text-ink-1"
        >
          <MiddleTruncate text={title} full={fullTitle} dragRegion />
        </h1>
        <div
          data-tauri-drag-region
          className="relative flex h-full min-w-titlebar-lead items-center justify-end"
        >
          {actions ? <div className="flex flex-none items-center gap-1 pr-3">{actions}</div> : null}
        </div>
      </header>
    </SurfaceProvider>
  );
}
