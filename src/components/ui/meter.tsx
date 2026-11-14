import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/*
 * How far a piece of work has come, drawn as every level in Lumen is: a
 * hairline scale and a needle (DESIGN.md §1). `Meter` for work whose length
 * is known, `Sweep` for work whose length is not (DESIGN.md §5).
 */

/** A needle that travels a hairline, for work of unknown length (DESIGN.md §5). */
export function Sweep({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={ref} aria-hidden="true" className={cn("relative block h-3.5", className)}>
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-strong" />
      <span
        className="absolute left-0 top-0 h-full w-0.5 animate-sweep rounded-xs bg-accent"
        style={{ "--sweep": `${Math.max(0, width - 2)}px` } as CSSProperties}
      />
    </span>
  );
}

/** How far a fetch has come, as the scale and needle every level in Lumen is shown by. */
export function Meter({
  value,
  label,
  className,
}: {
  /** 0–100. */
  value: number;
  /** What is being measured, for assistive technology. */
  label: string;
  className?: string;
}) {
  const share = Math.min(100, Math.max(0, value));
  return (
    // A span, so that it may stand in a line of text or inside a control.
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share)}
      aria-valuetext={`${Math.round(share)}%`}
      className={cn("relative block h-3.5", className)}
    >
      <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-xs bg-line-strong" />
      <span
        className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-xs bg-ink-1 transition-[width] duration-base ease-out"
        style={{ width: `${share}%` }}
      />
      <span
        className="absolute top-0 h-full w-0.5 rounded-xs bg-accent transition-[left] duration-base ease-out"
        style={{ left: `calc(${share}% - ${(share / 100) * 2}px)` }}
      />
    </span>
  );
}
