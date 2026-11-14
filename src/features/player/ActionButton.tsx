import type { ReactNode } from "react";
import { getAction, runAction } from "@/actions/registry";
import { IconButton } from "@/components/ui/icon-button";

interface ActionButtonProps {
  /** The id of a registered action. */
  action: string;
  /** Overrides the name the action has now. */
  label?: string;
  /** The control's state, where it has more than two: the tooltip's second line. */
  detail?: string;
  pressed?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  className?: string;
  children: ReactNode;
}

/**
 * An icon button bound to a registered action: its name, its shortcut and
 * its availability all come from the registry, so the tooltip always shows
 * the same keys the keyboard dispatcher listens for.
 */
export function ActionButton({
  action,
  label,
  detail,
  pressed,
  tooltipSide,
  className,
  children,
}: ActionButtonProps) {
  const entry = getAction(action);
  return (
    <IconButton
      // The name it has now: "Hide playlist" while the playlist is showing.
      label={label ?? entry?.label?.() ?? entry?.name ?? action}
      {...(detail === undefined ? {} : { detail })}
      shortcut={entry?.shortcuts[0]}
      unavailable={entry?.unavailable?.()}
      {...(pressed === undefined ? {} : { pressed })}
      {...(tooltipSide === undefined ? {} : { tooltipSide })}
      {...(className === undefined ? {} : { className })}
      onClick={() => runAction(action, "control")}
    >
      {children}
    </IconButton>
  );
}
