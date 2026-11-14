import { clearMocks } from "@tauri-apps/api/mocks";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCommands } from "@/ipc/bindings";
import { resetPreviews, usePreview } from "./preview";
import { IDLE_SNAPSHOT, usePlayer } from "./store";

const PICTURE = {
  width: 1920,
  height: 1080,
  fps: 24,
  codec: "hevc",
  dynamicRange: "sdr" as const,
  hardwareDecoder: null,
};

/** Fifty minutes: cut into 300 stills, one every ten seconds. */
const FILM = {
  ...IDLE_SNAPSHOT,
  source: "/films/a.mkv",
  status: "paused" as const,
  duration: 3000,
  video: PICTURE,
};

const frame = vi.fn((args: { seconds: number }): string | null => `still at ${args.seconds}`);

beforeEach(() => {
  frame.mockClear();
  frame.mockImplementation((args) => `still at ${args.seconds}`);
  mockCommands({ playerPreviewFrame: frame });
  usePlayer.setState({ ...FILM, positionAt: 0, failure: null });
});

afterEach(() => {
  resetPreviews();
  clearMocks();
});

function hover(initial: number | null = null) {
  return renderHook(({ at }: { at: number | null }) => usePreview(at), {
    initialProps: { at: initial },
  });
}

describe("usePreview", () => {
  it("expects a still for a film on this Mac, and fetches none until asked", () => {
    const { result } = hover();
    expect(result.current).toEqual({ expected: true, url: null });
    expect(frame).not.toHaveBeenCalled();
  });

  it("fetches the still for the place asked about", async () => {
    const { result } = hover(104);
    await waitFor(() => expect(result.current.url).toBe("still at 100"));
    expect(frame).toHaveBeenCalledWith({ seconds: 100 });
  });

  it("does not fetch the same place twice", async () => {
    const { result, rerender } = hover(100);
    await waitFor(() => expect(result.current.url).toBe("still at 100"));
    rerender({ at: 103 });
    rerender({ at: 500 });
    await waitFor(() => expect(result.current.url).toBe("still at 500"));
    rerender({ at: 98 });
    expect(result.current.url).toBe("still at 100");
    expect(frame).toHaveBeenCalledTimes(2);
  });

  it("keeps the last still on show while the next is on its way", async () => {
    const { result, rerender } = hover(100);
    await waitFor(() => expect(result.current.url).toBe("still at 100"));
    let release: (url: string) => void = () => {};
    frame.mockImplementation(() => new Promise<string>((resolve) => (release = resolve)) as never);
    rerender({ at: 900 });
    expect(result.current.url).toBe("still at 100");
    await act(async () => release("still at 900"));
    await waitFor(() => expect(result.current.url).toBe("still at 900"));
  });

  it("fetches one at a time, and next only the place wanted last", async () => {
    const waiting: ((url: string) => void)[] = [];
    frame.mockImplementation(
      () => new Promise<string>((resolve) => waiting.push(resolve)) as never,
    );
    const { result, rerender } = hover(100);
    await waitFor(() => expect(frame).toHaveBeenCalledTimes(1));
    rerender({ at: 300 });
    rerender({ at: 600 });
    rerender({ at: 900 });
    expect(frame).toHaveBeenCalledTimes(1);
    await act(async () => waiting[0]?.("first"));
    await waitFor(() => expect(frame).toHaveBeenCalledTimes(2));
    // The places passed over on the way were never asked for.
    expect(frame).toHaveBeenLastCalledWith({ seconds: 900 });
    await act(async () => waiting[1]?.("last"));
    await waitFor(() => expect(result.current.url).toBe("last"));
  });

  it("expects nothing for sound alone, an address, or something without a length", () => {
    for (const change of [
      { video: null },
      { source: "https://example.com/a.mp4" },
      { duration: null },
    ]) {
      usePlayer.setState({ ...FILM, ...change });
      const { result, unmount } = hover(100);
      expect(result.current).toEqual({ expected: false, url: null });
      unmount();
    }
    expect(frame).not.toHaveBeenCalled();
  });

  it("stops expecting, and asking, once the film has shown it has no stills to give", async () => {
    frame.mockImplementation(() => null);
    const { result, rerender } = hover(100);
    await waitFor(() => expect(result.current.expected).toBe(false));
    rerender({ at: 500 });
    rerender({ at: 900 });
    expect(frame).toHaveBeenCalledTimes(1);
  });

  it("forgets the stills of one film when another opens", async () => {
    const { result, rerender } = hover(100);
    await waitFor(() => expect(result.current.url).toBe("still at 100"));
    act(() => usePlayer.setState({ source: "/films/b.mkv" }));
    rerender({ at: null });
    expect(result.current.url).toBeNull();
    rerender({ at: 100 });
    await waitFor(() => expect(frame).toHaveBeenCalledTimes(2));
  });
});
