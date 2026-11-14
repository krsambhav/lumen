import type { ReactNode } from "react";

interface PanelBodyProps {
  /** The tab's name: the first line of its content (DESIGN.md §7). */
  title: string;
  /** What acts on everything in the tab, at the trailing end of its heading. */
  trailing?: ReactNode;
  children: ReactNode;
}

/**
 * The body of one of the panel's adjustment tabs: its name, then its groups
 * in a column that scrolls when it is taller than the panel. The heading
 * has the same measures as the playlist's, so the first line of every tab
 * stands in the same place.
 */
export function PanelBody({ title, trailing, children }: PanelBodyProps) {
  return (
    <>
      <div className="flex flex-none items-center gap-2 px-4 pb-1 pt-3">
        <h2 className="flex min-h-10 min-w-0 flex-1 items-center truncate text-heading text-ink-1">
          {title}
        </h2>
        {trailing}
      </div>
      {/* It scrolls when it is taller than the panel; Tab brings each control into view.
          The 4 px at its top are the room a focus ring needs (2 px off, 2 px wide) on the first row. */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-5 pt-1">
        {children}
      </div>
    </>
  );
}
