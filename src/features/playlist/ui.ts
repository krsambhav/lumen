import { create } from "zustand";
import type { SavedPlaylist } from "@/ipc";

interface PlaylistUiState {
  /** The row that is selected in the playlist, by item id. */
  selected: number | null;
  /** The form for saving the playlist under a name is open. */
  saving: boolean;
  /** The saved playlist being given another name, if one is. */
  renaming: SavedPlaylist | null;
  /** Where files held over the panel would be added, as a place in the list. */
  dropIndex: number | null;
  select: (id: number | null) => void;
  setSaving: (saving: boolean) => void;
  setRenaming: (playlist: SavedPlaylist | null) => void;
  setDropIndex: (index: number | null) => void;
}

/** State of the playlist panel that lasts only as long as the window. */
export const usePlaylistUi = create<PlaylistUiState>((set) => ({
  selected: null,
  saving: false,
  renaming: null,
  dropIndex: null,
  select: (selected) => set({ selected }),
  setSaving: (saving) => set({ saving, renaming: null }),
  setRenaming: (renaming) => set({ renaming, saving: false }),
  setDropIndex: (dropIndex) => set({ dropIndex }),
}));
