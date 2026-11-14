/**
 * Development only: every design-system primitive in every theme and state,
 * for checking against DESIGN.md. It is compiled in only when the build sets
 * VITE_LUMEN_DEVTOOLS (scripts/shot.sh does); release builds never contain it.
 */

import { Captions, Cast, Maximize, PictureInPicture2, Volume2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Band } from "@/components/ui/band";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NextGlyph, PauseGlyph, PlayGlyph, PreviousGlyph } from "@/components/ui/glyphs";
import { Group } from "@/components/ui/group";
import { IconButton } from "@/components/ui/icon-button";
import { ListBox } from "@/components/ui/list-box";
import {
  ContextMenuArea,
  Menu,
  MenuChoice,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuTrigger,
} from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { PickerRow } from "@/components/ui/picker";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Scale, ScaleRow } from "@/components/ui/scale";
import { Shortcut } from "@/components/ui/shortcut";
import { SurfaceProvider } from "@/components/ui/surface";
import { Swatches } from "@/components/ui/swatches";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Mark } from "@/features/shell/Mark";
import { TitleBar } from "@/features/shell/TitleBar";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      {/* A group label, not a heading: the gallery has no document outline. */}
      <p className="label text-ink-3">{title}</p>
      {children}
    </section>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex w-16 flex-none flex-col gap-1">
      <div className={`h-8 rounded-sm border border-line ${className}`} />
      <span className="truncate text-caption text-ink-3">{name}</span>
    </div>
  );
}

function Controls() {
  const [volume, setVolume] = useState(65);
  const [gain, setGain] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <Section title="Type">
        <div className="flex flex-col gap-1">
          <p className="text-display">Drop a video to play</p>
          <p className="text-title">Playback</p>
          <p className="text-heading">Video tuner</p>
          <p className="text-body">
            The quick brown fox jumps over the lazy dog.{" "}
            <strong className="font-semibold">Emphasis</strong> is weight, not colour.
          </p>
          <p className="text-caption text-ink-2">1080p · HEVC · 2 h 1 min</p>
          <p className="tabular text-body text-ink-2">0:42:17 / 2:01:45 · 1.25× · +6 dB</p>
        </div>
      </Section>

      <Section title="Colour">
        <div className="flex flex-wrap gap-2">
          <Swatch name="bg" className="bg-bg" />
          <Swatch name="surface-1" className="bg-surface-1" />
          <Swatch name="surface-2" className="bg-surface-2" />
          <Swatch name="surface-3" className="bg-surface-3" />
          <Swatch name="line" className="bg-line" />
          <Swatch name="line-strong" className="bg-line-strong" />
          <Swatch name="ink-3" className="bg-ink-3" />
          <Swatch name="ink-2" className="bg-ink-2" />
          <Swatch name="ink-1" className="bg-ink-1" />
          <Swatch name="accent" className="bg-accent" />
          <Swatch name="soft" className="bg-accent-soft" />
          <Swatch name="danger" className="bg-danger" />
          <Swatch name="warning" className="bg-warning" />
          <Swatch name="success" className="bg-success" />
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Open file…</Button>
          <Button>Add folder</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Remove from library</Button>
          <Button disabled>Add folder</Button>
          <Button busy>Download</Button>
          <Button size="sm">Add folder</Button>
        </div>
      </Section>

      <Section title="Icon buttons">
        <div className="flex items-center gap-1">
          <IconButton label="Previous item" shortcut="Cmd+Left">
            <PreviousGlyph />
          </IconButton>
          <IconButton label="Play" shortcut="Space">
            <PlayGlyph />
          </IconButton>
          <IconButton label="Next item" shortcut="Cmd+Right">
            <NextGlyph />
          </IconButton>
          <IconButton label="Subtitles" shortcut="v" pressed>
            <Captions />
          </IconButton>
          <IconButton label="Cast" shortcut="Cmd+d" unavailable="No devices found on this network">
            <Cast />
          </IconButton>
        </div>
      </Section>

      <Section title="Scales">
        <div className="flex w-80 flex-col gap-1">
          <ScaleRow
            label="Volume"
            display={`${volume}%`}
            min={0}
            max={200}
            value={volume}
            defaultValue={100}
            marks={[{ value: 100, label: "100 percent, normal volume" }]}
            valueText={`${volume} percent`}
            onChange={setVolume}
          />
          <ScaleRow
            label="Brightness"
            display={gain > 0 ? `+${gain}` : String(gain)}
            min={-12}
            max={12}
            value={gain}
            defaultValue={0}
            marks={[{ value: 0, label: "0, unchanged" }]}
            divisions={12}
            valueText={String(gain)}
            onChange={setGain}
          />
          <ScaleRow
            label="Noise reduction"
            display="Off"
            min={0}
            max={100}
            value={0}
            valueText="Off"
            disabled
            onChange={() => {}}
          />
        </div>
      </Section>

      <Section title="Panel controls">
        <PanelControls />
      </Section>

      <Section title="Shortcuts">
        <div className="flex items-center gap-4 text-caption text-ink-2">
          <Shortcut chord="Shift+Cmd+k" />
          <Shortcut chord="Space" />
          <Shortcut chord="Alt+Left" />
          <Shortcut chord="Up" />
          <Shortcut chord="Ctrl+Cmd+f" variant="keycap" />
          <Shortcut chord="v" variant="keycap" />
        </div>
      </Section>

      <Section title="Fields">
        <Fields />
      </Section>

      <Section title="List rows">
        <Rows />
      </Section>
    </div>
  );
}

/** A small label under a specimen, saying what it shows. */
function Caption({ children }: { children: ReactNode }) {
  return <p className="pt-1 text-caption text-ink-3">{children}</p>;
}

const COLOURS = [
  { value: "#FFFFFF", name: "White" },
  { value: "#F2EFE4", name: "Warm white" },
  { value: "#FFE14D", name: "Yellow" },
  { value: "#9FE8FF", name: "Pale blue" },
];

const GAIN_BANDS = ["31", "62", "125", "250", "500"];

function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0";
}

/** The parts of the Video, Audio and Subtitles tabs (DESIGN.md §7). */
function PanelControls() {
  const [hue, setHue] = useState(-30);
  const [contrast, setContrast] = useState(0);
  const [bold, setBold] = useState(false);
  const [on, setOn] = useState(true);
  const [aspect, setAspect] = useState("own");
  const [colour, setColour] = useState("#FFE14D");
  const [gains, setGains] = useState([4, 2, 0, -1.5, -4]);
  return (
    <div className="flex w-80 flex-col gap-5">
      <div>
        <Group
          title="Group, with Reset"
          trailing={
            hue === 0 && contrast === 0 ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setHue(0);
                  setContrast(0);
                }}
              >
                Reset
              </Button>
            )
          }
        >
          <ScaleRow
            label="Hue"
            display={signed(hue)}
            min={-100}
            max={100}
            value={hue}
            defaultValue={0}
            origin={0}
            marks={[{ value: 0 }]}
            valueText={String(hue)}
            onChange={setHue}
          />
          <ScaleRow
            label="Contrast"
            display={signed(contrast)}
            min={-100}
            max={100}
            value={contrast}
            defaultValue={0}
            origin={0}
            marks={[{ value: 0 }]}
            valueText={String(contrast)}
            onChange={setContrast}
          />
        </Group>
        <Caption>Scale with origin; Reset only when not neutral</Caption>
      </div>
      <div>
        <PickerRow
          label="Aspect"
          value={aspect}
          options={[
            { value: "own", name: "Original" },
            { value: "16:9", name: "16:9" },
            { value: "2.39:1", name: "2.39:1" },
          ]}
          onChange={setAspect}
        />
        <Caption>Picker: the menu checks the present choice</Caption>
      </div>
      <div>
        <SwitchRow
          name="Bold"
          hint="A click on the name works it."
          checked={bold}
          onChange={setBold}
        />
        <div className="flex h-8 items-center gap-3">
          <Switch label="On" checked onChange={() => {}} />
          <Switch label="Off" checked={false} onChange={() => {}} />
          <Switch label="Unavailable" checked disabled onChange={() => {}} />
        </div>
        <Caption>Switch: on, off, unavailable</Caption>
      </div>
      <div>
        <div className="flex h-8 items-center justify-end">
          <Swatches label="Colour" value={colour} swatches={COLOURS} onChange={setColour} />
        </div>
        <Caption>Swatches: the last opens the colour panel</Caption>
      </div>
      <div>
        <div className="flex h-7 items-center gap-2">
          <p className="label min-w-0 flex-1 truncate text-ink-3">Bands</p>
          <Switch label="Bands on" checked={on} onChange={setOn} />
        </div>
        <div className="flex gap-3 pt-1">
          {GAIN_BANDS.map((hertz, band) => {
            const gain = gains[band] ?? 0;
            return (
              <Band
                key={hertz}
                label={`${hertz} hertz`}
                caption={hertz}
                value={gain}
                min={-12}
                max={12}
                step={0.5}
                origin={0}
                valueText={`${gain} decibels`}
                display={`${signed(gain)} dB`}
                dimmed={!on}
                onChange={(next) =>
                  setGains(gains.map((each, index) => (index === band ? next : each)))
                }
              />
            );
          })}
        </div>
        <Caption>Band: lit from 0; dims in place when off</Caption>
      </div>
    </div>
  );
}

const EPISODES = [
  { id: 1, name: "The Crossing S01E01 Departures.mkv", length: "48:12" },
  { id: 2, name: "The Crossing S01E02 The Ferryman.mkv", length: "51:40" },
  {
    id: 3,
    name: "The Crossing S01E03 A Very Long Episode Title That Goes On And On.mkv",
    length: "1:02:09",
  },
  { id: 4, name: "The Crossing S01E04 Night Passage.mkv", length: "47:55" },
  { id: 5, name: "The Crossing S01E05 Low Water.mkv", length: null },
];

/** Menus, popovers and toasts open over the page, so they take the window's theme, not the column's. */
function Overlays() {
  const [shuffle, setShuffle] = useState(true);
  const [speed, setSpeed] = useState("1");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Menu>
        <MenuTrigger asChild>
          <Button>Menu</Button>
        </MenuTrigger>
        <MenuContent checkable>
          <MenuSub label="Speed" checkable>
            <MenuChoice
              label="Speed"
              value={speed}
              options={[
                { value: "0.5", name: "0.5×" },
                { value: "1", name: "Normal" },
                { value: "1.5", name: "1.5×" },
                { value: "2", name: "2×" },
              ]}
              onChange={setSpeed}
            />
          </MenuSub>
          <MenuItem checked={shuffle} shortcut="s" onSelect={() => setShuffle(!shuffle)}>
            Shuffle
          </MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="Cmd+j">Go to time…</MenuItem>
          <MenuItem disabled shortcut="Shift+Cmd+Right">
            Next chapter
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Saved playlists</MenuLabel>
          <MenuItem detail="12 items">Friday night</MenuItem>
          <MenuItem detail="3 items">
            A playlist with a name that is much longer than its menu is wide
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger>Delete “Friday night”</MenuItem>
        </MenuContent>
      </Menu>
      <ContextMenuArea
        menu={
          <>
            <MenuItem>Play from the beginning</MenuItem>
            <MenuItem>Show in Finder</MenuItem>
            <MenuSeparator />
            <MenuItem>Remove from recently played</MenuItem>
          </>
        }
      >
        <div className="flex h-8 flex-none items-center whitespace-nowrap rounded-sm border border-line-strong px-3 text-caption text-ink-2">
          Secondary click
        </div>
      </ContextMenuArea>
      <Popover>
        <PopoverTrigger asChild>
          <Button>Popover</Button>
        </PopoverTrigger>
        <PopoverContent label="Save playlist" align="start">
          <div className="flex flex-col gap-3">
            <Field label="Name" defaultValue="Friday night" />
            <div className="flex justify-end gap-2">
              <PopoverClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </PopoverClose>
              <PopoverClose asChild>
                <Button variant="primary" size="sm">
                  Save
                </Button>
              </PopoverClose>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Button
        onClick={() =>
          toast("Removed “The Ferryman” from the playlist", {
            action: { label: "Undo", onClick: () => {} },
          })
        }
      >
        Toast
      </Button>
      <Button
        onClick={() =>
          toast.error("Lumen could not open that", {
            description: "The file is no longer where it was. It may have been moved or renamed.",
            duration: Number.POSITIVE_INFINITY,
          })
        }
      >
        Failure
      </Button>
    </div>
  );
}

function Rows() {
  const [selected, setSelected] = useState<number | null>(2);
  return (
    <div className="flex h-40 w-80 max-w-full flex-col rounded-md border border-line bg-surface-1 py-1">
      <ListBox
        label="Sample playlist"
        items={EPISODES}
        getId={(item) => item.id}
        getLabel={(item, index) => `${index + 1}, ${item.name}`}
        rowHeight={28}
        selected={selected}
        onSelect={setSelected}
        onActivate={() => {}}
        current={1}
        renderRow={(item, { index }) => (
          <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 px-2">
            <span className="tabular flex w-7 flex-none items-center justify-end text-caption text-ink-3">
              {item.id === 1 ? <span className="needle mr-1 h-3 w-0.5 rounded-xs" /> : index + 1}
            </span>
            <MiddleTruncate
              text={item.name}
              className={item.id === 1 ? "flex-1 font-semibold" : "flex-1"}
            />
            <span className="tabular flex w-14 flex-none justify-end whitespace-nowrap text-caption text-ink-2">
              {item.length}
            </span>
          </span>
        )}
      />
    </div>
  );
}

function Fields() {
  return (
    <div className="flex w-80 max-w-full flex-col gap-3">
      <Field label="Name" placeholder="Friday night" />
      <Field
        label="Go to"
        defaultValue="1:02:45"
        hint="A time, or a share of the film: 1:02:45, 90 s, 50%."
      />
      <Field
        label="Name"
        defaultValue="Friday night"
        error="There is already a playlist called “Friday night”."
      />
    </div>
  );
}

function TitleBars() {
  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="titlebar-long"
        className="w-[560px] max-w-full rounded-md border border-line bg-bg"
      >
        <TitleBar
          title="The.Extremely.Long.Documentary.Series.About.Light.And.Lenses.S01E03.2160p.HDR.mkv"
          actions={
            <IconButton label="Keep on top" shortcut="Cmd+t">
              <Captions />
            </IconButton>
          }
        />
      </div>
      <div
        data-testid="titlebar-short"
        className="w-[560px] max-w-full rounded-md border border-line bg-bg"
      >
        <TitleBar title="Lumen" />
      </div>
    </div>
  );
}

function StageSample() {
  const [volume, setVolume] = useState(65);
  const [playing, setPlaying] = useState(false);
  return (
    <SurfaceProvider value="stage">
      <div className="stage relative h-96 overflow-hidden rounded-md bg-[linear-gradient(120deg,#7a8f6a,#c9b48a_40%,#f1e9d8_70%,#8fb3c9)]">
        <p className="outlined-text tabular absolute right-gutter top-[calc(var(--titlebar-h)+0.25rem)] flex items-baseline gap-3 whitespace-nowrap text-osd text-stage-ink">
          <span>Volume</span>
          <span>65%</span>
        </p>
        <div className="absolute inset-x-0 bottom-0 flex h-scrim-bottom items-end bg-scrim-bottom px-gutter pb-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <IconButton
              label={playing ? "Pause" : "Play"}
              shortcut="Space"
              onClick={() => setPlaying(!playing)}
            >
              {playing ? <PauseGlyph /> : <PlayGlyph />}
            </IconButton>
            <IconButton label="Mute" shortcut="m">
              <Volume2 />
            </IconButton>
            <Scale
              className="w-24 flex-none"
              label="Volume"
              min={0}
              max={200}
              value={volume}
              marks={[{ value: 100 }]}
              valueText={`${volume} percent`}
              onChange={setVolume}
            />
            <span className="tabular flex-none whitespace-nowrap pl-3 text-body text-stage-ink-2">
              0:42:17 / 2:01:45
            </span>
            <div className="min-w-0 flex-1" />
            <IconButton label="Subtitles" shortcut="v" pressed>
              <Captions />
            </IconButton>
            <IconButton label="Picture in picture" shortcut="Cmd+p">
              <PictureInPicture2 />
            </IconButton>
            <IconButton label="Full screen" shortcut="Ctrl+Cmd+f">
              <Maximize />
            </IconButton>
          </div>
        </div>
      </div>
    </SurfaceProvider>
  );
}

export function Gallery() {
  return (
    <TooltipProvider>
      <div className="scrollbar-thin grid h-full grid-cols-2 overflow-auto">
        <div data-theme="dark" className="flex flex-col gap-6 bg-bg p-8 text-ink-1">
          <Mark />
          <Controls />
          <Section title="Title bar">
            <TitleBars />
          </Section>
          <Section title="Menu, popover, toast">
            <Overlays />
          </Section>
          <Section title="Stage">
            <StageSample />
          </Section>
        </div>
        <div data-theme="light" className="flex flex-col gap-6 bg-bg p-8 text-ink-1">
          <Mark />
          <Controls />
          <Section title="Stage">
            <StageSample />
          </Section>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
