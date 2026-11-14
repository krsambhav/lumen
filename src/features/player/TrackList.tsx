import { RadioGroup } from "radix-ui";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import type { Track } from "@/ipc";
import { cn } from "@/lib/cn";
import { trackFormat, trackName } from "./tracks";

interface TrackListProps {
  /** What is being chosen: "Audio track". */
  label: string;
  tracks: readonly Track[];
  /** The id of the track in use, or `null` for none. */
  selected: number | null;
  /** The name of the row that chooses no track; without it there is no such row. */
  off?: string;
  onChoose: (id: number | null) => void;
}

const OFF = "off";

const ROW = cn(
  // The fill reaches 8 px past the words on each side; the words keep the column's edges.
  "-mx-2 flex h-7 min-w-0 select-none items-center gap-2 rounded-sm px-2 text-left text-body",
  "transition-colors duration-fast ease-out hover:bg-surface-3 active:bg-surface-4",
);

/** The lamp's place at the leading edge: every row keeps it, so names line up. */
function Lamp({ lit }: { lit: boolean }) {
  return (
    <span aria-hidden="true" className="flex w-1 flex-none justify-start">
      {lit ? <span data-lamp="" className="needle h-3 w-0.5 rounded-xs" /> : null}
    </span>
  );
}

/**
 * The tracks of one kind (DESIGN.md §7, "Track list"): a radio group of
 * rows, the lamp on the one in use, each called what a person would call
 * it, with its format at the trailing end.
 */
export function TrackList({ label, tracks, selected, off, onChoose }: TrackListProps) {
  return (
    <RadioGroup.Root
      aria-label={label}
      orientation="vertical"
      value={selected === null ? OFF : String(selected)}
      onValueChange={(value) => onChoose(value === OFF ? null : Number(value))}
      className="flex min-w-0 flex-col"
    >
      {off === undefined ? null : (
        <RadioGroup.Item value={OFF} className={ROW}>
          <Lamp lit={selected === null} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              selected === null ? "font-semibold text-ink-1" : "text-ink-1",
            )}
          >
            {off}
          </span>
        </RadioGroup.Item>
      )}
      {tracks.map((track) => {
        const lit = track.id === selected;
        const format = trackFormat(track);
        return (
          <RadioGroup.Item
            key={track.id}
            value={String(track.id)}
            // In words, as one phrase: the cells are for the eye.
            aria-label={[trackName(track), format].filter(Boolean).join(", ")}
            className={ROW}
          >
            <Lamp lit={lit} />
            <MiddleTruncate
              text={trackName(track)}
              className={cn("flex-1 text-ink-1", lit && "font-semibold")}
            />
            {format ? (
              <span className="flex-none whitespace-nowrap pl-2 text-caption text-ink-3">
                {format}
              </span>
            ) : null}
          </RadioGroup.Item>
        );
      })}
    </RadioGroup.Root>
  );
}
