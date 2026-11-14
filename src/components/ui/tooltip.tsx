import { Tooltip as TooltipPrimitive } from "radix-ui";
import { createContext, type ReactElement, type ReactNode, useContext, useState } from "react";
import { chordSpoken } from "@/actions/shortcuts";
import { cn } from "@/lib/cn";
import { Shortcut } from "./shortcut";
import { useSurfaceClass } from "./surface";

/** How far a tooltip stands off its control, in pixels, unless a region says otherwise. */
const DEFAULT_OFFSET = 8;

const OffsetContext = createContext(DEFAULT_OFFSET);

/**
 * Sets how far tooltips stand off their controls within a region. The stage's
 * transport row uses it to lift its tooltips clear of the timeline above it
 * (DESIGN.md §7).
 */
export function TooltipOffset({ value, children }: { value: number; children: ReactNode }) {
  return <OffsetContext.Provider value={value}>{children}</OffsetContext.Provider>;
}

/**
 * Tooltips wait 500 ms, then open at once while the pointer moves between
 * neighbouring controls. They never take the pointer: moving onto one closes
 * it, so a tooltip can never sit between the pointer and what is under it
 * (DESIGN.md §7).
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={300} disableHoverableContent>
      {children}
    </TooltipPrimitive.Provider>
  );
}

interface TooltipProps {
  /** The action's name, or the full text of something truncated. */
  label: string;
  /** A second line of explanation, e.g. why a control is unavailable. */
  detail?: string | undefined;
  /** Chord text for the control's shortcut, or for each key that works it, shown as keycaps. */
  shortcut?: string | readonly string[] | undefined;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /**
   * Keeps the tooltip closed without unwrapping the trigger. Use it when the
   * tooltip is conditional (text that is only sometimes truncated): adding and
   * removing the wrapper would remount the element being measured.
   */
  disabled?: boolean;
  /**
   * Keeps the tooltip open whatever the pointer is doing, and following its
   * control as it moves: for a needle being dragged, whose tooltip is its
   * reading.
   */
  held?: boolean;
  /** The control the tooltip describes. Must accept a ref and DOM props. */
  children: ReactElement;
}

export function Tooltip({
  label,
  detail,
  shortcut,
  side = "top",
  align = "center",
  disabled = false,
  held = false,
  children,
}: TooltipProps) {
  const surfaceClass = useSurfaceClass();
  const offset = useContext(OffsetContext);
  const [open, setOpen] = useState(false);
  const chords = shortcut === undefined ? [] : typeof shortcut === "string" ? [shortcut] : shortcut;
  // The trigger already carries the name. What assistive technology hears as
  // its description is only what the tooltip adds: the reason and the keys.
  const spoken = [detail, ...chords.map(chordSpoken)].filter(Boolean).join(", ");
  return (
    <TooltipPrimitive.Root open={(open || held) && !disabled} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={offset}
          collisionPadding={8}
          updatePositionStrategy={held ? "always" : "optimized"}
          aria-label={spoken || label}
          className={cn(
            surfaceClass,
            // It is a label, not a surface: clicks pass through to what is beneath.
            "pointer-events-none z-tooltip flex max-w-[min(68ch,calc(100vw-16px))] items-start gap-2 rounded-sm border border-line",
            "bg-surface-2 px-2 py-1 text-caption text-ink-1 shadow-pop",
            // Rise toward the control it describes; plain fades from the sides.
            "data-[state=delayed-open]:animate-fade-in",
            "data-[side=top]:data-[state=delayed-open]:animate-rise-in",
            "data-[side=bottom]:data-[state=delayed-open]:animate-drop-in",
            "data-[state=closed]:animate-fade-out data-[state=instant-open]:animate-none",
          )}
        >
          <span className="tabular min-w-0 break-words">
            {label}
            {detail ? <span className="block text-ink-2">{detail}</span> : null}
          </span>
          {chords.length > 0 ? (
            <span className="flex flex-none items-center gap-1">
              {chords.map((chord) => (
                <Shortcut key={chord} chord={chord} variant="keycap" className="text-ink-2" />
              ))}
            </span>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
