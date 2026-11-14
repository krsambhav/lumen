import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueSnapshot } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import {
  connectQueue,
  currentIndex,
  EMPTY_QUEUE,
  hasSeveral,
  totalLength,
  useQueue,
} from "./store";

const THREE: QueueSnapshot = {
  ...EMPTY_QUEUE,
  items: [
    { id: 4, source: "/a.mkv", title: "a.mkv", duration: 100, failed: null },
    { id: 5, source: "/b.mkv", title: "b.mkv", duration: 250.5, failed: null },
    { id: 6, source: "/c.mkv", title: "c.mkv", duration: null, failed: null },
  ],
  current: 5,
  hasNext: true,
  hasPrevious: true,
};

afterEach(() => {
  useQueue.setState(EMPTY_QUEUE, true);
  clearMocks();
});

describe("the queue", () => {
  it("has several things to play only with more than one", () => {
    expect(hasSeveral(EMPTY_QUEUE)).toBe(false);
    expect(hasSeveral({ items: THREE.items.slice(0, 1) })).toBe(false);
    expect(hasSeveral(THREE)).toBe(true);
  });

  it("says where the open item is in the list", () => {
    expect(currentIndex(THREE)).toBe(1);
    expect(currentIndex({ ...THREE, current: null })).toBe(-1);
  });

  it("adds up the lengths it knows and says whether that is all of them", () => {
    expect(totalLength(THREE)).toEqual({ seconds: 350.5, complete: false });
    expect(totalLength({ items: THREE.items.slice(0, 2) })).toEqual({
      seconds: 350.5,
      complete: true,
    });
    expect(totalLength(EMPTY_QUEUE)).toEqual({ seconds: 0, complete: true });
  });
});

describe("connectQueue", () => {
  it("loads the queue and then follows every change", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    mockCommands({ playlistSnapshot: () => THREE });
    const connection = connectQueue();
    await connection.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useQueue.getState().items).toHaveLength(3);

    await emit("queue-changed", { ...THREE, current: 6, hasNext: false });
    expect(useQueue.getState().current).toBe(6);
    expect(useQueue.getState().hasNext).toBe(false);
    connection.stop();
  });

  it("keeps a change that arrived while the first snapshot was on its way", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    let release: (snapshot: QueueSnapshot) => void = () => {};
    mockCommands({
      playlistSnapshot: () => new Promise<QueueSnapshot>((resolve) => (release = resolve)),
    });
    const connection = connectQueue();
    await connection.ready;
    await emit("queue-changed", THREE);
    // The snapshot is older than what was just heard.
    release(EMPTY_QUEUE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useQueue.getState().items).toHaveLength(3);
    connection.stop();
  });
});
