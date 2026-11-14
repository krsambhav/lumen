import { clearMocks } from "@tauri-apps/api/mocks";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopoverAnchor } from "@/components/ui/popover";
import type { AppError, SavedPlaylist } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { SaveForm } from "./SaveForm";
import { useSaved } from "./saved";
import { EMPTY_QUEUE, useQueue } from "./store";
import { usePlaylistUi } from "./ui";

const EVENING: SavedPlaylist = { id: 7, name: "Evening", count: 12, duration: 0, updatedAt: 1 };
const MORNING: SavedPlaylist = { id: 8, name: "Morning", count: 3, duration: 0, updatedAt: 1 };

const save = vi.fn(
  (args: { name: string; replace: boolean }): SavedPlaylist => ({
    ...EVENING,
    id: 9,
    name: args.name,
  }),
);
const rename = vi.fn(
  (args: { id: number; name: string }): SavedPlaylist => ({
    ...EVENING,
    name: args.name,
  }),
);

beforeEach(() => {
  save.mockClear();
  rename.mockClear();
  useQueue.setState(EMPTY_QUEUE, true);
  // What is saved is known before the form is opened: the app keeps it current.
  useSaved.setState({ entries: [EVENING, MORNING] });
  mockCommands({ playlistsSave: save, playlistsRename: rename });
});

afterEach(() => {
  usePlaylistUi.setState({ saving: false, renaming: null });
  useSaved.setState({ entries: [] });
  clearMocks();
});

/** The form as the panel shows it, following the same state. */
function Host() {
  const saving = usePlaylistUi((state) => state.saving);
  const renaming = usePlaylistUi((state) => state.renaming);
  return (
    <SaveForm open={saving || renaming !== null} renaming={renaming}>
      <PopoverAnchor>
        <span>anchor</span>
      </PopoverAnchor>
    </SaveForm>
  );
}

async function openToSave() {
  usePlaylistUi.setState({ saving: true });
  renderUi(<Host />);
  return screen.findByRole("textbox", { name: "Name" });
}

describe("saving the playlist under a name", () => {
  it("saves what is typed and closes", async () => {
    const name = await openToSave();
    expect(screen.getByRole("dialog", { name: "Save playlist" })).toBeInTheDocument();
    // Nothing to save under yet.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(name, "  Road trip ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ name: "Road trip", replace: false });
    expect(usePlaylistUi.getState().saving).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves on Return", async () => {
    const name = await openToSave();
    await userEvent.type(name, "Road trip{Enter}");
    expect(save).toHaveBeenCalledWith({ name: "Road trip", replace: false });
  });

  it("starts from the name the playlist already has, selected for typing over", async () => {
    useQueue.setState({ name: "Morning" });
    const name = (await openToSave()) as HTMLInputElement;
    expect(name).toHaveValue("Morning");
    expect(name.selectionEnd).toBe("Morning".length);
    expect(name.selectionStart).toBe(0);
  });

  it("says when the name is taken, and saving then replaces", async () => {
    const name = await openToSave();
    await userEvent.type(name, "evening");
    // Case does not make it another playlist.
    expect(await screen.findByText("Replaces the saved “Evening”.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(save).toHaveBeenCalledWith({ name: "evening", replace: true });
  });

  it("says what the backend refused, and stays open", async () => {
    useSaved.setState({ entries: [] });
    mockCommands({
      playlistsSave: () => {
        throw { kind: "invalid", message: "there is nothing in the playlist to save" } as AppError;
      },
    });
    const name = await openToSave();
    await userEvent.type(name, "Empty{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There is nothing in the playlist to save.",
    );
    expect(usePlaylistUi.getState().saving).toBe(true);
    // Typing again takes the complaint away.
    await userEvent.type(name, "!");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reads what is saved again when a name turns out to be taken", async () => {
    // The list here says the name is free; the backend knows better.
    useSaved.setState({ entries: [MORNING] });
    mockCommands({
      playlistsList: () => [EVENING, MORNING],
      playlistsSave: () => {
        throw {
          kind: "exists",
          message: "there is already a playlist called “Evening”",
        } as AppError;
      },
    });
    const name = await openToSave();
    await userEvent.type(name, "Evening{Enter}");
    // Not a complaint: the name now shows as taken, and saving would replace.
    expect(await screen.findByText("Replaces the saved “Evening”.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
    expect(usePlaylistUi.getState().saving).toBe(true);
  });

  it("is left by Cancel without saving", async () => {
    const name = await openToSave();
    await userEvent.type(name, "Road trip");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    expect(usePlaylistUi.getState().saving).toBe(false);
  });
});

describe("giving a saved playlist another name", () => {
  async function openToRename() {
    usePlaylistUi.setState({ renaming: EVENING });
    renderUi(<Host />);
    return screen.findByRole("textbox", { name: "Name" });
  }

  it("renames and closes", async () => {
    const name = await openToRename();
    expect(screen.getByRole("dialog", { name: "Rename playlist" })).toBeInTheDocument();
    expect(name).toHaveValue("Evening");
    // The name it already has is not a change.
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, "Night");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(rename).toHaveBeenCalledWith({ id: 7, name: "Night" });
    expect(usePlaylistUi.getState().renaming).toBeNull();
  });

  it("cannot take another playlist's name", async () => {
    const name = await openToRename();
    await userEvent.clear(name);
    await userEvent.type(name, "MORNING");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another playlist is called “Morning”.",
    );
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    expect(rename).not.toHaveBeenCalled();
  });
});
