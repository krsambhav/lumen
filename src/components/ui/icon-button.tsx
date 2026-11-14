import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { chordAria } from "@/actions/shortcuts";
import { cn } from "@/lib/cn";
import { useSurface } from "./surface";
import { Tooltip } from "./tooltip";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** The action's name: the accessible name and the tooltip text. */
  label: string;
  /** Chord text for the action's shortcut, shown in the tooltip. */
  shortcut?: string | undefined;
  /**
   * For toggles: whether the control is on. An on control shows its icon at
   * full ink with an accent lamp beneath it (DESIGN.md §1, "lit when on"), so
   * the state reads by form as well as by colour.
   */
  pressed?: boolean;
  /**
   * Why the control cannot be used right now. Unlike plain `disabled`, the
   * button stays reachable by pointer and keyboard so its tooltip can say so.
   */
  unavailable?: string | undefined;
  /**
   * The state of a control that has more than two, as the tooltip's second
   * line: Repeat is "Off", "All" or "One". The name stays what the control is.
   */
  detail?: string | undefined;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

/**
 * A square, icon-only button. It always has a name and a tooltip. On the
 * stage it is 36 px and uses the over-video colours; elsewhere it is 32 px.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    shortcut,
    pressed,
    unavailable,
    detail,
    tooltipSide = "top",
    className,
    children,
    type,
    onClick,
    ...props
  },
  ref,
) {
  const onStage = useSurface() === "stage";
  const blocked = unavailable !== undefined;
  return (
    <Tooltip
      label={label}
      detail={unavailable ?? detail}
      shortcut={blocked ? undefined : shortcut}
      side={tooltipSide}
    >
      <button
        ref={ref}
        type={type ?? "button"}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={chordAria(shortcut)}
        aria-disabled={blocked || undefined}
        onClick={(event) => {
          if (blocked) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        className={cn(
          "relative inline-flex flex-none select-none items-center justify-center rounded-sm",
          "transition-[background-color,color,transform,opacity] duration-fast ease-out",
          "disabled:pointer-events-none disabled:opacity-45",
          // The icon is drawn, not pointed at: the pointer is over the button.
          // An icon that is swapped for another (Mute, Play) would otherwise
          // be taken away from under the pointer, and WebKit then tells
          // nothing above it that the pointer has left.
          "[&_svg]:pointer-events-none [&_svg]:size-[18px] [&_svg]:flex-none",
          onStage ? "size-9 text-stage-ink-2" : "size-8 text-ink-2",
          blocked
            ? "cursor-default opacity-45"
            : [
                "motion-safe:active:scale-[0.97]",
                onStage
                  ? "hover:bg-stage-hover hover:text-stage-ink active:bg-stage-press"
                  : "hover:bg-surface-3 hover:text-ink-1 active:bg-surface-4",
              ],
          pressed && (onStage ? "text-stage-ink" : "text-ink-1"),
          // The indicator lamp: an 8 x 2 px accent bar under the icon.
          pressed &&
            "after:absolute after:bottom-[3px] after:left-1/2 after:h-0.5 after:w-2 after:-translate-x-1/2 after:rounded-full after:bg-accent after:content-['']",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
