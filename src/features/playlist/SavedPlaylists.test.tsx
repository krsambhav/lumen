import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toaster";
import type { SavedPlaylist, Subscription } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { clearUndo } from "@/lib/undo";
import { renderUi } from "@/test/render";
import { SavedPlaylists } from "./SavedPlaylists";
import { connectSaved, useSaved } from "./saved";

const EVENING: SavedPlaylist = {
  id: 7,
  name: "Evening",
  count: 12,
  duration: 33_600,
  updatedAt: 2,
};
const ONE: SavedPlaylist = { id: 8, name: "A single", count: 1, duration: 0, updatedAt: 1 };

const opened = vi.fn((_: { id: number }) => null);
const deleted = vi.fn((_: { id: number }) => true);
const undeleted = vi.fn((_: { id: number }) => EVENING);

/** What the backend does after any change: it says what is saved now. */
async function backendSays(saved: SavedPlaylist[]) {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("playlists-changed", saved);
}

let connection: Subscription;

beforeEach(async () => {
  opened.mockClear();
  deleted.mockClear();
  undeleted.mockClear();
  mockCommands({
    playlistsOpen: opened,
    playlistsDelete: (args) => {
      void backendSays([EVENING, ONE].filter((playlist) => playlist.id !== args.id));
      return deleted(args);
    },
    playlistsUndelete: (args) => {
      void backendSays([EVENING, ONE]);
      return undeleted(args);
    },
  });
  useSaved.setState({ entries: [EVENING, ONE] });
  connection = connectSaved();
  await connection.ready;
});

afterEach(async () => {
  connection.stop();
  // Stopping lets go of the listener once it is known; the mocks must still
  // be there when that happens.
  await new Promise((resolve) => setTimeout(resolve, 0));
  toast.dismiss();
  clearUndo();
  useSaved.setState({ entries: [] });
  clearMocks();
});

function show() {
  return renderUi(
    <>
      <SavedPlaylists />
      <Toaster />
    </>,
  );
}

describe("saved playlists on the home screen", () => {
  it("is nothing at all when none has been saved", () => {
    useSaved.setState({ entries: [] });
    const { container } = renderUi(<SavedPlaylists />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a labelled section of names, each with how much is in it", () => {
    show();
    expect(screen.getByRole("region", { name: "Playlists" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Evening/ })).toHaveTextContent(
      "12 items · 9 h 20 min",
    );
    // No length is given where none is known.
    expect(screen.getByRole("button", { name: /A single/ })).toHaveTextContent(/1 item$/);
  });

  it("opens one on a click", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /Evening/ }));
    expect(opened).toHaveBeenCalledWith({ id: 7 });
  });

  it("offers to open or delete on a secondary click, and Undo brings it back", async () => {
    show();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Evening/ }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open",
      "Delete playlist",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete playlist" }));
    expect(deleted).toHaveBeenCalledWith({ id: 7 });
    // What happened, and its name on a line of its own.
    expect(await screen.findByText("Deleted the playlist")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Evening/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undeleted).toHaveBeenCalledWith({ id: 7 });
    expect(await screen.findByRole("button", { name: /Evening/ })).toBeInTheDocument();
  });

  it("is deleted with Delete, and the keyboard goes to its neighbour", async () => {
    show();
    screen.getByRole("button", { name: /Evening/ }).focus();
    await userEvent.keyboard("{Delete}");
    expect(deleted).toHaveBeenCalledWith({ id: 7 });
    expect(screen.getByRole("button", { name: /A single/ })).toHaveFocus();
  });

  it("lists twelve at most: the rest are in the menus and the palette", () => {
    useSaved.setState({
      entries: Array.from({ length: 20 }, (_, index) => ({
        ...ONE,
        id: 100 + index,
        name: `Playlist ${index}`,
      })),
    });
    renderUi(<SavedPlaylists />);
    expect(screen.getAllByRole("button")).toHaveLength(12);
  });
});
