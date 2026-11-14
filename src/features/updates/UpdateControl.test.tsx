import { clearMocks } from "@tauri-apps/api/mocks";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import type { UpdateStatus } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { useUpdates } from "./store";
import { UpdateControl } from "./UpdateControl";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const AVAILABLE: UpdateStatus = { state: "available", version: "1.5.0", current: "1.4.0" };
const READY: UpdateStatus = { state: "ready", version: "1.5.0" };

const updateInstall = vi.fn((): UpdateStatus | Promise<UpdateStatus> => READY);
const updateRestart = vi.fn(() => null);

function stands(status: UpdateStatus) {
  act(() => useUpdates.setState({ status }));
}

beforeEach(() => {
  updateInstall.mockReset().mockReturnValue(READY);
  updateRestart.mockReset().mockReturnValue(null);
  mockCommands({ updateInstall, updateRestart });
  useUpdates.setState({ status: { state: "idle" } });
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("the update control", () => {
  it("is not there while there is nothing newer", () => {
    const { container } = renderUi(<UpdateControl />);
    expect(container).toBeEmptyDOMElement();
    stands({ state: "current", version: "1.4.0" });
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the version that was found, by its number", async () => {
    renderUi(<UpdateControl />);
    stands(AVAILABLE);
    const button = screen.getByRole("button", { name: "Update to 1.5.0" });
    await userEvent.click(button);
    expect(updateInstall).toHaveBeenCalledOnce();
  });

  it("says on hover which version this is and what updating does", async () => {
    renderUi(<UpdateControl />);
    stands(AVAILABLE);
    await userEvent.hover(screen.getByRole("button", { name: "Update to 1.5.0" }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("You have 1.4.0. Updating restarts Lumen.");
  });

  it("shows the download as a scale and a share, read out as a progress bar", () => {
    renderUi(<UpdateControl />);
    stands({ state: "downloading", version: "1.5.0", received: 15_262_500, total: 41_250_000 });
    const bar = screen.getByRole("progressbar", { name: "Downloading Lumen 1.5.0" });
    expect(bar).toHaveAttribute("aria-valuenow", "37");
    expect(bar).toHaveAttribute("aria-valuetext", "37%");
    expect(screen.getByText("37%")).toBeInTheDocument();
    // Nothing to press while it arrives.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    stands({ state: "downloading", version: "1.5.0", received: 41_250_000, total: 41_250_000 });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("keeps a column as wide as its widest figure, so that no figure moves the rest", () => {
    renderUi(<UpdateControl />);
    stands({ state: "downloading", version: "1.5.0", received: 7, total: 100 });
    const figure = screen.getByText("7%");
    // Beside it, unseen, the widest it will ever be: that is what the column is sized by.
    const sizer = figure.previousElementSibling;
    expect(sizer).toHaveTextContent("100%");
    expect(sizer).toHaveClass("invisible");
    // Neither is read out: the scale says the share.
    expect(figure.parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps its place from one report of the download to the next", () => {
    renderUi(<UpdateControl />);
    stands({ state: "downloading", version: "1.5.0", received: 1, total: 100 });
    const bar = screen.getByRole("progressbar");
    stands({ state: "downloading", version: "1.5.0", received: 60, total: 100 });
    // The same element, moved along: not a new one fading in each time.
    expect(screen.getByRole("progressbar")).toBe(bar);
    expect(bar).toHaveAttribute("aria-valuenow", "60");
  });

  it("sweeps rather than guess when the server does not say how large the download is", () => {
    renderUi(<UpdateControl />);
    stands({ state: "downloading", version: "1.5.0", received: 5_000_000, total: null });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Downloading Lumen 1.5.0");
  });

  it("says that it is installing", () => {
    renderUi(<UpdateControl />);
    stands({ state: "installing", version: "1.5.0" });
    expect(screen.getByRole("status", { name: "Installing Lumen 1.5.0" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers to restart once the new version is in place", async () => {
    renderUi(<UpdateControl />);
    stands(READY);
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    await flush();
    expect(updateRestart).toHaveBeenCalledOnce();
    expect(updateInstall).not.toHaveBeenCalled();
  });

  it("goes when the update turns out not to be one after all", () => {
    const { container } = renderUi(<UpdateControl />);
    stands(AVAILABLE);
    expect(container).not.toBeEmptyDOMElement();
    stands({ state: "current", version: "1.5.0" });
    expect(container).toBeEmptyDOMElement();
  });
});
