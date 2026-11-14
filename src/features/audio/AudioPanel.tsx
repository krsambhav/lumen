import { Group, GroupReset } from "@/components/ui/group";
import { PickerRow } from "@/components/ui/picker";
import { ScaleRow } from "@/components/ui/scale";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { PanelBody } from "@/features/inspector/PanelBody";
import { delaySpoken, delayText, setAudioDelay } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { TrackList } from "@/features/player/TrackList";
import { playingAudio, tracksOf } from "@/features/player/tracks";
import { PresetPicker } from "@/features/presets/PresetPicker";
import { changeAudio, setEqualiser } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import { type Channels, commands } from "@/ipc";
import { send, undoable } from "@/lib/notify";
import { EqualiserBands } from "./EqualiserBands";
import { BUILT_IN, presetOf } from "./equaliser";

const AT_ZERO = [{ value: 0 }] as const;

/** The furthest the Delay scale reaches either way, in seconds; the keys go further. */
const DELAY_REACH = 1;

/** The picker's value for "whatever the Mac is using", which no device's id is. */
const SYSTEM = "system";

const CHANNELS: readonly { value: Channels; name: string; detail?: string }[] = [
  { value: "auto", name: "Automatic", detail: "As the device has" },
  { value: "stereo", name: "Stereo" },
  { value: "surround51", name: "5.1" },
  { value: "surround71", name: "7.1" },
];

/** The sound of the file that is open: which track, and how far it is moved against the picture. */
function TrackGroup() {
  const tracks = usePlayer((state) => state.tracks);
  const delay = usePlayer((state) => state.audioDelay);
  const audio = tracksOf(tracks, "audio");
  return (
    <Group
      title="Track"
      // The track has no neutral to go back to; its delay has.
      trailing={delay === 0 ? null : <GroupReset onClick={() => setAudioDelay(0)} />}
    >
      {audio.length === 0 ? (
        <p className="flex min-h-7 items-center text-body text-ink-2">This file has no sound.</p>
      ) : (
        <TrackList
          label="Audio track"
          tracks={audio}
          selected={playingAudio(tracks)?.id ?? null}
          onChoose={(id) => send("change the audio track", commands.playerSelectTrack("audio", id))}
        />
      )}
      <ScaleRow
        label="Delay"
        value={delay}
        min={-DELAY_REACH}
        max={DELAY_REACH}
        step={0.01}
        defaultValue={0}
        origin={0}
        marks={AT_ZERO}
        disabled={audio.length === 0}
        valueText={delaySpoken(delay)}
        display={delayText(delay)}
        onChange={setAudioDelay}
      />
    </Group>
  );
}

function EqualiserGroup() {
  const equaliser = useSettings((state) => state.settings.audio.equaliser);
  const saved = useSettings((state) => state.settings.audio.presets);
  const bypassed = useSettings((state) => state.settings.audio.passthrough);
  return (
    <Group
      title="Equaliser"
      trailing={
        <>
          <PresetPicker
            label="Equaliser preset"
            current={presetOf(equaliser.gains, saved)?.name ?? null}
            builtIn={BUILT_IN.map((preset) => preset.name)}
            saved={saved.map((preset) => preset.name)}
            onChoose={(name) => {
              const preset = [...saved, ...BUILT_IN].find((each) => each.name === name);
              if (preset) {
                // Choosing a sound is asking to hear it.
                setEqualiser({ enabled: true, gains: [...preset.gains] });
              }
            }}
            onSave={(name) =>
              changeAudio((audio) => ({
                ...audio,
                presets: [
                  ...audio.presets.filter(
                    (preset) => preset.name.toLowerCase() !== name.toLowerCase(),
                  ),
                  { name, gains: [...audio.equaliser.gains] },
                ],
              }))
            }
            onDelete={(name) => {
              const before = saved;
              changeAudio((audio) => ({
                ...audio,
                presets: audio.presets.filter((preset) => preset.name !== name),
              }));
              undoable("Deleted the preset", {
                id: `equaliser-preset-deleted-${name}`,
                name,
                undo: () => changeAudio((audio) => ({ ...audio, presets: before })),
              });
            }}
          />
          <Switch
            label="Equaliser"
            checked={equaliser.enabled}
            onChange={(enabled) => setEqualiser({ ...equaliser, enabled })}
          />
        </>
      }
    >
      <EqualiserBands
        equaliser={equaliser}
        dimmed={!equaliser.enabled || bypassed}
        // Moving a band is asking to hear it.
        onChange={(next) => setEqualiser({ ...next, enabled: true })}
      />
      {bypassed && equaliser.enabled ? (
        <p className="pt-2 text-caption text-ink-3">
          Not applied while Dolby and DTS are passed through.
        </p>
      ) : null}
    </Group>
  );
}

/** Where sound goes, and in what form: it stays until it is changed. */
function OutputGroup() {
  const devices = usePlayer((state) => state.audioDevices);
  const audio = useSettings((state) => state.settings.audio);
  return (
    <Group title="Output">
      <PickerRow
        label="Device"
        value={audio.device ?? SYSTEM}
        options={[
          { value: SYSTEM, name: "System default" },
          ...devices.map((device) => ({ value: device.id, name: device.name })),
        ]}
        // Chosen once, and not plugged in now: sound follows the Mac meanwhile.
        placeholder="Not connected"
        onChange={(value) =>
          changeAudio((current) => ({ ...current, device: value === SYSTEM ? null : value }))
        }
      />
      <PickerRow<Channels>
        label="Channels"
        value={audio.channels}
        options={CHANNELS}
        onChange={(channels) => changeAudio((current) => ({ ...current, channels }))}
      />
      <SwitchRow
        name="Pass through Dolby and DTS"
        hint="For a receiver that decodes them itself."
        checked={audio.passthrough}
        onChange={(passthrough) => changeAudio((current) => ({ ...current, passthrough }))}
      />
      <SwitchRow
        name="Visualiser"
        hint="Draws the sound of a file that has no picture, from the next one opened."
        checked={audio.visualiser}
        onChange={(visualiser) => changeAudio((current) => ({ ...current, visualiser }))}
      />
    </Group>
  );
}

/** The Audio tab: the file's sound, the equaliser, and where sound goes (DESIGN.md §7). */
export function AudioPanel() {
  return (
    <PanelBody title="Audio">
      <TrackGroup />
      <EqualiserGroup />
      <OutputGroup />
    </PanelBody>
  );
}
