import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import type { TorrentResult } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { useTorrents } from "./store";

const RESULT: TorrentResult = {
  name: "MobLand S02E02 1080p",
  hash: "9".repeat(40),
  magnet: `magnet:?xt=urn:btih:${"9".repeat(40)}`,
  size: "3.1 GB",
  seeders: 40,
  leechers: 2,
  uploaded: null,
  category: "Video",
  trusted: false,
  ready: true,
};

afterEach(() => {
  clearMocks();
  useTorrents.setState({ search: { status: "idle" }, fetching: null });
});

describe("torrent search", () => {
  it("is not left searching when the same search is asked for again", async () => {
    let answer: (results: TorrentResult[]) => void = () => {};
    mockCommands({
      torrentsSearch: () => new Promise<TorrentResult[]>((resolve) => (answer = resolve)),
    });
    const { find } = useTorrents.getState();
    find("Mobland S02E02");
    find("Mobland S02E02");
    answer([RESULT]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useTorrents.getState().search).toEqual({
      status: "done",
      query: "Mobland S02E02",
      results: [RESULT],
    });
  });

  it("drops the answer to a search that was replaced", async () => {
    const answers: ((results: TorrentResult[]) => void)[] = [];
    mockCommands({
      torrentsSearch: () => new Promise<TorrentResult[]>((resolve) => answers.push(resolve)),
    });
    const { find } = useTorrents.getState();
    find("Mob");
    find("Mobland");
    answers[1]?.([RESULT]);
    answers[0]?.([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const search = useTorrents.getState().search;
    expect(search.status === "done" && search.query).toBe("Mobland");
  });
});
