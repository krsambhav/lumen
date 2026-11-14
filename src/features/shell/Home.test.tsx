import { clearMocks } from "@tauri-apps/api/mocks";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActions, registerActions } from "@/actions/registry";
import { useRecents } from "@/features/library/recents";
import { usePalette } from "@/features/palette/store";
import { openSources } from "@/features/playlist/actions";
import { useSaved } from "@/features/playlist/saved";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { Home } from "./Home";

vi.mock("@/features/playlist/actions", async (original) => ({
  ...(await original<typeof import("@/features/playlist/actions")>()),
  openSources: vi.fn(),
}));

function registerOpen(run = vi.fn()) {
  registerActions([
    { id: "file.open", name: "Open file…", category: "file", shortcuts: ["Cmd+o"], run },
  ]);
  return run;
}

const MISSING = {
  source: "/Users/me/Films/The Long Take (2019).mkv",
  reason: { kind: "missing" },
  reveal: "/Users/me/Films",
} as const;

afterEach(() => {
  useRecents.setState({ entries: [], loaded: false });
  useSaved.setState({ entries: [] });
  clearActions();
  clearMocks();
});

describe("Home", () => {
  it("says what to do, and what Lumen plays", () => {
    registerOpen();
    renderUi(<Home dropping={false} />);
    expect(screen.getByRole("heading", { name: "Drop a file to play" })).toBeInTheDocument();
    // The line under the headline adds something: it does not restate the button.
    expect(screen.getByText(/plays MKV, MP4, MOV/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open file…" })).toBeInTheDocument();
  });

  it("shows the shortcut the keyboard dispatcher listens for", () => {
    registerOpen();
    renderUi(<Home dropping={false} />);
    // Read aloud as words; drawn as keycaps.
    expect(screen.getByText("Command O")).toBeInTheDocument();
  });

  it("shows no keycap for an action that has no shortcut", () => {
    registerActions([
      { id: "file.open", name: "Open file…", category: "file", shortcuts: [], run: vi.fn() },
    ]);
    renderUi(<Home dropping={false} />);
    expect(screen.queryByText("Command O")).not.toBeInTheDocument();
  });

  it("opens the file panel from the button, as a control and not a key", async () => {
    const run = registerOpen();
    renderUi(<Home dropping={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Open file…" }));
    expect(run).toHaveBeenCalledExactlyOnceWith({ source: "control" });
  });

  it("lets only the headline speak while a file is held over the window", () => {
    registerOpen();
    renderUi(<Home dropping />);
    expect(screen.getByRole("heading", { name: "Release to play" })).toBeInTheDocument();
    expect(screen.queryByText("Drop a file to play")).not.toBeInTheDocument();
    // The rest keeps its place, so nothing jumps, but steps back.
    expect(screen.getByText(/plays MKV, MP4, MOV/).parentElement).toHaveClass("invisible");
  });

  it("draws the scale as decoration", () => {
    registerOpen();
    const { container } = renderUi(<Home dropping={false} />);
    const ruler = container.querySelector(".needle")?.parentElement;
    expect(ruler).toHaveAttribute("aria-hidden", "true");
  });
});

describe("a failure to open", () => {
  it("is said in place of the line under the headline, and announced", () => {
    registerOpen();
    renderUi(<Home dropping={false} failure={MISSING} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Lumen could not find “The Long Take (2019).mkv”: it may have been moved or renamed, or its disk is not connected.",
    );
    expect(screen.queryByText(/plays MKV, MP4, MOV/)).not.toBeInTheDocument();
    // The way forward is still there.
    expect(screen.getByRole("button", { name: "Open file…" })).toBeInTheDocument();
  });

  it("offers to show what is left of it in the Finder", async () => {
    registerOpen();
    const filesShowInFinder = vi.fn(() => null);
    mockCommands({ filesShowInFinder });
    renderUi(<Home dropping={false} failure={MISSING} />);
    await userEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(filesShowInFinder).toHaveBeenCalledWith({ path: "/Users/me/Films" });
  });

  it("does not offer the Finder when there is nothing to show", () => {
    registerOpen();
    renderUi(
      <Home
        dropping={false}
        failure={{
          source: "https://example.com/film.mkv",
          reason: { kind: "unreachable" },
          reveal: null,
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Lumen could not reach");
    expect(screen.queryByRole("button", { name: "Show in Finder" })).not.toBeInTheDocument();
  });
});

describe("Home, once something has been played", () => {
  const PLAYED = {
    source: "/films/Solaris (1972).mkv",
    title: "Solaris (1972).mkv",
    duration: 9960,
    position: 5200,
    finished: false,
    playedAt: 1,
    state: null,
    playlist: null,
    available: true,
    poster: null,
    resumesAt: 5197,
  };

  it("shows what was played under the lead, which keeps its headline and its ways to open", () => {
    registerOpen();
    useRecents.setState({ entries: [PLAYED], loaded: true });
    renderUi(<Home dropping={false} />);
    expect(screen.getByRole("heading", { name: "Drop a file to play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open file…" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recently played" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Solaris/ })).toBeInTheDocument();
  });

  it("no longer says what Lumen plays: someone who has played a film knows", () => {
    registerOpen();
    useRecents.setState({ entries: [PLAYED], loaded: true });
    renderUi(<Home dropping={false} />);
    expect(screen.queryByText(/Lumen plays MKV/)).not.toBeInTheDocument();
  });

  it("still says what went wrong, where the user is looking", () => {
    registerOpen();
    useRecents.setState({ entries: [PLAYED], loaded: true });
    renderUi(<Home dropping={false} failure={MISSING} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Lumen could not find");
  });

  it("scrolls when the window is too short for it, and starts at the top rather than the middle", () => {
    registerOpen();
    useRecents.setState({ entries: [PLAYED], loaded: true });
    renderUi(<Home dropping={false} />);
    expect(screen.getByRole("main")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("main")).not.toHaveClass("justify-center");
  });

  it("steps the tiles back with the rest while a file is held over the window", () => {
    registerOpen();
    useRecents.setState({ entries: [PLAYED], loaded: true });
    renderUi(<Home dropping />);
    expect(screen.getByRole("heading", { name: "Release to play" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recently played", hidden: true })).toHaveClass(
      "invisible",
    );
  });
});

describe("Home, with a playlist saved", () => {
  const EVENING = { id: 7, name: "Evening", count: 12, duration: 0, updatedAt: 1 };

  it("lists the saved playlists under what was played", () => {
    registerOpen();
    useRecents.setState({
      loaded: true,
      entries: [
        {
          source: "/films/Solaris (1972).mkv",
          title: "Solaris (1972)",
          duration: 9960,
          position: 0,
          finished: false,
          playedAt: 1,
          state: null,
          playlist: null,
          available: true,
          poster: null,
          resumesAt: null,
        },
      ],
    });
    useSaved.setState({ entries: [EVENING] });
    renderUi(<Home dropping={false} />);
    const sections = screen.getAllByRole("region").map((region) => region.textContent);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatch(/^Recently played/);
    expect(sections[1]).toMatch(/^Playlists/);
  });

  it("has the history layout for a playlist alone: there is something to come back to", () => {
    registerOpen();
    useSaved.setState({ entries: [EVENING] });
    renderUi(<Home dropping={false} />);
    expect(screen.getByRole("region", { name: "Playlists" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recently played" })).not.toBeInTheDocument();
    // The lead is at the top, and the line that says what Lumen plays has given its place.
    expect(screen.getByRole("main")).toHaveClass("overflow-y-auto");
    expect(screen.queryByText(/plays MKV, MP4, MOV/)).not.toBeInTheDocument();
  });

  it("plays a link typed into the find field, and searches for anything else", async () => {
    registerOpen();
    renderUi(<Home dropping={false} />);
    const field = screen.getByRole("searchbox", { name: "Search torrents, or play a link" });
    await userEvent.type(field, "https://vimeo.com/76979871{Enter}");
    expect(openSources).toHaveBeenCalledExactlyOnceWith(["https://vimeo.com/76979871"]);
    expect(usePalette.getState().open).toBe(false);

    await userEvent.type(field, "mobland{Enter}");
    expect(usePalette.getState()).toMatchObject({ open: true, mode: "torrents", seed: "mobland" });
    expect(openSources).toHaveBeenCalledOnce();
    usePalette.setState({ open: false, seed: "" });
  });

  it("names the button by its action alone, with its shortcut as a key shortcut", () => {
    registerOpen();
    renderUi(<Home dropping={false} />);
    const button = screen.getByRole("button", { name: "Open file…" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+O");
    // The keys are drawn inside it, not as a box beside it.
    expect(button.querySelector("kbd")).not.toBeNull();
  });
});
