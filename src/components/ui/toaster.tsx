import { X } from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { cn } from "@/lib/cn";

interface ToasterProps {
  /** Use the stage's dark tokens (while a video is open). */
  onStage?: boolean;
  /** The panel beside the picture is open: the picture's top right is that much further in. */
  besidePanel?: boolean;
  /**
   * Out of sight for now: something that takes the middle of the window is
   * open, and a toast must not lie across it (DESIGN.md §7). They keep
   * their time, and one that is still due is there again afterwards.
   */
  quiet?: boolean;
}

/**
 * Toasts: top right, for events with a follow-up and for failures that have
 * nowhere better to be said (DESIGN.md §7). Sonner supplies the behaviour;
 * every style is ours, and so is the motion (styles.css).
 */
export function Toaster({ onStage = false, besidePanel = false, quiet = false }: ToasterProps) {
  // Under the title bar. On the stage that is where the on-screen display
  // is, so toasts start below the tallest it gets: a line of its type
  // (1.2 em), the gap under it (0.4 em) and its scale (0.7 em).
  const top = onStage
    ? "calc(var(--titlebar-h) + 0.25rem + 2.3 * var(--osd-size) + 0.5rem)"
    : "calc(var(--titlebar-h) + 0.5rem)";
  // The top right of the picture, which the panel moves in by its width.
  const right = besidePanel ? "calc(var(--inspector-w) + var(--gutter))" : "var(--gutter)";
  const room = besidePanel
    ? "calc(100vw - var(--inspector-w) - 2 * var(--gutter))"
    : "calc(100vw - 2 * var(--gutter))";
  return (
    <Sonner
      position="top-right"
      offset={{ top, right }}
      // Sonner switches to these below 600 px. Nothing changes there: see styles.css.
      mobileOffset={{ top, right }}
      gap={8}
      visibleToasts={3}
      duration={5000}
      closeButton
      // Sonner's own shortcut for reaching the toasts is not in the action
      // registry, so it could collide with one that is. Tab reaches them.
      hotkey={[]}
      customAriaLabel="Notifications"
      icons={{ close: <X aria-hidden="true" /> }}
      // Sonner's stylesheet gives the toaster a system font and a z-index
      // above everything. Toasts are set in the interface font like the rest
      // of the app, and sit below tooltips (DESIGN.md §8).
      // 356 px, or whatever the picture leaves.
      style={{ fontFamily: "inherit", "--width": `min(356px, ${room})` } as CSSProperties}
      className={cn("!z-toast", onStage && "stage", quiet && "invisible")}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: "Dismiss",
        classNames: {
          toast: cn(
            "pointer-events-auto flex w-full items-start gap-3 rounded-md border border-line bg-surface-2 p-3 text-body text-ink-1 shadow-pop",
            // Only the front toast of a stack shows its words: the ones behind
            // are slivers of its height, and their text would hang out below it.
            // (The child selector is written first: Tailwind applies variants from the right,
            // so this is "children of a toast that is collapsed and not in front".)
            "data-[expanded=false]:data-[front=false]:overflow-hidden [&>*]:data-[expanded=false]:data-[front=false]:opacity-0",
          ),
          // As tall as the buttons beside it at the least, with one line centred
          // in that: the words then share a centre line with Undo and Dismiss.
          content: "flex min-h-7 min-w-0 flex-1 flex-col justify-center gap-1",
          title: "font-medium",
          description: "break-words text-ink-2",
          icon: "mt-1.5 flex size-4 flex-none items-center justify-center text-ink-2 [&_svg]:size-4",
          error: "[&_[data-icon]]:text-danger",
          // Last in the row, whatever order Sonner renders it in, and as tall
          // as the button beside it. Its mark is 7 px inside it: the margin
          // puts the mark, not the box, at the toast's padding.
          closeButton:
            "order-last -mr-1.5 flex size-7 flex-none items-center justify-center rounded-sm text-ink-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-ink-1 active:bg-surface-4 [&_svg]:size-3.5",
          actionButton:
            "flex h-7 flex-none items-center rounded-sm border border-line bg-surface-3 px-3 font-medium text-ink-1 transition-colors duration-fast ease-out hover:bg-surface-4",
          cancelButton:
            "flex h-7 flex-none items-center rounded-sm px-3 font-medium text-ink-2 transition-colors duration-fast ease-out hover:bg-surface-3 hover:text-ink-1",
        },
      }}
    />
  );
}
