import { audioActions } from "@/features/audio/actions";
import { castActions } from "@/features/cast/actions";
import { playerActions } from "@/features/player/actions";
import { playlistActions } from "@/features/playlist/actions";
import { shellActions } from "@/features/shell/actions";
import { subtitleActions } from "@/features/subtitles/actions";
import { videoActions } from "@/features/video/actions";
import type { Action } from "./registry";

/** Every action in the app, in the order menus and the palette list them within a category. */
export const appActions: readonly Action[] = [
  ...playlistActions,
  ...playerActions,
  ...castActions,
  ...audioActions,
  ...videoActions,
  ...subtitleActions,
  ...shellActions,
];
