import { Airplay, Cast } from "lucide-react";
import { useCast } from "./store";

const DELIVERY_NOTE = {
  direct: null,
  remux: null,
  transcode: "Converted for the TV as it plays",
} as const;

/**
 * Over the picture while a film is on a TV: where it is playing, so the
 * paused frame on the Mac is not taken for a film that has stopped
 * (DESIGN.md §7, "Cast"). The controls below go on working; they work the TV.
 */
export function CastStage() {
  const session = useCast((state) => state.session);
  if (session === null || session.phase === "choosing") {
    return null;
  }
  const Icon = session.protocol === "airPlay" ? Airplay : Cast;
  const connecting = session.phase === "connecting";
  const note = session.delivery === null ? null : DELIVERY_NOTE[session.delivery];
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex animate-fade-in items-center justify-center px-gutter"
    >
      {/* The paused frame shows through, dimmed: it is where the TV is. */}
      <div aria-hidden="true" className="absolute inset-0 bg-void opacity-70" />
      <div className="relative flex min-w-0 max-w-full flex-col items-center gap-3 text-center">
        <Icon aria-hidden="true" className="size-8 flex-none text-stage-ink-2" strokeWidth={1.5} />
        <div className="flex min-w-0 max-w-full flex-col items-center gap-1">
          <span className="text-body text-stage-ink-2">
            {connecting ? "Connecting to" : "Playing on"}
          </span>
          <span className="max-w-full truncate text-title text-stage-ink">{session.device}</span>
        </div>
        {note !== null && !connecting ? (
          <span className="text-caption text-stage-ink-2">{note}</span>
        ) : null}
      </div>
    </div>
  );
}
