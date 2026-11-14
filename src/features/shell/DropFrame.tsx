import { cn } from "@/lib/cn";
import type { DropTarget } from "./useFileDrop";

interface DropFrameProps {
  /** Where the files being dragged would go, or `null` when none are. */
  target: DropTarget | null;
  /** A film is open: the picture is there, and the home screen's headline is not. */
  overVideo: boolean;
  /** The panel beside the picture is open. */
  panel: boolean;
}

/**
 * The accent hairline that frames where dragged files will land (DESIGN.md
 * §7): the window, or the playlist when they are held over it. Over video
 * it also says what letting go will do, in the middle of the picture and in
 * the on-screen display's outlined type, clear of every control.
 */
export function DropFrame({ target, overVideo, panel }: DropFrameProps) {
  const active = target !== null;
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "pointer-events-none fixed inset-0 z-toast transition-opacity duration-fast ease-out",
        active ? "opacity-100" : "opacity-0",
      )}
    >
      {/* Around the playlist when the files are over it; otherwise around what plays. */}
      <div
        className={cn(
          "absolute inset-y-2 rounded-md border border-accent",
          target === "playlist"
            ? "right-2 w-[calc(var(--inspector-w)-1rem)]"
            : cn("left-2", panel ? "right-[calc(var(--inspector-w)+0.5rem)]" : "right-2"),
        )}
      />
      {overVideo ? (
        <div
          className={cn(
            "absolute inset-y-0 left-0 flex items-center justify-center",
            panel ? "right-inspector" : "right-0",
          )}
        >
          <p
            role={active ? "status" : undefined}
            className="stage outlined-text whitespace-nowrap text-osd text-stage-ink"
          >
            {target === "playlist" ? "Release to add" : "Release to play"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
