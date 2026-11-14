import { useState } from "react";
import { ListBox } from "@/components/ui/list-box";
import { goToChapter } from "@/features/player/actions";
import { chapterIndexAt, chapterName } from "@/features/player/chapters";
import { usePlayer } from "@/features/player/store";
import { Timecode } from "@/features/player/Timecode";
import type { Chapter } from "@/ipc";
import { cn } from "@/lib/cn";
import { spokenDuration, wholeSecond } from "@/lib/timecode";

interface Row {
  index: number;
  chapter: Chapter;
}

/** The tab's name and how many there are, with the measures of every tab's heading. */
function Heading({ count }: { count?: number }) {
  return (
    <div className="flex flex-none items-center px-4 pb-2 pt-3">
      <div className="flex min-h-10 min-w-0 flex-1 flex-col justify-center">
        <h2 className="truncate text-heading text-ink-1">Chapters</h2>
        {count === undefined ? null : (
          <p className="tabular truncate text-caption text-ink-2">
            {count === 1 ? "1 chapter" : `${count} chapters`}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The film's table of contents (DESIGN.md §7, "Chapters"): a click goes to
 * a chapter, and the one being played carries the lamp.
 */
export function ChaptersPanel() {
  const chapters = usePlayer((state) => state.chapters);
  const duration = usePlayer((state) => state.duration);
  // Whole seconds: the lamp moves when a chapter starts, not ten times a second.
  const playing = usePlayer((state) => chapterIndexAt(state.chapters, wholeSecond(state.position)));
  const [selected, setSelected] = useState<number | null>(null);

  if (chapters.length === 0) {
    return (
      <>
        <Heading />
        <p className="px-4 text-body text-ink-2">This file has no chapters.</p>
      </>
    );
  }

  const rows: Row[] = chapters.map((chapter, index) => ({ index, chapter }));
  // Every start time is written in the shape the film's length calls for.
  const span = duration ?? chapters[chapters.length - 1]?.time ?? 0;
  return (
    <>
      <Heading count={chapters.length} />
      <ListBox
        label="Chapters"
        items={rows}
        getId={(row) => row.index}
        rowHeight={28}
        selected={selected}
        onSelect={setSelected}
        onActivate={(row) => goToChapter({ source: "control" }, row.index)}
        activateOnClick
        current={playing >= 0 ? playing : null}
        className="pb-2"
        renderRow={(row) => {
          const current = row.index === playing;
          return (
            <>
              {/* The row in words, as one sentence; the cells are for the eye. */}
              <span className="sr-only">
                {chapterName(row.chapter, row.index)}, at {spokenDuration(row.chapter.time)}
                {current ? ", playing" : ""}
              </span>
              <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 px-2">
                {/* The lamp's place, at the leading edge as in every list: every row keeps it, so times line up. */}
                <span className="flex w-1 flex-none justify-start">
                  {current ? <span data-lamp="" className="needle h-3 w-0.5 rounded-xs" /> : null}
                </span>
                <Timecode
                  seconds={row.chapter.time}
                  span={span}
                  // As wide as the longest start time, so they end on one line.
                  className={cn(
                    "flex-none text-right text-caption text-ink-2",
                    span >= 3600 ? "w-[7ch]" : "w-[5ch]",
                  )}
                />
                <span
                  className={cn("min-w-0 flex-1 truncate", current && "font-semibold text-ink-1")}
                >
                  {chapterName(row.chapter, row.index)}
                </span>
              </span>
            </>
          );
        }}
      />
    </>
  );
}
