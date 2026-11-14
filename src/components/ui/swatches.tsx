import { Pipette } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "@/lib/cn";

export interface Swatch {
  /** `#RRGGBB`. */
  value: string;
  name: string;
}

interface SwatchesProps {
  /** What the colour is for: the group's accessible name. */
  label: string;
  value: string;
  swatches: readonly Swatch[];
  onChange: (value: string) => void;
  className?: string;
}

/** The ring of the chosen one: 2 px of the panel's own colour, then 2 px of ink. */
const CHOSEN = "shadow-[0_0_0_2px_var(--surface-1),0_0_0_4px_var(--ink-1)]";

/**
 * A colour from a few, or any other (DESIGN.md §7, "Colour swatches"):
 * circles 20 px across in a radio group, and at the end one that opens the
 * system's colour panel.
 */
export function Swatches({ label, value, swatches, onChange, className }: SwatchesProps) {
  const chosen = value.toUpperCase();
  const listed = swatches.some((swatch) => swatch.value.toUpperCase() === chosen);
  return (
    <div className={cn("flex flex-none items-center gap-2", className)}>
      <RadioGroup.Root
        aria-label={label}
        orientation="horizontal"
        // Never empty: a colour that is none of these is the last circle's.
        value={listed ? chosen : ""}
        onValueChange={onChange}
        className="flex flex-none items-center gap-2"
      >
        {swatches.map((swatch) => (
          <RadioGroup.Item
            key={swatch.value}
            value={swatch.value.toUpperCase()}
            aria-label={swatch.name}
            title={swatch.name}
            className={cn(
              "size-5 flex-none rounded-full border border-line-strong",
              "transition-shadow duration-fast ease-out data-[state=checked]:border-transparent",
              swatch.value.toUpperCase() === chosen && CHOSEN,
            )}
            style={{ backgroundColor: swatch.value }}
          />
        ))}
      </RadioGroup.Root>
      {/* Any other colour: the system's own panel, behind a circle like the rest. */}
      <label
        title="Another colour…"
        className={cn(
          "relative flex size-5 flex-none items-center justify-center rounded-full border border-line-strong text-ink-2",
          "transition-shadow duration-fast ease-out hover:text-ink-1 has-[:focus-visible]:outline",
          !listed && CHOSEN,
          !listed && "border-transparent",
        )}
        style={listed ? undefined : { backgroundColor: value }}
      >
        {listed ? <Pipette aria-hidden="true" className="size-3" /> : null}
        <input
          type="color"
          aria-label={`${label}: another colour`}
          value={value.toLowerCase()}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="absolute inset-0 size-full cursor-default opacity-0"
        />
      </label>
    </div>
  );
}
