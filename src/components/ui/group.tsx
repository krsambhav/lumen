import { type ReactNode, useId } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

interface GroupProps {
  /** The group's heading. */
  title: string;
  /**
   * What acts on the whole group, at the trailing end of its heading: a
   * Reset, a switch, a picker. 28 px tall at the most, like the heading row.
   */
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * A group of controls in a panel, under a small heading (DESIGN.md §7,
 * "Video, Audio and Subtitles tabs"). The heading row keeps its height
 * whether or not anything stands at its end, so a Reset that comes and goes
 * moves nothing below it.
 */
export function Group({ title, trailing, className, children }: GroupProps) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex h-7 min-w-0 items-center gap-2">
        <h3 id={heading} className="label min-w-0 flex-1 truncate text-ink-3">
          {title}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/**
 * The Reset at the end of a group's heading (DESIGN.md §7). Its word ends at
 * the column's edge, where the readings and the pickers' chevrons end; the
 * fill it takes on hover reaches into the panel's margin, as a ghost
 * button's does.
 */
export function GroupReset({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="-mr-3 flex-none" onClick={onClick}>
      Reset
    </Button>
  );
}
