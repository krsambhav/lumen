import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw } from "lucide-react";
import { Group, GroupReset } from "@/components/ui/group";
import { IconButton } from "@/components/ui/icon-button";
import { PickerRow } from "@/components/ui/picker";
import { type ScaleCurve, ScaleRow } from "@/components/ui/scale";
import { PanelBody } from "@/features/inspector/PanelBody";
import { setShape } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { PresetPicker } from "@/features/presets/PresetPicker";
import { changeVideo, setPicture } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import type { Deinterlace, Ratio } from "@/ipc";
import { undoable } from "@/lib/notify";
import {
  LEVELS,
  levelSpoken,
  levelText,
  NEUTRAL_NAME,
  NEUTRAL_PICTURE,
  pictureName,
} from "./picture";
import {
  DEINTERLACE,
  isOwnShape,
  MAX_ZOOM,
  MIN_ZOOM,
  OWN_SHAPE,
  RATIOS,
  ratioName,
  sameRatio,
  turned,
  turnName,
  zoomText,
} from "./shape";

const AT_ZERO = [{ value: 0 }] as const;
const AT_ONE = [{ value: 1 }] as const;

/** Zoom counts in doublings: each doubling has the same length of scale. */
const DOUBLINGS = Math.log2(MAX_ZOOM / MIN_ZOOM);
const ZOOM_CURVE: ScaleCurve = {
  toFraction: (zoom) => Math.log2(Math.max(MIN_ZOOM, zoom) / MIN_ZOOM) / DOUBLINGS,
  fromFraction: (fraction) => MIN_ZOOM * 2 ** (fraction * DOUBLINGS),
};

/** The picker's value for "as the file has it", which no ratio's name is. */
const OWN = "own";

function ratioOptions(first: string) {
  return [
    { value: OWN, name: first },
    ...RATIOS.map((named) => ({ value: named.name, name: named.name })),
  ];
}

/** The ratio a picker's value stands for. */
function ratioFor(value: string): Ratio | null {
  return RATIOS.find((named) => named.name === value)?.ratio ?? null;
}

/** The picker's value for a ratio: its name, if it is one of the usual. */
function valueFor(ratio: Ratio | null): string {
  return ratio === null ? OWN : (RATIOS.find((named) => sameRatio(named.ratio, ratio))?.name ?? "");
}

/** The picture's levels: they stay until they are changed (DESIGN.md §7). */
function PictureGroup() {
  const picture = useSettings((state) => state.settings.video.picture);
  const saved = useSettings((state) => state.settings.video.presets);
  return (
    <Group
      title="Picture"
      trailing={
        <PresetPicker
          label="Picture preset"
          current={pictureName(picture, saved)}
          builtIn={[NEUTRAL_NAME]}
          saved={saved.map((preset) => preset.name)}
          onChoose={(name) =>
            setPicture(
              name === NEUTRAL_NAME
                ? NEUTRAL_PICTURE
                : (saved.find((preset) => preset.name === name)?.picture ?? picture),
            )
          }
          onSave={(name) =>
            changeVideo((video) => ({
              ...video,
              presets: [
                ...video.presets.filter(
                  (preset) => preset.name.toLowerCase() !== name.toLowerCase(),
                ),
                { name, picture: video.picture },
              ],
            }))
          }
          onDelete={(name) => {
            const before = saved;
            changeVideo((video) => ({
              ...video,
              presets: video.presets.filter((preset) => preset.name !== name),
            }));
            undoable("Deleted the preset", {
              id: `picture-preset-deleted-${name}`,
              name,
              undo: () => changeVideo((video) => ({ ...video, presets: before })),
            });
          }}
        />
      }
    >
      {LEVELS.map((level) => (
        <ScaleRow
          key={level.key}
          label={level.name}
          value={picture[level.key]}
          min={level.min}
          max={level.max}
          step={1}
          defaultValue={0}
          {...(level.bothWays ? { origin: 0, marks: AT_ZERO } : {})}
          valueText={levelSpoken(picture[level.key], level.bothWays)}
          display={levelText(picture[level.key], level.bothWays)}
          onChange={(value) => setPicture({ ...picture, [level.key]: value })}
        />
      ))}
    </Group>
  );
}

/** How the picture is turned, cut and stretched: it belongs to the file that is open. */
function FrameGroup() {
  const shape = usePlayer((state) => state.shape);
  return (
    <Group
      title="Frame"
      trailing={isOwnShape(shape) ? null : <GroupReset onClick={() => setShape(OWN_SHAPE)} />}
    >
      <PickerRow
        label="Aspect"
        value={valueFor(shape.aspect)}
        options={ratioOptions("Original")}
        placeholder={shape.aspect ? ratioName(shape.aspect) : ""}
        onChange={(value) => setShape({ ...shape, aspect: ratioFor(value) })}
      />
      <PickerRow
        label="Crop"
        value={valueFor(shape.crop)}
        options={ratioOptions("None")}
        placeholder={shape.crop ? ratioName(shape.crop) : ""}
        onChange={(value) => setShape({ ...shape, crop: ratioFor(value) })}
      />
      <ScaleRow
        label="Zoom"
        value={shape.zoom}
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={0.05}
        defaultValue={1}
        origin={1}
        marks={AT_ONE}
        curve={ZOOM_CURVE}
        valueText={`${Math.round(shape.zoom * 100)} percent`}
        display={zoomText(shape.zoom)}
        onChange={(zoom) => setShape({ ...shape, zoom })}
      />
      <div className="flex h-8 min-w-0 items-center gap-3">
        <span className="w-28 flex-none truncate text-body text-ink-2">Turn</span>
        {/* Four controls of one size, 4 px apart; the last one's mark stands at the column's edge. */}
        <span className="-mr-[7px] flex min-w-0 flex-1 items-center justify-end gap-1">
          <IconButton
            label="Rotate anticlockwise"
            detail={turnName(shape.turns)}
            onClick={() => setShape(turned(shape, false))}
          >
            <RotateCcw />
          </IconButton>
          <IconButton
            label="Rotate clockwise"
            detail={turnName(shape.turns)}
            onClick={() => setShape(turned(shape, true))}
          >
            <RotateCw />
          </IconButton>
          <IconButton
            label="Mirror"
            pressed={shape.mirrored}
            onClick={() => setShape({ ...shape, mirrored: !shape.mirrored })}
          >
            <FlipHorizontal2 />
          </IconButton>
          <IconButton
            label="Flip"
            pressed={shape.flipped}
            onClick={() => setShape({ ...shape, flipped: !shape.flipped })}
          >
            <FlipVertical2 />
          </IconButton>
        </span>
      </div>
      <PickerRow<Deinterlace>
        label="Deinterlace"
        value={shape.deinterlace}
        options={DEINTERLACE}
        onChange={(deinterlace) => setShape({ ...shape, deinterlace })}
      />
    </Group>
  );
}

/** The Video tab: the picture's levels, and the frame it is shown in (DESIGN.md §7). */
export function VideoPanel() {
  return (
    <PanelBody title="Video">
      <PictureGroup />
      <FrameGroup />
    </PanelBody>
  );
}
