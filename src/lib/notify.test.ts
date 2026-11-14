import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/ipc";

const error = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error } }));

import { notifyFailure, send } from "./notify";

const ENGINE: AppError = { kind: "engine", message: "command seek: error running command" };

beforeEach(() => {
  error.mockClear();
});

describe("notifyFailure", () => {
  it("says what could not be done, what was reported, and what to try", () => {
    notifyFailure("seek", ENGINE);
    expect(error).toHaveBeenCalledWith(
      "Lumen could not seek",
      expect.objectContaining({
        description:
          "The playback engine reported: command seek: error running command. Try again, or open the file again.",
      }),
    );
  });

  it("gives the same failure the same identity, so repeats update one toast", () => {
    notifyFailure("seek", ENGINE);
    notifyFailure("seek", ENGINE);
    notifyFailure("change the volume", ENGINE);
    const ids = error.mock.calls.map(([, options]) => (options as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("writes other failures as a sentence, whatever punctuation they came with", () => {
    notifyFailure("open what you dropped", { kind: "notFound", message: "that file is gone.. " });
    expect(error).toHaveBeenLastCalledWith(
      "Lumen could not open what you dropped",
      expect.objectContaining({ description: "That file is gone." }),
    );
  });

  it("owns up when the fault is its own", () => {
    notifyFailure("change full screen", { kind: "internal", message: "no main window" });
    expect(error).toHaveBeenLastCalledWith(
      "Lumen could not change full screen",
      expect.objectContaining({
        description: "This is a fault in Lumen, not in your file: no main window.",
      }),
    );
  });
});

describe("send", () => {
  it("stays quiet when the command succeeds", async () => {
    send("seek", Promise.resolve({ status: "ok", data: null }));
    await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
  });

  it("says so when the backend refuses", async () => {
    send("seek", Promise.resolve({ status: "error", error: ENGINE }));
    await Promise.resolve();
    expect(error).toHaveBeenCalledOnce();
  });
});
