import { describe, expect, it, vi } from "vitest";
import { IpcError, subscription, unwrap } from "./index";

describe("subscription", () => {
  it("is ready once the listener is registered, and not before", async () => {
    let registered: (stop: () => void) => void = () => {};
    const listening = subscription(new Promise((resolve) => (registered = resolve)));
    const ready = vi.fn();
    void listening.ready.then(ready);

    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    registered(() => {});
    await listening.ready;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("is still ready when listening failed, so a window is never left hidden", async () => {
    const listening = subscription(Promise.reject(new Error("no event system")));
    await expect(listening.ready).resolves.toBeUndefined();
  });

  it("stops listening, even if asked before the listener was registered", async () => {
    const stop = vi.fn();
    let registered: (stop: () => void) => void = () => {};
    const listening = subscription(new Promise((resolve) => (registered = resolve)));
    listening.stop();
    expect(stop).not.toHaveBeenCalled();
    registered(stop);
    await listening.ready;
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("unwrap", () => {
  it("returns the value of a command that succeeded", async () => {
    await expect(unwrap(Promise.resolve({ status: "ok", data: 7 }))).resolves.toBe(7);
  });

  it("throws what the backend reported, keeping its kind", async () => {
    const failed = unwrap(
      Promise.resolve({ status: "error", error: { kind: "notFound", message: "No such file" } }),
    );
    await expect(failed).rejects.toBeInstanceOf(IpcError);
    await expect(failed).rejects.toMatchObject({ kind: "notFound", message: "No such file" });
  });
});
