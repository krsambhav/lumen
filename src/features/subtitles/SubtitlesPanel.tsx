import { Button } from "@/components/ui/button";
import { Group } from "@/components/ui/group";
import { PickerRow } from "@/components/ui/picker";
import { ScaleRow } from "@/components/ui/scale";
import { Swatches } from "@/components/ui/swatches";
import { SwitchRow } from "@/components/ui/switch";
import { PanelBody } from "@/features/inspector/PanelBody";
import { delaySpoken, delayText, setSubtitleDelay } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { TrackList } from "@/features/player/TrackList";
import { secondSubtitle, shownSubtitle, trackName, tracksOf } from "@/features/player/tracks";
import { setSubtitleStyle } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import { commands } from "@/ipc";
import { send } from "@/lib/notify";
import { FontPicker } from "./FontPicker";
import { SyncRow } from "./SyncRow";
import {
  MAX_OUTLINE,
  MAX_SCALE,
  MIN_SCALE,
  OUTLINE_COLOURS,
  outlineText,
  percentText,
  raiseText,
  sameStyle,
  TEXT_COLOURS,
  USUAL_STYLE,
} from "./style";

const AT_ZERO = [{ value: 0 }] as const;
const AT_ONE = [{ value: 1 }] as const;

/** The furthest the Delay scale reaches either way, in seconds; the keys go further. */
const DELAY_REACH = 5;

/** The picker's value for "no second track", which no track's id is. */
const NONE = "none";

/** The subtitles of the file that is open: which, a second if wanted, and their timing. */
function TrackGroup() {
  const tracks = usePlayer((state) => state.tracks);
  const delay = usePlayer((state) => state.subtitleDelay);
  const subtitles = tracksOf(tracks, "subtitle");
  const first = shownSubtitle(tracks);
  const second = secondSubtitle(tracks);
  // Any but the one already showing can be shown with it.
  const others = subtitles.filter((track) => track.id !== first?.id);
  return (
    <Group
      title="Track"
      trailing={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => send("add subtitles", commands.playerAddSubtitlesDialog())}
        >
          Add file…
        </Button>
      }
    >
      {subtitles.length === 0 ? (
        <p className="flex min-h-7 items-center text-body text-ink-2">
          This file has no subtitles. Add a file, or drop one on the window.
        </p>
      ) : (
        <TrackList
          label="Subtitle track"
          tracks={subtitles}
          selected={first?.id ?? null}
          off="Off"
          onChoose={(id) =>
            send("change the subtitles", commands.playerSelectTrack("subtitle", id))
          }
        />
      )}
      <PickerRow
        label="Second track"
        value={second ? String(second.id) : NONE}
        options={[
          { value: NONE, name: "None" },
          ...others.map((track) => ({ value: String(track.id), name: trackName(track) })),
        ]}
        // Two tracks need two to choose from, and a first for the second to stand above.
        disabled={first === undefined || others.length === 0}
        onChange={(value) =>
          send(
            "change the second subtitles",
            commands.playerSelectSecondSubtitle(value === NONE ? null : Number(value)),
          )
        }
      />
      <ScaleRow
        label="Delay"
        value={delay}
        min={-DELAY_REACH}
        max={DELAY_REACH}
        step={0.05}
        defaultValue={0}
        origin={0}
        marks={AT_ZERO}
        disabled={subtitles.length === 0}
        valueText={delaySpoken(delay)}
        display={delayText(delay)}
        onChange={setSubtitleDelay}
      />
      {subtitles.length > 0 ? <SyncRow /> : null}
    </Group>
  );
}

/** How subtitles look: it stays until it is changed. */
function LookGroup() {
  const style = useSettings((state) => state.settings.subtitles.style);
  return (
    <Group
      title="Look"
      trailing={
        sameStyle(style, USUAL_STYLE) ? null : (
          <Button variant="ghost" size="sm" onClick={() => setSubtitleStyle(USUAL_STYLE)}>
            Reset
          </Button>
        )
      }
    >
      <div className="flex h-8 min-w-0 items-center gap-3">
        <span className="w-28 flex-none truncate text-body text-ink-2">Font</span>
        <span className="flex min-w-0 flex-1 justify-end">
          <FontPicker
            value={style.font}
            onChange={(font) => setSubtitleStyle({ ...style, font })}
          />
        </span>
      </div>
      <ScaleRow
        label="Size"
        value={style.scale}
        min={MIN_SCALE}
        max={MAX_SCALE}
        step={0.05}
        defaultValue={1}
        origin={1}
        marks={AT_ONE}
        valueText={`${Math.round(style.scale * 100)} percent`}
        display={percentText(style.scale)}
        onChange={(scale) => setSubtitleStyle({ ...style, scale })}
      />
      <div className="flex h-8 min-w-0 items-center gap-3">
        <span className="w-28 flex-none truncate text-body text-ink-2">Colour</span>
        <span className="flex min-w-0 flex-1 justify-end">
          <Swatches
            label="Subtitle colour"
            value={style.colour}
            swatches={TEXT_COLOURS}
            onChange={(colour) => setSubtitleStyle({ ...style, colour })}
          />
        </span>
      </div>
      <ScaleRow
        label="Outline"
        value={style.outline}
        min={0}
        max={MAX_OUTLINE}
        step={0.25}
        defaultValue={USUAL_STYLE.outline}
        valueText={style.outline === 0 ? "none" : `${style.outline}`}
        display={outlineText(style.outline)}
        onChange={(outline) => setSubtitleStyle({ ...style, outline })}
      />
      <div className="flex h-8 min-w-0 items-center gap-3">
        <span className="w-28 flex-none truncate text-body text-ink-2">Outline colour</span>
        <span className="flex min-w-0 flex-1 justify-end">
          <Swatches
            label="Outline colour"
            value={style.outlineColour}
            swatches={OUTLINE_COLOURS}
            onChange={(outlineColour) => setSubtitleStyle({ ...style, outlineColour })}
          />
        </span>
      </div>
      <ScaleRow
        label="Background"
        value={style.background}
        min={0}
        max={1}
        step={0.05}
        defaultValue={0}
        valueText={
          style.background === 0 ? "none" : `${Math.round(style.background * 100)} percent`
        }
        display={style.background === 0 ? "None" : percentText(style.background)}
        onChange={(background) => setSubtitleStyle({ ...style, background })}
      />
      <ScaleRow
        label="Position"
        value={style.raise}
        min={0}
        max={100}
        step={1}
        defaultValue={0}
        valueText={
          style.raise === 0 ? "at the bottom" : `${Math.round(style.raise)} percent of the way up`
        }
        display={raiseText(style.raise)}
        onChange={(raise) => setSubtitleStyle({ ...style, raise })}
      />
      <SwitchRow
        name="Bold"
        checked={style.bold}
        onChange={(bold) => setSubtitleStyle({ ...style, bold })}
      />
      <SwitchRow
        name="Restyle styled subtitles"
        hint="Use this look for subtitles that bring their own."
        checked={style.restyle}
        onChange={(restyle) => setSubtitleStyle({ ...style, restyle })}
      />
    </Group>
  );
}

/** The Subtitles tab: the file's tracks and timing, and how subtitles look (DESIGN.md §7). */
export function SubtitlesPanel() {
  return (
    <PanelBody title="Subtitles">
      <TrackGroup />
      <LookGroup />
    </PanelBody>
  );
}
