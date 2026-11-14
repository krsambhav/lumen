import { Captions, Languages } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import {
  Menu,
  MenuAction,
  MenuChoice,
  MenuContent,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { ActionButton } from "@/features/player/ActionButton";
import { useChromeHold } from "@/features/player/chrome";
import { usePlayer } from "@/features/player/store";
import { shownSubtitle, trackFormat, trackName, tracksOf } from "@/features/player/tracks";
import type { Track } from "@/ipc";
import { chooseSubtitles } from "./actions";

const OFF = "off";

/** The subtitle tracks, and the one showing, from the player's state. */
function useSubtitleTracks(): { tracks: Track[]; shown: Track | undefined } {
  const all = usePlayer((state) => state.tracks);
  return { tracks: tracksOf(all, "subtitle"), shown: shownSubtitle(all) };
}

/**
 * Off and each subtitle track, the one showing checked: inside the track
 * menu, and inside More when the row is too narrow for the menu's button.
 */
export function SubtitleChoices() {
  const { tracks, shown } = useSubtitleTracks();
  if (tracks.length === 0) {
    return null;
  }
  return (
    <MenuChoice
      label="Subtitle track"
      value={shown ? String(shown.id) : OFF}
      options={[
        { value: OFF, name: "Off" },
        ...tracks.map((track) => ({
          value: String(track.id),
          name: trackName(track),
          detail: trackFormat(track),
        })),
      ]}
      onChange={(value) =>
        chooseSubtitles(
          { source: "menu" },
          tracks.find((track) => String(track.id) === value) ?? null,
        )
      }
    />
  );
}

/** Choosing the subtitles: the tracks, then adding a file and the panel's settings. */
function SubtitleMenu() {
  const [open, setOpen] = useState(false);
  useChromeHold("menu", open);
  const { tracks, shown } = useSubtitleTracks();
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <IconButton label="Subtitle track" detail={shown ? trackName(shown) : "Off"}>
          <Languages />
        </IconButton>
      </MenuTrigger>
      <MenuContent side="top" align="end" checkable>
        <SubtitleChoices />
        {tracks.length > 0 ? <MenuSeparator /> : null}
        <MenuAction action="subtitles.add" />
        <MenuAction action="view.subtitles" />
      </MenuContent>
    </Menu>
  );
}

/**
 * The subtitles' two controls in the transport row (DESIGN.md §7): CC
 * turns them on and off, lit while they show; beside it, the menu of
 * tracks. Below the row's tight width the pair leaves for More.
 */
export function SubtitleControls() {
  const shown = usePlayer((state) => shownSubtitle(state.tracks) !== undefined);
  return (
    <div className="flex flex-none items-center gap-1 group-data-[tight]/stage:hidden">
      <ActionButton action="subtitles.toggle" pressed={shown}>
        <Captions />
      </ActionButton>
      <SubtitleMenu />
    </div>
  );
}
