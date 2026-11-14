import { Popover as PopoverPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useSurfaceClass } from "./surface";

/**
 * How far an overlay keeps from the window's edges: 8 px, and below the
 * title bar (44 px) at the top, so a long menu never covers the traffic
 * lights or the title; it scrolls instead.
 */
const CLEAR_OF_EDGES = { top: 52, right: 8, bottom: 8, left: 8 } as const;

/**
 * A popover that asks for something: a small form beside the control that
 * opened it (DESIGN.md §7). `Popover` is the root; a `PopoverAnchor` or
 * `PopoverTrigger` says where it stands.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

interface PopoverContentProps {
  /** What the popover is for, for assistive technology. */
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  /** Where the keyboard goes on opening; by default the first control in it. */
  onOpenAutoFocus?: (event: Event) => void;
  children: ReactNode;
}

export function PopoverContent({
  label,
  side = "bottom",
  align = "end",
  sideOffset = 8,
  className,
  onOpenAutoFocus,
  children,
}: PopoverContentProps) {
  const surfaceClass = useSurfaceClass();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        aria-label={label}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={CLEAR_OF_EDGES}
        {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
        className={cn(
          surfaceClass,
          "z-popover w-72 max-w-[calc(100vw-1rem)] rounded-md border border-line bg-surface-2 p-3",
          // A tall popover in a short window scrolls inside itself (see menu.tsx).
          "max-h-[var(--radix-popover-content-available-height,calc(100vh-1rem))]",
          "scrollbar-thin overflow-y-auto overscroll-contain",
          "text-body text-ink-1 shadow-pop outline-none",
          "data-[state=open]:animate-fade-in data-[side=bottom]:data-[state=open]:animate-drop-in",
          "data-[side=top]:data-[state=open]:animate-rise-in data-[state=closed]:animate-fade-out",
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
