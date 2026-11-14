import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Meter, Sweep } from "@/components/ui/meter";
import { Tooltip } from "@/components/ui/tooltip";
import type { UpdateStatus } from "@/ipc";
import { cn } from "@/lib/cn";
import { arrivedText, installUpdate, restartToUpdate, shareOf, useUpdates } from "./store";

/** A readout in the control's place: the button's height and inset, so nothing moves when one becomes the other. */
const READOUT =
  "flex h-7 flex-none items-center gap-2 whitespace-nowrap px-2 text-body font-medium text-ink-1";

/**
 * Words in the title bar are raised one pixel, as the window's title is: the
 * family's tall ascent leaves capitals sitting low, and these share a line
 * with the title and the traffic lights. Marks (the lamp, the scale) are
 * centred as they are.
 */
const WORDS = "relative -top-px";

/** The lamp that says there is something new: lit, like every other mark that is on. */
function Lamp() {
  return <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-accent" />;
}

/** The control as it stands for one status, or `null` when there is nothing to say. */
function controlFor(status: UpdateStatus): ReactNode {
  switch (status.state) {
    case "idle":
    case "current":
      return null;

    case "available":
      return (
        <Tooltip
          label={`Lumen ${status.version} is available`}
          detail={`You have ${status.current}. Updating restarts Lumen.`}
          side="bottom"
          align="end"
        >
          <Button variant="ghost" size="sm" className="px-2 text-ink-1" onClick={installUpdate}>
            <Lamp />
            <span className={WORDS}>Update to {status.version}</span>
          </Button>
        </Tooltip>
      );

    case "downloading": {
      const share = shareOf(status);
      const name = `Downloading Lumen ${status.version}`;
      return (
        <Tooltip label={name} detail={arrivedText(status)} side="bottom" align="end">
          <div className={READOUT}>
            {/* Name, scale, value, as in every row that has a scale. The words are for the eye: the scale is what is read out. */}
            <span aria-hidden="true" className={WORDS}>
              Downloading
            </span>
            {share === null ? (
              <>
                <span role="status" className="sr-only">
                  {name}
                </span>
                <Sweep className="w-12 flex-none" />
              </>
            ) : (
              <>
                <Meter value={share * 100} label={name} className="w-12 flex-none" />
                {/* A column exactly as wide as "100%", so that no figure moves anything as it grows. */}
                <span
                  aria-hidden="true"
                  className={cn(WORDS, "grid flex-none justify-items-end tabular-nums text-ink-2")}
                >
                  <span className="invisible col-start-1 row-start-1">100%</span>
                  <span className="col-start-1 row-start-1">{Math.round(share * 100)}%</span>
                </span>
              </>
            )}
          </div>
        </Tooltip>
      );
    }

    case "installing":
      return (
        <div className={READOUT} role="status" aria-label={`Installing Lumen ${status.version}`}>
          <span aria-hidden="true" className={WORDS}>
            Installing
          </span>
          <Sweep className="w-12 flex-none" />
        </div>
      );

    case "ready":
      return (
        <Tooltip
          label={`Lumen ${status.version} is installed`}
          detail="It opens the next time Lumen starts."
          side="bottom"
          align="end"
        >
          <Button variant="ghost" size="sm" className="px-2 text-ink-1" onClick={restartToUpdate}>
            <Lamp />
            <span className={WORDS}>Restart to update</span>
          </Button>
        </Tooltip>
      );
  }
}

/**
 * Lumen's own update, at the trailing end of the home screen's title bar
 * (DESIGN.md §7, "Updates"). Nothing while there is nothing newer; then the
 * one thing to do about it: update, watch it arrive, restart.
 *
 * It is on the home screen only. Nothing about an update is drawn over a
 * film unless the viewer asked.
 */
export function UpdateControl() {
  const status = useUpdates((state) => state.status);
  const control = controlFor(status);
  if (control === null) {
    return null;
  }
  // It arrives once, with a fade; what it says then changes in place, as a readout does.
  return <div className="flex flex-none animate-fade-in items-center">{control}</div>;
}
