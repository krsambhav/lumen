import { emit } from "@tauri-apps/api/event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toaster";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import type { AppError, Subscription, UpdateStatus } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import {
  arrivedText,
  checkForUpdates,
  connectUpdates,
  installUpdate,
  shareOf,
  sizeText,
  useUpdates,
} from "./store";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const CURRENT: UpdateStatus = { state: "current", version: "1.4.0" };
const AVAILABLE: UpdateStatus = { state: "available", version: "1.5.0", current: "1.4.0" };
const READY: UpdateStatus = { state: "ready", version: "1.5.0" };

function downloading(received: number, total: number | null = 41_250_000) {
  return { state: "downloading", version: "1.5.0", received, total } as const;
}

const updateStatus = vi.fn((): UpdateStatus => ({ state: "idle" }));
const updateCheck = vi.fn((): UpdateStatus | Promise<UpdateStatus> => CURRENT);
const updateInstall = vi.fn((): UpdateStatus | Promise<UpdateStatus> => READY);
const updateRestart = vi.fn(() => null);

function openFilm() {
  act(() => usePlayer.setState({ source: "/films/a.mkv", status: "playing", duration: 100 }));
}

beforeEach(() => {
  updateStatus.mockReset().mockReturnValue({ state: "idle" });
  updateCheck.mockReset().mockReturnValue(CURRENT);
  updateInstall.mockReset().mockReturnValue(READY);
  updateRestart.mockReset().mockReturnValue(null);
  mockCommands({ updateStatus, updateCheck, updateInstall, updateRestart });
  useUpdates.setState({ status: { state: "idle" } });
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  renderUi(<Toaster />);
});

afterEach(async () => {
  act(() => {
    toast.dismiss();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("checking for updates because the user asked", () => {
  it("says that Lumen is up to date, and which version that is", async () => {
    checkForUpdates();
    expect(await screen.findByText("Lumen is up to date")).toBeInTheDocument();
    expect(screen.getByText("1.4.0 is the newest version")).toBeInTheDocument();
    expect(useUpdates.getState().status).toEqual(CURRENT);
    // Nothing to do about it: no button but the one that closes it.
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  });

  it("says so while it looks, in the toast the answer will take", async () => {
    let answer: (status: UpdateStatus) => void = () => {};
    updateCheck.mockReturnValue(
      new Promise<UpdateStatus>((resolve) => {
        answer = resolve;
      }),
    );
    checkForUpdates();
    expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();
    await act(async () => answer(CURRENT));
    expect(await screen.findByText("Lumen is up to date")).toBeInTheDocument();
    expect(screen.queryByText("Checking for updates…")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
  });

  it("offers a newer version, and fetches it when asked to", async () => {
    updateCheck.mockReturnValue(AVAILABLE);
    checkForUpdates();
    expect(await screen.findByText("Lumen 1.5.0 is available")).toBeInTheDocument();
    expect(screen.getByText("You have 1.4.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(updateInstall).toHaveBeenCalledOnce();
  });

  it("does not leave the Update button on an answer that has nothing to update to", async () => {
    updateCheck.mockReturnValueOnce(AVAILABLE);
    checkForUpdates();
    await screen.findByRole("button", { name: "Update" });
    // Asked again, and by now this is the newest: the same toast says so.
    checkForUpdates();
    expect(await screen.findByText("Lumen is up to date")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.queryByText("You have 1.4.0")).not.toBeInTheDocument();
  });

  it("says why it could not look, and keeps saying it until it is closed", async () => {
    const offline: AppError = {
      kind: "network",
      message: "GitHub could not be reached. Check the connection and try again",
    };
    updateCheck.mockImplementation(() => {
      throw offline;
    });
    checkForUpdates();
    expect(await screen.findByText("Lumen could not check for updates")).toBeInTheDocument();
    expect(
      screen.getByText("GitHub could not be reached. Check the connection and try again."),
    ).toBeInTheDocument();
    // The toast that said it was looking is the one that says it could not.
    expect(screen.queryByText("Checking for updates…")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
    // What was known before the failure is still known.
    expect(useUpdates.getState().status).toEqual({ state: "idle" });
  });

  it("takes the failure away when it is asked again", async () => {
    updateCheck.mockImplementationOnce(() => {
      throw { kind: "network", message: "offline" } satisfies AppError;
    });
    checkForUpdates();
    await screen.findByText("Lumen could not check for updates");
    checkForUpdates();
    expect(await screen.findByText("Lumen is up to date")).toBeInTheDocument();
    expect(screen.queryByText("Lumen could not check for updates")).not.toBeInTheDocument();
    // In the same toast, which is no longer marked as a failure.
    const toasts = document.querySelectorAll("[data-sonner-toast]");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).not.toHaveAttribute("data-type", "error");
  });

  it("does not offer Update on a failure that took the offer's place", async () => {
    updateCheck.mockReturnValueOnce(AVAILABLE);
    checkForUpdates();
    await screen.findByRole("button", { name: "Update" });
    updateCheck.mockImplementationOnce(() => {
      throw { kind: "network", message: "offline" } satisfies AppError;
    });
    checkForUpdates();
    expect(await screen.findByText("Lumen could not check for updates")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    // What had been found is still known, and still offered where it is shown.
    expect(useUpdates.getState().status).toEqual(AVAILABLE);
  });

  it("answers with how far an update already on its way in has come", async () => {
    updateCheck.mockReturnValue(downloading(15_262_500));
    checkForUpdates();
    expect(await screen.findByText("Downloading Lumen 1.5.0")).toBeInTheDocument();
    expect(screen.getByText("37% · 15 of 41 MB")).toBeInTheDocument();
  });

  it("answers that the new version is in place, with the way to start using it", async () => {
    updateCheck.mockReturnValue(READY);
    checkForUpdates();
    expect(await screen.findByText("Lumen 1.5.0 is installed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(updateRestart).toHaveBeenCalledOnce();
  });
});

describe("updating", () => {
  it("starts Lumen again at once when nothing is open", async () => {
    useUpdates.setState({ status: AVAILABLE });
    installUpdate();
    await flush();
    expect(updateInstall).toHaveBeenCalledOnce();
    expect(updateRestart).toHaveBeenCalledOnce();
    expect(useUpdates.getState().status).toEqual(READY);
  });

  it("over a film only says it is ready, and leaves the moment to the viewer", async () => {
    useUpdates.setState({ status: AVAILABLE });
    openFilm();
    installUpdate();
    expect(await screen.findByText("Lumen 1.5.0 is installed")).toBeInTheDocument();
    expect(screen.getByText("It opens the next time Lumen starts")).toBeInTheDocument();
    expect(updateRestart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(updateRestart).toHaveBeenCalledOnce();
  });

  it("from the toast, over a film, is followed in that toast", async () => {
    updateCheck.mockReturnValue(AVAILABLE);
    let arrive: (status: UpdateStatus) => void = () => {};
    updateInstall.mockReturnValue(
      new Promise<UpdateStatus>((resolve) => {
        arrive = resolve;
      }),
    );
    const connection = connectUpdates();
    await connection.ready;
    openFilm();
    checkForUpdates();
    await userEvent.click(await screen.findByRole("button", { name: "Update" }));
    // The toast that offered it is still there, to say how it goes.
    expect(screen.getByText("Lumen 1.5.0 is available")).toBeInTheDocument();
    await act(() => emit("update-changed", downloading(15_262_500)));
    expect(await screen.findByText("37% · 15 of 41 MB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    await act(async () => arrive(READY));
    expect(await screen.findByText("Lumen 1.5.0 is installed")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
    expect(updateRestart).not.toHaveBeenCalled();
    connection.stop();
  });

  it("from the toast, on the home screen, never loses a failure that comes at once", async () => {
    updateCheck.mockReturnValue(AVAILABLE);
    updateInstall.mockImplementation(() => {
      throw {
        kind: "unsupported",
        message: "Lumen is running from its disk image or a read-only copy",
      } satisfies AppError;
    });
    checkForUpdates();
    await userEvent.click(await screen.findByRole("button", { name: "Update" }));
    // The offer is gone, and the failure is there to be read for as long as it takes.
    expect(await screen.findByText("Lumen could not update")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByText("Lumen could not update")).toBeInTheDocument();
    expect(
      screen.getByText("Lumen is running from its disk image or a read-only copy."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  });

  it("asks once, however many times it is clicked before the answer", async () => {
    let answer: (status: UpdateStatus) => void = () => {};
    updateInstall.mockReturnValue(
      new Promise<UpdateStatus>((resolve) => {
        answer = resolve;
      }),
    );
    useUpdates.setState({ status: AVAILABLE });
    installUpdate();
    installUpdate();
    installUpdate();
    await flush();
    expect(updateInstall).toHaveBeenCalledOnce();
    await act(async () => answer(READY));
    await flush();
    expect(updateRestart).toHaveBeenCalledOnce();
    // And can be asked again afterwards.
    installUpdate();
    await flush();
    expect(updateInstall).toHaveBeenCalledTimes(2);
  });

  it("asks for nothing while one is already on its way in", async () => {
    useUpdates.setState({ status: downloading(1000) });
    installUpdate();
    await flush();
    expect(updateInstall).not.toHaveBeenCalled();
  });

  it("says why it could not, and does not restart", async () => {
    updateInstall.mockImplementation(() => {
      throw {
        kind: "network",
        message: "The download was cut short. Check the connection and try again",
      } satisfies AppError;
    });
    useUpdates.setState({ status: AVAILABLE });
    installUpdate();
    expect(await screen.findByText("Lumen could not update")).toBeInTheDocument();
    expect(
      screen.getByText("The download was cut short. Check the connection and try again."),
    ).toBeInTheDocument();
    expect(updateRestart).not.toHaveBeenCalled();
  });
});

describe("following the backend", () => {
  let connection: Subscription;

  beforeEach(async () => {
    connection = connectUpdates();
    await connection.ready;
    await flush();
  });

  afterEach(async () => {
    connection.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("reads how things stand when it starts, and hears every change after", async () => {
    expect(updateStatus).toHaveBeenCalledOnce();
    await act(() => emit("update-changed", AVAILABLE));
    expect(useUpdates.getState().status).toEqual(AVAILABLE);
  });

  it("says nothing of a version it found by itself: the home screen's control shows it", async () => {
    await act(() => emit("update-changed", AVAILABLE));
    await flush();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    // Nor over a film, where nobody asked.
    openFilm();
    await flush();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("shows an update come in, in a toast, while a film is open", async () => {
    openFilm();
    await act(() => emit("update-changed", downloading(5_000_000)));
    expect(await screen.findByText("Downloading Lumen 1.5.0")).toBeInTheDocument();
    expect(screen.getByText("12% · 5 of 41 MB")).toBeInTheDocument();

    await act(() => emit("update-changed", downloading(41_250_000)));
    expect(await screen.findByText("100% · 41 of 41 MB")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);

    await act(() => emit("update-changed", { state: "installing", version: "1.5.0" }));
    expect(await screen.findByText("Installing Lumen 1.5.0")).toBeInTheDocument();
    expect(screen.queryByText(/of 41 MB/)).not.toBeInTheDocument();
  });

  it("leaves that to the title bar's control on the home screen", async () => {
    await act(() => emit("update-changed", downloading(5_000_000)));
    await flush();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();

    // A film opened meanwhile: now the toast is where it is seen.
    openFilm();
    expect(await screen.findByText("Downloading Lumen 1.5.0")).toBeInTheDocument();
    // And closed again: the control has it.
    act(() => usePlayer.setState({ source: null, status: "idle" }));
    await waitFor(() =>
      expect(screen.queryByText("Downloading Lumen 1.5.0")).not.toBeInTheDocument(),
    );
  });

  it("takes the toast away when the download gives up", async () => {
    openFilm();
    await act(() => emit("update-changed", downloading(5_000_000)));
    await screen.findByText("Downloading Lumen 1.5.0");
    // The backend goes back to what it had found; whoever asked says what went wrong.
    await act(() => emit("update-changed", AVAILABLE));
    await waitFor(() =>
      expect(screen.queryByText("Downloading Lumen 1.5.0")).not.toBeInTheDocument(),
    );
  });
});

describe("how much has arrived", () => {
  it("is a share of the whole when the size is known", () => {
    expect(shareOf(downloading(0))).toBe(0);
    expect(shareOf(downloading(20_625_000))).toBe(0.5);
    // Never more than all of it, whatever the server sends.
    expect(shareOf(downloading(50_000_000))).toBe(1);
    expect(shareOf(downloading(1000, null))).toBeNull();
    expect(shareOf(downloading(1000, 0))).toBeNull();
  });

  it("is read in megabytes", () => {
    expect(sizeText(41_250_000)).toBe("41 MB");
    expect(sizeText(1_499_999)).toBe("1 MB");
    // Never "0 MB" for something that is there.
    expect(sizeText(200_000)).toBe("1 MB");
    expect(arrivedText(downloading(15_262_500))).toBe("15 of 41 MB");
    expect(arrivedText(downloading(0))).toBe("0 of 41 MB");
    expect(arrivedText(downloading(15_262_500, null))).toBe("15 MB so far");
  });
});
