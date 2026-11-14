import { clearMocks } from "@tauri-apps/api/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActions, registerActions } from "@/actions/registry";
import { Toaster } from "@/components/ui/toaster";
import type { Recent } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { RecentlyPlayed } from "./RecentlyPlayed";
import { connectPosters, useRecents } from "./recents";

function entry(title: string, extra: Partial<Recent> = {}): Recent {
  return {
    source: `/films/${title}`,
    title,
    duration: 7305,
    position: 0,
    finished: false,
    playedAt: 1,
    state: null,
    available: true,
    poster: null,
    resumesAt: null,
    ...extra,
  };
}

const LEFT_PART_WAY = entry("The Long Take (2019).mkv", {
  position: 2537,
  resumesAt: 2534,
  poster: "asset://localhost/poster.jpg",
});
const FINISHED = entry("Stalker (1979).mkv", { finished: true });
const A_CLIP = entry("Clip.mp4", { duration: 20, position: 4 });
const GONE = entry("Moved.mkv", { available: false });
const STREAM = entry("A lecture", { source: "https://example.com/a", duration: null });

const open = vi.fn((_: { sources: string[]; resume: boolean }) => null);
const forget = vi.fn((_: { source: string }) => true);
const restore = vi.fn((_: { entry: unknown }) => null);

beforeEach(() => {
  open.mockClear();
  forget.mockClear();
  restore.mockClear();
  mockCommands({
    playlistOpen: open,
    historyForget: forget,
    historyRestore: restore,
    historyRecent: () => useRecents.getState().entries,
  });
  useRecents.setState({
    entries: [LEFT_PART_WAY, FINISHED, A_CLIP, GONE, STREAM],
    loaded: true,
  });
});

afterEach(() => {
  toast.dismiss();
  useRecents.setState({ entries: [], loaded: false });
  clearMocks();
});

function show() {
  return renderUi(
    <>
      <RecentlyPlayed />
      <Toaster />
    </>,
  );
}

function tile(title: string) {
  return screen.getByRole("button", { name: new RegExp(title.replace(/[()]/g, "\\$&")) });
}

describe("recently played", () => {
  it("is a labelled section of tiles, newest first", () => {
    show();
    expect(screen.getByRole("region", { name: "Recently played" })).toBeInTheDocument();
    // Each tile is named by its title, said once, and says what is left of it.
    const titles = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label") !== "Clear recently played")
      .map((button) => button.querySelector(".sr-only")?.textContent);
    expect(titles).toEqual([
      "The Long Take (2019).mkv",
      "Stalker (1979).mkv",
      "Clip.mp4",
      "Moved.mkv",
      "A lecture",
    ]);
    expect(tile("The Long Take")).toHaveTextContent("1 h 19 min left");
    expect(tile("Stalker")).toHaveTextContent("2 h 2 min");
    // Too short to resume: its length, not what is left.
    expect(tile("Clip")).toHaveTextContent("20 s");
    expect(tile("Moved")).toHaveTextContent("Not found");
  });

  it("is nothing at all when nothing has been played", () => {
    useRecents.setState({ entries: [] });
    show();
    expect(screen.queryByRole("region", { name: "Recently played" })).not.toBeInTheDocument();
  });

  it("shows the frame from the film where there is one, and the mark where there is not", () => {
    show();
    const poster = tile("The Long Take").querySelector("img");
    expect(poster).toHaveAttribute("src", "asset://localhost/poster.jpg");
    // Decoration: the title beside it is what names the tile.
    expect(poster).toHaveAttribute("alt", "");
    expect(tile("Stalker").querySelector("img")).toBeNull();
    expect(tile("Stalker").querySelector("svg")).not.toBeNull();
  });

  it("draws how far through it was left only for what will resume", () => {
    show();
    const scale = tile("The Long Take").querySelector<HTMLElement>("[data-progress]");
    expect(scale).not.toBeNull();
    const played = scale?.firstElementChild as HTMLElement;
    expect(Number.parseFloat(played.style.width)).toBeCloseTo((2537 / 7305) * 100, 3);
    // Finished, and a clip too short to resume: no promise of a place.
    expect(tile("Stalker").querySelector("[data-progress]")).toBeNull();
    expect(tile("Clip").querySelector("[data-progress]")).toBeNull();
  });

  it("dims a file that is no longer where it was", () => {
    show();
    expect(tile("Moved").querySelector(".stage")).toHaveClass("opacity-45");
    expect(tile("Stalker").querySelector(".stage")).not.toHaveClass("opacity-45");
  });

  it("plays on a click, from where it was left", async () => {
    show();
    await userEvent.click(tile("The Long Take"));
    expect(open).toHaveBeenCalledWith({
      sources: ["/films/The Long Take (2019).mkv"],
      resume: true,
    });
  });

  it("offers to start over, on a secondary click, only where there is a place to resume", async () => {
    show();
    fireEvent.contextMenu(tile("The Long Take"));
    expect(screen.getByRole("menuitem", { name: "Resume" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Play from the beginning" }));
    expect(open).toHaveBeenCalledWith({
      sources: ["/films/The Long Take (2019).mkv"],
      resume: false,
    });

    fireEvent.contextMenu(tile("Stalker"));
    expect(screen.getByRole("menuitem", { name: "Play" })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Play from the beginning" }),
    ).not.toBeInTheDocument();
  });

  it("offers the Finder for a file that is there, and not for an address or a file that is gone", async () => {
    const shown = vi.fn((_: { path: string }) => null);
    mockCommands({ filesShowInFinder: shown });
    show();
    fireEvent.contextMenu(tile("Stalker"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Show in Finder" }));
    expect(shown).toHaveBeenCalledWith({ path: "/films/Stalker (1979).mkv" });

    for (const title of ["Moved", "A lecture"]) {
      fireEvent.contextMenu(tile(title));
      expect(screen.queryByRole("menuitem", { name: "Show in Finder" })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
    }
  });

  it("is removed with Delete, at once, and Undo puts it back as it was", async () => {
    show();
    tile("The Long Take").focus();
    await userEvent.keyboard("{Delete}");
    expect(screen.queryByRole("button", { name: /The Long Take/ })).not.toBeInTheDocument();
    expect(forget).toHaveBeenCalledWith({ source: "/films/The Long Take (2019).mkv" });
    // The keyboard has gone to the tile beside it, so Delete can be pressed again.
    expect(document.activeElement).toHaveAttribute("type", "button");
    expect(document.activeElement).not.toBe(document.body);
    // The toast says what happened in a few words, and names it on a line of its own.
    expect(await screen.findByText("Removed from recently played")).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    // Only what the history holds goes back: not what was worked out for showing it.
    expect(restore).toHaveBeenCalledWith({
      entry: {
        source: "/films/The Long Take (2019).mkv",
        title: "The Long Take (2019).mkv",
        duration: 7305,
        position: 2537,
        finished: false,
        playedAt: 1,
        state: null,
      },
    });
  });

  it("offers only to remove a file that has gone: there is nothing of it to play or to show", () => {
    show();
    fireEvent.contextMenu(tile("Moved"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Remove from recently played",
    ]);
  });

  it("says so when it does not know how long something is", () => {
    show();
    expect(tile("A lecture")).toHaveTextContent("Length unknown");
  });

  it("carries its focus ring on the thumbnail, clear of the caption", () => {
    show();
    const first = tile("The Long Take");
    expect(first).toHaveClass("ring-on-part");
    expect(first.querySelector("[data-ring]")).toHaveClass("aspect-video");
    expect(first.querySelectorAll("[data-ring]")).toHaveLength(1);
  });

  it("draws how far it was left along the straight part of the thumbnail's edge", () => {
    show();
    // Inset by the corner's radius, so the needle is whole at 1% and at 99%.
    expect(tile("The Long Take").querySelector("[data-progress]")).toHaveClass("inset-x-2.5");
  });

  it("takes the keyboard to the way to open something when the last tile is removed", async () => {
    useRecents.setState({ entries: [LEFT_PART_WAY] });
    renderUi(
      <main>
        <button type="button">Open file…</button>
        <RecentlyPlayed />
        <Toaster />
      </main>,
    );
    tile("The Long Take").focus();
    await userEvent.keyboard("{Delete}");
    expect(screen.getByRole("button", { name: "Open file…" })).toHaveFocus();
  });

  it("offers to clear what was played", async () => {
    const run = vi.fn();
    registerActions([
      { id: "history.clear", name: "Clear recently played", category: "file", shortcuts: [], run },
    ]);
    show();
    await userEvent.click(screen.getByRole("button", { name: "Clear recently played" }));
    expect(run).toHaveBeenCalled();
    clearActions();
  });

  it("shows two rows at most", () => {
    useRecents.setState({
      entries: Array.from({ length: 24 }, (_, index) => entry(`Film ${index}.mkv`)),
    });
    show();
    // Unmeasured, the grid is five across; the eleventh button is Clear.
    expect(screen.getAllByRole("button")).toHaveLength(11);
  });
});

describe("posters", () => {
  it("are put on their tiles as they are made", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    const connection = connectPosters();
    await connection.ready;
    show();
    expect(tile("Stalker").querySelector("img")).toBeNull();
    await emit("poster-ready", {
      source: "/films/Stalker (1979).mkv",
      url: "asset://localhost/stalker.jpg",
    });
    await waitFor(() =>
      expect(tile("Stalker").querySelector("img")).toHaveAttribute(
        "src",
        "asset://localhost/stalker.jpg",
      ),
    );
    connection.stop();
  });
});
