import { clearMocks } from "@tauri-apps/api/mocks";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActions } from "@/actions/all";
import { clearActions, registerActions } from "@/actions/registry";
import { Toaster } from "@/components/ui/toaster";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import type { QueueSnapshot } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { PlaylistPanel } from "./PlaylistPanel";
import { useSaved } from "./saved";
import { EMPTY_QUEUE, useQueue } from "./store";
import { usePlaylistUi } from "./ui";

const QUEUE: QueueSnapshot = {
  ...EMPTY_QUEUE,
  items: [
    { id: 1, source: "/s/Episode 1.mkv", title: "Episode 1", duration: 1500, failed: null },
    { id: 2, source: "/s/Episode 2.mkv", title: "Episode 2", duration: 1620, failed: null },
    { id: 3, source: "/s/Episode 3.mkv", title: "Episode 3", duration: 1380, failed: null },
  ],
  current: 2,
  hasNext: true,
  hasPrevious: true,
};

const calls = {
  play: vi.fn((_: { id: number }) => null),
  remove: vi.fn((_: { id: number }) => null),
  move: vi.fn((_: { id: number; index: number }) => null),
  add: vi.fn((_: { sources: string[]; index: number | null }) => 1),
  shuffle: vi.fn((_: { shuffle: boolean }) => null),
  repeat: vi.fn((_: { repeat: string }) => null),
  clear: vi.fn(() => null),
};

beforeEach(() => {
  registerActions(appActions);
  usePlayer.setState({ ...IDLE_SNAPSHOT, source: "/s/Episode 2.mkv", status: "paused" });
  useQueue.setState(QUEUE, true);
  usePlaylistUi.setState({ selected: null, saving: false, renaming: null, dropIndex: null });
  useSaved.setState({ entries: [] });
  for (const call of Object.values(calls)) {
    call.mockClear();
  }
  mockCommands({
    playlistPlay: calls.play,
    playlistRemove: calls.remove,
    playlistMove: calls.move,
    playlistAdd: calls.add,
    playlistSetShuffle: calls.shuffle,
    playlistSetRepeat: calls.repeat,
    playlistClear: calls.clear,
    playlistsList: () => [],
  });
});

afterEach(() => {
  toast.dismiss();
  clearActions();
  clearMocks();
});

function show() {
  return renderUi(
    <>
      <PlaylistPanel />
      <Toaster />
    </>,
  );
}

function row(title: string): HTMLElement {
  return screen.getByRole("option", { name: new RegExp(title) });
}

describe("the header", () => {
  it('is headed "Playlist" when it has no name, as every tab is headed by its name', () => {
    show();
    expect(screen.getByRole("heading", { name: "Playlist" })).toBeInTheDocument();
    expect(screen.getByText("3 items · 1 h 15 min")).toHaveClass("text-caption");
  });

  it("tells one show's episodes apart by their numbers and their own names", () => {
    const release = (code: string, name: string) =>
      `The Americans (2013) - ${code} - ${name} (1080p AMZN WEB-DL x265 Silence)`;
    useQueue.setState(
      {
        ...QUEUE,
        items: [
          {
            id: 1,
            source: "https://x/dl/1",
            title: release("S02E05", "Martial Eagle"),
            duration: 2700,
            failed: null,
          },
          {
            id: 2,
            source: "https://x/dl/2",
            title: release("S02E06", "Behind the Red Door"),
            duration: 2700,
            failed: null,
          },
          {
            id: 3,
            source: "https://x/dl/3",
            title: "The.Americans.2013.S02E10.1080p.WEB.H264",
            duration: 2700,
            failed: null,
          },
        ],
      },
      true,
    );
    renderUi(<PlaylistPanel />);
    // Headed by the show, which the rows then leave out.
    expect(screen.getByRole("heading", { name: "The Americans (2013)" })).toBeInTheDocument();
    const rows = screen.getAllByRole("option");
    expect(rows[1]).toHaveTextContent(/S2 E6\s*Behind the Red Door/);
    // What the eye gets leaves the release's quality out; a screen reader still hears the whole name.
    expect(rows[1]?.querySelector('[aria-hidden="true"]')).not.toHaveTextContent(/1080p/);
    // A release with nothing after its number is named by it.
    expect(rows[2]).toHaveTextContent(/S2 E10\s*Episode 10/);
  });

  it("keeps whole names for a list that is not one show's episodes", () => {
    renderUi(<PlaylistPanel />);
    expect(screen.getByRole("heading", { name: "Playlist" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Episode 1");
  });

  it("is headed by the saved playlist's name when it has one, with the count beneath", () => {
    useQueue.setState({ name: "Evening" });
    show();
    expect(screen.getByRole("heading", { name: "Evening" })).toBeInTheDocument();
    expect(screen.getByText("3 items · 1 h 15 min")).toHaveClass("text-caption", "text-ink-2");
  });

  it("gives no total until every length is known", () => {
    useQueue.setState({
      items: QUEUE.items.map((item) => (item.id === 3 ? { ...item, duration: null } : item)),
    });
    show();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("says one item in the singular", () => {
    useQueue.setState({ items: QUEUE.items.slice(1, 2) });
    show();
    expect(screen.getByText("1 item · 27 min")).toBeInTheDocument();
  });

  it("switches shuffle with a button that shows whether it is on", async () => {
    show();
    const shuffle = screen.getByRole("button", { name: "Shuffle" });
    expect(shuffle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(shuffle);
    expect(calls.shuffle).toHaveBeenCalledWith({ shuffle: true });
    act(() => useQueue.setState({ shuffle: true }));
    expect(screen.getByRole("button", { name: "Shuffle" })).toHaveAttribute("aria-pressed", "true");
  });

  it("steps repeat through off, all and one, under one name, saying which beside it", async () => {
    show();
    // Named for what it is, not for the state it is in: "Repeat off" would read as a command.
    const repeat = screen.getByRole("button", { name: "Repeat" });
    expect(repeat).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(repeat);
    expect(calls.repeat).toHaveBeenLastCalledWith({ repeat: "all" });
    act(() => useQueue.setState({ repeat: "all" }));
    await userEvent.click(repeat);
    expect(calls.repeat).toHaveBeenLastCalledWith({ repeat: "one" });
    act(() => useQueue.setState({ repeat: "one" }));
    expect(screen.getByRole("button", { name: "Repeat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says which state repeat is in as the second line of its tooltip", async () => {
    useQueue.setState({ repeat: "one" });
    show();
    await userEvent.hover(screen.getByRole("button", { name: "Repeat" }));
    const tooltip = await screen.findByRole("tooltip", undefined, { timeout: 2000 });
    // What assistive technology hears of the tooltip is what it adds to the name: the state and the key.
    expect(tooltip).toHaveTextContent(/One/);
  });
});

describe("the rows", () => {
  it("list each item with its place and length, and mark the one playing", () => {
    show();
    const options = screen.getAllByRole("option");
    // Named by what they show, in words where the eye gets figures; no label of their own to drift from it.
    expect(options[0]).toHaveAccessibleName("1, Episode 1, 25 minutes");
    expect(options[1]).toHaveAccessibleName("2, Episode 2, 27 minutes, playing");
    expect(options[2]).toHaveAccessibleName("3, Episode 3, 23 minutes");
    expect(options[0]).not.toHaveAttribute("aria-label");
    expect(options[1]).toHaveAttribute("aria-current", "true");
    // A timecode is drawn in parts (its colon is raised), so it is read as text.
    expect(options[0]).toHaveTextContent("25:00");
    // The one playing shows the lamp where the others show their number.
    expect(within(options[1] as HTMLElement).queryByText("2")).not.toBeInTheDocument();
    expect(options[1]?.querySelector(".needle")).not.toBeNull();
    expect(within(options[2] as HTMLElement).getByText("3")).toBeInTheDocument();
  });

  it("play on a double-click, and only select on one", async () => {
    show();
    await userEvent.click(row("Episode 3"));
    expect(calls.play).not.toHaveBeenCalled();
    expect(row("Episode 3")).toHaveAttribute("aria-selected", "true");
    await userEvent.dblClick(row("Episode 3"));
    expect(calls.play).toHaveBeenCalledWith({ id: 3 });
  });

  it("play on Return", async () => {
    show();
    await userEvent.click(row("Episode 1"));
    await userEvent.keyboard("{Enter}");
    expect(calls.play).toHaveBeenCalledWith({ id: 1 });
  });

  it("are removed with Delete, and Undo puts the item back where it was", async () => {
    show();
    await userEvent.click(row("Episode 1"));
    await userEvent.keyboard("{Delete}");
    expect(calls.remove).toHaveBeenCalledWith({ id: 1 });
    const undo = await screen.findByRole("button", { name: "Undo" });
    // What happened in a few words, and the name on a line of its own.
    expect(screen.getByText("Removed from the playlist")).toBeInTheDocument();
    expect(screen.getByText("Episode 1", { selector: "[data-description]" })).toHaveClass(
      "truncate",
    );
    await userEvent.click(undo);
    expect(calls.add).toHaveBeenCalledWith({ sources: ["/s/Episode 1.mkv"], index: 0 });
  });

  it("have something to click that removes them, which is not a control inside the option", async () => {
    show();
    // An option may hold no control of its own: this is for the pointer, and Delete is for the keyboard.
    const remove = row("Episode 3").querySelector<HTMLElement>("[data-remove]");
    expect(remove?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(row("Episode 3").querySelector("button")).toBeNull();
    await userEvent.click(remove as HTMLElement);
    expect(calls.remove).toHaveBeenCalledWith({ id: 3 });
    // Removing is not playing.
    expect(calls.play).not.toHaveBeenCalled();
  });

  it("move with Option and an arrow", async () => {
    show();
    await userEvent.click(row("Episode 1"));
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(calls.move).toHaveBeenCalledWith({ id: 1, index: 1 });
  });

  it("offer play, the Finder and removal on a secondary click", async () => {
    const shown = vi.fn((_: { path: string }) => null);
    mockCommands({ filesShowInFinder: shown, playlistRemove: calls.remove });
    show();
    fireEvent.contextMenu(row("Episode 1"));
    expect(screen.getByRole("menuitem", { name: "Play" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Show in Finder" }));
    expect(shown).toHaveBeenCalledWith({ path: "/s/Episode 1.mkv" });

    fireEvent.contextMenu(row("Episode 2"));
    // The one playing can only be started over.
    expect(screen.getByRole("menuitem", { name: "Play from the beginning" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from playlist" }));
    expect(calls.remove).toHaveBeenCalledWith({ id: 2 });
  });

  it("do not offer the Finder for an address", () => {
    useQueue.setState({
      items: [
        ...QUEUE.items,
        {
          id: 9,
          source: "https://example.com/live",
          title: "https://example.com/live",
          duration: null,
          failed: null,
        },
      ],
    });
    show();
    fireEvent.contextMenu(row("example.com"));
    expect(screen.queryByRole("menuitem", { name: "Show in Finder" })).not.toBeInTheDocument();
  });

  it("show where dropped files would be added", () => {
    show();
    expect(document.querySelector("[data-insertion]")).toBeNull();
    act(() => usePlaylistUi.getState().setDropIndex(2));
    const line = document.querySelector<HTMLElement>("[data-insertion]");
    // Between the second row and the third: 2 × 28 px down, centred on the join.
    expect(line?.style.transform).toBe("translateY(55px)");
  });
});

describe("the playlist's menu", () => {
  it("adds files, opens the form to save, and clears", async () => {
    const added = vi.fn(() => 0);
    mockCommands({ playlistAddDialog: added, playlistClear: calls.clear, playlistsList: () => [] });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Add files…/ }));
    expect(added).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Clear/ }));
    expect(calls.clear).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Save as…/ }));
    expect(usePlaylistUi.getState().saving).toBe(true);
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("cannot clear a playlist of one, and has no saved playlists to open when there are none", async () => {
    useQueue.setState({ items: QUEUE.items.slice(1, 2) });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    expect(screen.getByRole("menuitem", { name: /Clear/ })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Open playlist" })).toHaveAttribute(
      "data-disabled",
    );
    // Nothing here is a saved playlist, so there is none to rename or delete.
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent?.replace(/[⌘⇧⌥⌃].*$/u, "")),
    ).toEqual(["Add files…", "Save as…", "Open playlist", "Clear"]);
  });

  it("opens a saved playlist from one submenu: choosing its name opens it", async () => {
    const opened = vi.fn((_: { id: number }) => null);
    mockCommands({ playlistsOpen: opened });
    useSaved.setState({
      entries: [{ id: 7, name: "Evening", count: 12, duration: 0, updatedAt: 1 }],
    });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open playlist" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Evening/ }));
    expect(opened).toHaveBeenCalledWith({ id: 7 });
  });

  it("renames and deletes the saved playlist that is open, and only that one", async () => {
    const removed = vi.fn((_: { id: number }) => true);
    mockCommands({ playlistsDelete: removed });
    useSaved.setState({
      entries: [
        { id: 7, name: "Evening", count: 3, duration: 4500, updatedAt: 1 },
        { id: 8, name: "Morning", count: 2, duration: 0, updatedAt: 2 },
      ],
    });
    useQueue.setState({ name: "Evening" });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    expect(usePlaylistUi.getState().renaming).toMatchObject({ id: 7, name: "Evening" });

    act(() => usePlaylistUi.getState().setRenaming(null));
    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete “Evening”" }));
    expect(removed).toHaveBeenCalledWith({ id: 7 });
    expect(await screen.findByText("Deleted the playlist")).toBeInTheDocument();
  });
});
