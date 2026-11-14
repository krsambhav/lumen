import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActions, registerActions } from "@/actions/registry";
import { mockCommands } from "@/ipc/bindings";
import { playerActions } from "./actions";
import { useChrome } from "./chrome";
import { connectPlaybackNotices } from "./notices";
import { useOsd } from "./osd";
import { IDLE_SNAPSHOT, usePlayer } from "./store";

beforeEach(() => {
  // Events need a Tauri to travel through; no command is called here.
  mockIPC(() => undefined, { shouldMockEvents: true });
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/s/Episode 1.mkv",
    title: "Episode 1.mkv",
    status: "playing",
    duration: 7305,
    positionAt: 0,
  });
});

afterEach(() => {
  act(() => {
    useOsd.getState().clear();
    useChrome.getState().reset();
    toast.dismiss();
  });
  clearMocks();
});

describe("what the player says on its own account", () => {
  it("says that a film started where it was left, and offers to start it over", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    const playerSeekTo = vi.fn(() => null);
    mockCommands({ playerSeekTo });
    registerActions(playerActions);
    const connection = connectPlaybackNotices();
    await connection.ready;
    await emit("player-changed", { type: "resumed", seconds: 2534 });

    // A toast, not the on-screen display: it has a follow-up to offer.
    expect(useOsd.getState().message).toBeNull();
    const notice = toast.getToasts().at(-1);
    const offer = notice && "action" in notice ? notice.action : undefined;
    if (
      !notice ||
      !("title" in notice) ||
      typeof offer !== "object" ||
      offer === null ||
      !("onClick" in offer)
    ) {
      throw new Error("there is no toast with an action");
    }
    expect(notice.title).toBe("Resumed at 0:42:14");
    expect(offer.label).toBe("Start over");
    offer.onClick({} as never);
    expect(playerSeekTo).toHaveBeenCalledWith({ seconds: 0, exact: true });
    connection.stop();
    clearActions();
  });

  it("takes that back when something else is opened", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    const connection = connectPlaybackNotices();
    await connection.ready;
    await emit("player-changed", { type: "resumed", seconds: 2534 });
    expect(toast.getToasts()).toHaveLength(1);
    act(() => usePlayer.setState({ source: "/s/Episode 2.mkv", title: "Episode 2" }));
    expect(toast.getToasts()).toHaveLength(0);
    connection.stop();
  });

  it("names the next item as it starts, when the chrome is not there to show it", async () => {
    const connection = connectPlaybackNotices();
    await connection.ready;
    act(() => useChrome.setState({ visible: false }));
    act(() => usePlayer.setState({ source: "/s/Episode 2.mkv", title: "Episode 2.mkv" }));
    expect(useOsd.getState().message).toEqual({ label: "Episode 2.mkv" });
    connection.stop();
  });

  it("leaves that to the title bar when the chrome is up", async () => {
    const connection = connectPlaybackNotices();
    await connection.ready;
    act(() => usePlayer.setState({ source: "/s/Episode 2.mkv", title: "Episode 2.mkv" }));
    expect(useOsd.getState().message).toBeNull();
    connection.stop();
  });

  it("says nothing about the first thing opened, or about closing", async () => {
    usePlayer.setState({ source: null, title: null });
    const connection = connectPlaybackNotices();
    await connection.ready;
    act(() => useChrome.setState({ visible: false }));
    act(() => usePlayer.setState({ source: "/s/Episode 1.mkv", title: "Episode 1.mkv" }));
    act(() => usePlayer.setState({ source: null, title: null }));
    expect(useOsd.getState().message).toBeNull();
    connection.stop();
  });

  it("stops saying anything once it is disconnected", async () => {
    const connection = connectPlaybackNotices();
    await connection.ready;
    connection.stop();
    act(() => useChrome.setState({ visible: false }));
    act(() => usePlayer.setState({ source: "/s/Episode 2.mkv", title: "Episode 2.mkv" }));
    expect(useOsd.getState().message).toBeNull();
  });
});
