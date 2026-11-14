import { Band } from "@/components/ui/band";
import type { Equaliser } from "@/ipc";
import {
  BANDS,
  bandCaption,
  bandName,
  GAIN_STEP,
  gainSpoken,
  gainText,
  MAX_GAIN,
  withGain,
} from "./equaliser";

interface EqualiserBandsProps {
  equaliser: Equaliser;
  /** Not in effect: switched off, or bypassed. The bands keep their places and step back. */
  dimmed: boolean;
  onChange: (equaliser: Equaliser) => void;
}

/**
 * The equaliser's ten bands (DESIGN.md §7, "Equaliser"): vertical scales of
 * one height in a row, as wide as the panel's column, with a hairline
 * across all of them at 0 dB.
 */
export function EqualiserBands({ equaliser, dimmed, onChange }: EqualiserBandsProps) {
  return (
    // A group, so the ten are announced as one thing with ten parts.
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and its own layout; this is a row of sliders
    <div role="group" aria-label="Equaliser bands" className="relative flex justify-between pt-1">
      {/* The 0 dB line, half-way up the bands, behind them. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[calc(0.25rem+3.5rem)] h-px bg-line"
      />
      {BANDS.map((hertz, band) => {
        const gain = equaliser.gains[band] ?? 0;
        return (
          <Band
            key={hertz}
            label={bandName(hertz)}
            caption={bandCaption(hertz)}
            value={gain}
            min={-MAX_GAIN}
            max={MAX_GAIN}
            step={GAIN_STEP}
            origin={0}
            valueText={gainSpoken(gain)}
            display={gainText(gain)}
            dimmed={dimmed}
            onChange={(next) => onChange(withGain(equaliser, band, next))}
          />
        );
      })}
    </div>
  );
}
