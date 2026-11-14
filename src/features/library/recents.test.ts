import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recent } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { connectRecents, RECENTS_WANTED, useRecents } from "./recents";

function played(name: string, playedAt: number): Recent {
  return {
    source: `/films/${name}.mkv`,
    title: name,
    duration: 7305,
    position: 0,
    finished: false,
    playedAt,
    state: null,
    available: true,
    poster: null,
    resumesAt: null,
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What the backend says when the history is not what it was. */
async function historyChanged() {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("history-changed", null);
}

afterEach(() => {
  useRecents.setState({ entries: [], loaded: false });
  clearMocks();
});

describe("what was played", () => {
  it("is read on request, and says it has been read even when it could not be", async () => {
    mockCommands({ historyRecent: (args) => [played("a", args.limit)] });
    await useRecents.getState().load();
    // As many as the home screen could ever show.
    expect(useRecents.getState()).toMatchObject({
      entries: [{ title: "a", playedAt: RECENTS_WANTED }],
      loaded: true,
    });

    mockCommands({
      historyRecent: () => {
        throw { kind: "internal", message: "the database is locked" };
      },
    });
    useRecents.setState({ loaded: false });
    await useRecents.getState().load();
    // Left as it was: the home screen must still be shown.
    expect(useRecents.getState()).toMatchObject({ entries: [{ title: "a" }], loaded: true });
  });

  it("is read again whenever the backend says it has changed", async () => {
    let history = [played("a", 1)];
    mockCommands({ historyRecent: () => history });
    const connection = connectRecents();
    await connection.ready;
    expect(useRecents.getState().entries).toEqual([]);

    // Something else was opened, while a film is on the stage.
    history = [played("b", 2), ...history];
    await historyChanged();
    await settled();
    expect(useRecents.getState().entries.map((entry) => entry.title)).toEqual(["b", "a"]);

    connection.stop();
    await settled();
    history = [];
    await historyChanged();
    await settled();
    expect(useRecents.getState().entries).toHaveLength(2);
  });

  it("is read once more, not once each, for changes that come together", async () => {
    let history = [played("a", 1)];
    const waiting: (() => void)[] = [];
    const read = vi.fn(
      () =>
        new Promise<Recent[]>((resolve) => {
          const now = history;
          waiting.push(() => resolve(now));
        }),
    );
    mockCommands({ historyRecent: read });
    const connection = connectRecents();
    await connection.ready;

    // Everything is put back at once: the undo of "Clear recently played".
    await historyChanged();
    history = [played("b", 2), ...history];
    await historyChanged();
    history = [played("c", 3), ...history];
    await historyChanged();
    await settled();
    expect(read).toHaveBeenCalledTimes(1);

    // The first answer is already out of date; one more reading has the rest.
    waiting.shift()?.();
    await settled();
    expect(read).toHaveBeenCalledTimes(2);
    waiting.shift()?.();
    await settled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(useRecents.getState().entries.map((entry) => entry.title)).toEqual(["c", "b", "a"]);

    // And it listens on: the next change is read as the first was.
    await historyChanged();
    await settled();
    expect(read).toHaveBeenCalledTimes(3);
    waiting.shift()?.();
    connection.stop();
  });
});
