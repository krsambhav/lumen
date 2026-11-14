import {
  Cast,
  Ellipsis,
  Gauge,
  Languages,
  Maximize,
  Minimize,
  Repeat,
  Repeat1,
  RotateCcw,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getAction, runAction } from "@/actions/registry";
import { NextGlyph, PauseGlyph, PlayGlyph, PreviousGlyph, StopGlyph } from "@/components/ui/glyphs";
import { IconButton } from "@/components/ui/icon-button";
import {
  Menu,
  MenuAction,
  MenuChoice,
  MenuContent,
  MenuSeparator,
  MenuSub,
  MenuTrigger,
} from "@/components/ui/menu";
import { Scale, type ScaleCurve } from "@/components/ui/scale";
import { Tooltip, TooltipOffset } from "@/components/ui/tooltip";
import { CastChoices, CastMenu } from "@/features/cast/CastMenu";
import { REPEAT_CHOICES, setRepeat } from "@/features/playlist/actions";
import { hasSeveral, useQueue } from "@/features/playlist/store";
import { useInterface } from "@/features/shell/interface";
import { SubtitleChoices, SubtitleControls } from "@/features/subtitles/SubtitleControls";
import { cn } from "@/lib/cn";
import { focusedFromKeyboard } from "@/lib/focus-origin";
import { spokenDuration, spokenPosition, wholeSecond } from "@/lib/timecode";
import { ActionButton } from "./ActionButton";
import { playLabel, setSpeed, setVolume } from "./actions";
import { useChrome, useChromeHold } from "./chrome";
import { formatSpeed, isNormalSpeed, nearestSpeed, SPEEDS, spokenSpeed } from "./speed";
import { usePlayer } from "./store";
import { Timecode } from "./Timecode";
import { Timeline } from "./Timeline";
import { tracksOf } from "./tracks";
import {
  formatVolume,
  fractionToVolume,
  MAX_VOLUME,
  NORMAL_VOLUME,
  VOLUME_STEP,
  volumeToFraction,
} from "./volume";
import { useWindowState } from "./window";

/**
 * How far the transport row's tooltips stand off their buttons: past the
 * 4 px above a button, the 24 px timeline and 4 px more, which is the line
 * the timeline's own hover timecode sits on. Nothing ever covers the track.
 */
const ABOVE_THE_TIMELINE = 32;
/** The volume needle is 14 px tall in a row of 36 px buttons: its top is this much lower than theirs. */
const NEEDLE_BELOW_BUTTON_TOP = 11;

function PlayButton() {
  const status = usePlayer((state) => state.status);
  if (status === "ended") {
    return (
      <ActionButton action="playback.toggle" label={playLabel(status)}>
        <RotateCcw />
      </ActionButton>
    );
  }
  const label = playLabel(status);
  return (
    <ActionButton action="playback.toggle" label={label}>
      {label === "Pause" ? <PauseGlyph /> : <PlayGlyph />}
    </ActionButton>
  );
}

const VOLUME_CURVE: ScaleCurve = { toFraction: volumeToFraction, fromFraction: fractionToVolume };

interface VolumeProps {
  /** The pointer or the keyboard has come to the group, or left it. */
  onAttention: (attended: boolean) => void;
}

function Volume({ onAttention }: VolumeProps) {
  const volume = usePlayer((state) => state.volume);
  const muted = usePlayer((state) => state.muted);
  const silent = muted || volume === 0;
  const Icon = silent ? VolumeX : volume < 50 ? Volume1 : Volume2;
  const shown = Math.round(volume);
  // The pointer over the group and keyboard focus inside it are told apart:
  // a button that was only clicked keeps focus, and must not hold the scale open.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const attended = hovered || focused;
  useEffect(() => onAttention(attended), [attended, onAttention]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only hears the pointer and the focus arrive at the controls inside it
    <div
      className="relative flex flex-none items-center"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(event) => setFocused(focusedFromKeyboard(event.target))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <ActionButton action="audio.mute" pressed={muted}>
        <Icon />
      </ActionButton>
      {/*
        On a stage under 720 px wide the scale folds into Mute. When the
        pointer or the keyboard comes to the group it opens beside Mute, over
        the readouts, which fade while it is open: nothing in the row moves
        (DESIGN.md §4). The stage says how wide it is: see Stage.tsx.
      */}
      <div
        className={cn(
          // 4 px after Mute, then the 96 px scale.
          "w-[6.25rem] flex-none pl-1",
          "transition-opacity duration-fast ease-out",
          // Folded, it takes no room in the row: it stands just after Mute, out of the flow.
          "group-data-[narrow]/stage:absolute group-data-[narrow]/stage:left-full group-data-[narrow]/stage:top-0 group-data-[narrow]/stage:flex group-data-[narrow]/stage:h-full group-data-[narrow]/stage:items-center",
          !attended &&
            "group-data-[narrow]/stage:pointer-events-none group-data-[narrow]/stage:opacity-0",
        )}
      >
        <Scale
          label="Volume"
          min={0}
          max={MAX_VOLUME}
          step={VOLUME_STEP}
          end={NORMAL_VOLUME}
          value={shown}
          defaultValue={NORMAL_VOLUME}
          curve={VOLUME_CURVE}
          // Resting on the mark, the reading says what the mark means; muted, that it is muted.
          marks={[
            muted
              ? { value: NORMAL_VOLUME }
              : { value: NORMAL_VOLUME, label: "100 percent, normal volume" },
          ]}
          valueText={muted ? `${shown} percent, muted` : `${shown} percent`}
          dimmed={muted}
          tooltip={{
            label: muted ? `Volume ${formatVolume(shown)}, muted` : `Volume ${formatVolume(shown)}`,
            shortcut: ["Up", "Down"],
            // On the same line as the buttons' tooltips.
            offset: ABOVE_THE_TIMELINE + NEEDLE_BELOW_BUTTON_TOP,
          }}
          onChange={setVolume}
        />
      </div>
    </div>
  );
}

const READOUT =
  "relative flex h-9 flex-none items-center whitespace-nowrap rounded-sm px-2 text-body text-stage-ink-2";

/**
 * Elapsed and total time; a click switches the second figure to time
 * remaining. The digits are for the eye: what assistive technology reads is
 * the same reading in words, as the control's own content, so its name is
 * what is on screen (DESIGN.md §7, §9).
 */
function TimeReadout() {
  const duration = usePlayer((state) => state.duration);
  const second = usePlayer((state) => wholeSecond(state.position));
  // The choice is remembered between runs.
  const remaining = useInterface((state) => state.timeRemaining);
  const setRemaining = useInterface((state) => state.setTimeRemaining);

  if (duration === null) {
    return (
      <span className={READOUT}>
        <span aria-hidden="true">
          <Timecode seconds={second} />
        </span>
        <span className="sr-only">{spokenDuration(second)} played</span>
      </span>
    );
  }
  const left = Math.max(0, duration - second);
  return (
    <Tooltip label={remaining ? "Show total time" : "Show time remaining"}>
      <button
        type="button"
        onClick={() => setRemaining(!remaining)}
        className={cn(
          READOUT,
          "transition-colors duration-fast ease-out hover:bg-stage-hover hover:text-stage-ink active:bg-stage-press",
        )}
      >
        {remaining ? (
          // "−1:19:28" already says it is what is left: no "of" before it.
          <span aria-hidden="true" className="flex items-center gap-2">
            <Timecode seconds={second} span={duration} className="text-stage-ink" />
            <Timecode
              seconds={left}
              span={duration}
              prefix="−"
              className="group-data-[tight]/stage:hidden"
            />
          </span>
        ) : (
          <span aria-hidden="true" className="flex items-center gap-1">
            <Timecode seconds={second} span={duration} className="text-stage-ink" />
            {/* On the narrowest stage the second figure goes; the first is the one that changes. */}
            <span className="flex items-center gap-1 group-data-[tight]/stage:hidden">
              <span>/</span>
              <Timecode seconds={duration} span={duration} />
            </span>
          </span>
        )}
        <span className="sr-only">
          {remaining
            ? `${spokenDuration(second)} played, ${spokenDuration(left)} remaining`
            : spokenPosition(second, duration)}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The speed, shown only while it is not 1× (DESIGN.md §7, "Speed"): a film
 * running fast or slow is a state someone must be able to see. A click
 * returns to normal.
 */
function SpeedReadout() {
  const speed = usePlayer((state) => state.speed);
  if (isNormalSpeed(speed)) {
    return null;
  }
  return (
    <Tooltip
      label="Return to normal speed"
      shortcut={getAction("playback.normalSpeed")?.shortcuts[0]}
    >
      <button
        type="button"
        onClick={() => runAction("playback.normalSpeed", "control")}
        className={cn(
          READOUT,
          "tabular text-stage-ink transition-colors duration-fast ease-out hover:bg-stage-hover active:bg-stage-press",
        )}
      >
        <span aria-hidden="true">{formatSpeed(speed)}</span>
        <span className="sr-only">Playing at {spokenSpeed(speed)}</span>
      </button>
    </Tooltip>
  );
}

/** Previous and Next, in the row only while the playlist has somewhere to go (DESIGN.md §4). */
function Transport() {
  const several = useQueue(hasSeveral);
  // Read so that the buttons' availability follows the queue.
  useQueue((state) => `${state.hasNext}${state.hasPrevious}`);
  return (
    <div className="flex flex-none items-center gap-1">
      {several ? (
        <ActionButton action="playlist.previous">
          <PreviousGlyph />
        </ActionButton>
      ) : null}
      <PlayButton />
      {several ? (
        <ActionButton action="playlist.next">
          <NextGlyph />
        </ActionButton>
      ) : null}
      {/* After Play (and Next, which stays beside it): stops, and the window goes back to Home. */}
      <ActionButton action="playback.stop">
        <StopGlyph />
      </ActionButton>
    </div>
  );
}

/**
 * Everything that has no place of its own in the row (DESIGN.md §4). The
 * chrome stays while it is open.
 */
function MoreMenu() {
  const [open, setOpen] = useState(false);
  // On a tight stage the subtitles' controls leave the row and are listed here (DESIGN.md §4).
  const [tight, setTight] = useState(false);
  // On a crowded stage Cast leaves the row and is listed here.
  const [narrow, setNarrow] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useChromeHold("menu", open);
  const hasSubtitles = usePlayer((state) => tracksOf(state.tracks, "subtitle").length > 0);
  const speed = usePlayer((state) => state.speed);
  const repeat = useQueue((state) => state.repeat);
  // The nearest step, so one of them is always marked.
  const marked = nearestSpeed(speed);
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setTight(trigger.current?.closest("[data-tight]") != null);
          setNarrow(trigger.current?.closest("[data-crowded]") != null);
        }
        setOpen(next);
      }}
    >
      <MenuTrigger asChild>
        <IconButton ref={trigger} label="More">
          <Ellipsis />
        </IconButton>
      </MenuTrigger>
      <MenuContent side="top" align="end" checkable>
        {tight ? (
          <>
            <MenuAction action="subtitles.toggle" />
            {hasSubtitles ? (
              <MenuSub label="Subtitle track" icon={Languages} checkable>
                <SubtitleChoices />
              </MenuSub>
            ) : null}
            <MenuSeparator />
          </>
        ) : null}
        {narrow ? (
          <>
            <MenuSub label="Cast" icon={Cast} checkable>
              <CastChoices open={open} anchor={() => trigger.current?.getBoundingClientRect()} />
            </MenuSub>
            <MenuSeparator />
          </>
        ) : null}
        <MenuSub label="Speed" icon={Gauge} checkable>
          <MenuChoice
            label="Speed"
            value={String(marked)}
            options={SPEEDS.map((each) => ({
              value: String(each),
              name: isNormalSpeed(each) ? "Normal" : formatSpeed(each),
            }))}
            onChange={(value) => setSpeed({ source: "menu" }, Number(value))}
          />
        </MenuSub>
        <MenuSub label="Repeat" icon={repeat === "one" ? Repeat1 : Repeat} checkable>
          <MenuChoice
            label="Repeat"
            value={repeat}
            options={REPEAT_CHOICES}
            onChange={(value) => setRepeat({ source: "menu" }, value)}
          />
        </MenuSub>
        <MenuAction action="playlist.shuffle" />
        <MenuSeparator />
        <MenuAction action="playback.goToTime" />
        <MenuSeparator />
        <MenuAction action="window.keepOnTop" />
        <MenuSeparator />
        <MenuAction action="view.palette" />
      </MenuContent>
    </Menu>
  );
}

function FullscreenButton() {
  const fullscreen = useWindowState((state) => state.fullscreen);
  return (
    <ActionButton
      action="view.fullscreen"
      label={fullscreen ? "Exit full screen" : "Enter full screen"}
    >
      {fullscreen ? <Minimize /> : <Maximize />}
    </ActionButton>
  );
}

/**
 * The controls at the bottom of the stage: the timeline over the transport
 * row, on the bottom scrim (DESIGN.md §4, §7).
 */
export function ControlBar() {
  const rest = useChrome((state) => state.rest);
  const [volumeAttended, setVolumeAttended] = useState(false);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-scrim-bottom bg-scrim-bottom">
      {/* Resting on the bar keeps the chrome up; the controls inside are the interactive elements. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own box and legend; this is only a name for the group */}
      <div
        role="group"
        aria-label="Player controls"
        className="pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col px-gutter pb-2.5 pt-1.5"
        onPointerEnter={() => rest("controls", true)}
        onPointerLeave={() => rest("controls", false)}
      >
        <Timeline />
        {/*
          Three groups, 12 px apart with 4 px inside each, then the spacer,
          then the right-hand controls. Label-sized items never shrink; only
          the spacer does. The row is 9 px wider than the timeline at each
          end, so the ink of the first and last icon meets the ends of the
          track.
        */}
        <TooltipOffset value={ABOVE_THE_TIMELINE}>
          <div className="-mx-[9px] flex h-11 min-w-0 items-center gap-3">
            <Transport />
            <Volume onAttention={setVolumeAttended} />
            {/* The readout and, while it is not 1×, the speed: one group, 4 px apart. */}
            <div
              className={cn(
                "flex flex-none items-center gap-1 transition-opacity duration-fast ease-out",
                // On a narrow stage the volume's scale opens over these, and they step aside for it.
                volumeAttended &&
                  "group-data-[narrow]/stage:pointer-events-none group-data-[narrow]/stage:opacity-0",
              )}
            >
              <TimeReadout />
              <SpeedReadout />
            </div>
            <div className="min-w-0 flex-1" />
            <SubtitleControls />
            {/* On a crowded stage it leaves for More (DESIGN.md §4). */}
            <div className="flex flex-none items-center group-data-[crowded]/stage:hidden">
              <CastMenu />
            </div>
            <div className="flex flex-none items-center gap-1">
              <MoreMenu />
              <FullscreenButton />
            </div>
          </div>
        </TooltipOffset>
      </div>
    </div>
  );
}
