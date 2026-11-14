import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION } from "@/app/boot";
import { Toaster } from "@/components/ui/toaster";
import { useInterface } from "@/features/shell/interface";
import type { QueueSnapshot, Subscription } from "@/ipc";
import { TWO_LINES_MS } from "@/lib/notify";
import { renderUi } from "@/test/render";
import { connectPlaylistNotices } from "./notices";
import { EMPTY_QUEUE, useQueue } from "./store";

function queue(...ids: number[]): QueueSnapshot {
  return {
    ...EMPTY_QUEUE,
    items: ids.map((id) => ({
      id,
      source: `/s/${id}.mkv`,
      title: `${id}.mkv`,
      duration: 100,
      failed: null,
    })),
    current: ids[0] ?? null,
  };
}

let connection: Subscription;

beforeEach(async () => {
  mockIPC(() => undefined, { shouldMockEvents: true });
  useQueue.setState(EMPTY_QUEUE, true);
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
  renderUi(<Toaster />);
  connection = connectPlaylistNotices();
  await connection.ready;
});

afterEach(async () => {
  connection.stop();
  toast.dismiss();
  // Stopping is not instant: the listener is let go a moment later, and it
  // needs the mocked backend to still be there when that happens.
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("several things opened at once", () => {
  it("are announced as a playlist, with a way to see it", async () => {
    act(() => useQueue.setState(queue(1, 2, 3), true));
    expect(await screen.findByText("3 items in the playlist")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show playlist" }));
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, inspectorTab: "playlist" });
  });

  it("are not announced when the playlist is already on show", () => {
    useInterface.setState({ panelOpen: true });
    act(() => useQueue.setState(queue(1, 2, 3), true));
    expect(screen.queryByText("3 items in the playlist")).not.toBeInTheDocument();
  });

  it("are not announced again when the playlist only grows, shrinks or moves on", async () => {
    act(() => useQueue.setState(queue(1, 2), true));
    await screen.findByText("2 items in the playlist");
    act(() => toast.dismiss());
    await waitFor(() => expect(screen.queryByText(/in the playlist/)).not.toBeInTheDocument());

    act(() => useQueue.setState(queue(1, 2, 3), true));
    act(() => useQueue.setState({ ...queue(1, 2, 3), current: 2 }, true));
    act(() => useQueue.setState(queue(2, 3), true));
    expect(screen.queryByText(/in the playlist/)).not.toBeInTheDocument();
  });

  it("are not announced for one thing", () => {
    act(() => useQueue.setState(queue(1), true));
    expect(screen.queryByText(/in the playlist/)).not.toBeInTheDocument();
  });

  it("stop being offered once the playlist is opened some other way", async () => {
    act(() => useQueue.setState(queue(1, 2, 3), true));
    await screen.findByText("3 items in the playlist");
    act(() => useInterface.getState().showPanel("playlist"));
    await waitFor(() =>
      expect(screen.queryByText("3 items in the playlist")).not.toBeInTheDocument(),
    );
  });
});

describe("an item that would not play", () => {
  it("is said in one line with the reason, and named once, on a line of its own", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("playback-skipped", {
      source: "/s/Episode 2.mkv",
      title: "Episode 2",
      reason: { kind: "missing" },
    });
    expect(await screen.findByText("Skipped a file that is no longer there")).toBeInTheDocument();
    // The name is there once, cut to one line if it is long.
    const names = screen.getAllByText("Episode 2");
    expect(names).toHaveLength(1);
    expect(names[0]).toHaveClass("truncate");
  });

  it("leaves on its own: the film has gone on past it", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("playback-skipped", {
      source: "/s/Episode 2.mkv",
      title: "Episode 2",
      reason: { kind: "unreachable" },
    });
    await screen.findByText("Skipped an address that could not be reached");
    const notice = toast.getToasts().at(-1);
    expect(notice && "duration" in notice ? notice.duration : null).toBe(TWO_LINES_MS);
  });

  it("is counted with the others when several are stepped over in a row", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    for (const episode of [2, 3, 4]) {
      await emit("playback-skipped", {
        source: `/s/Episode ${episode}.mkv`,
        title: `Episode ${episode}`,
        reason: { kind: "notMedia" },
      });
    }
    expect(await screen.findByText("Skipped 3 items that would not play")).toBeInTheDocument();
    // One notice, naming the last of them.
    expect(screen.getByText("Episode 4")).toBeInTheDocument();
    expect(screen.queryByText("Episode 2")).not.toBeInTheDocument();
    expect(screen.queryByText(/Skipped a file/)).not.toBeInTheDocument();
  });
});
