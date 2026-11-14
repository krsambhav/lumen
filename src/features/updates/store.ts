import type { MouseEvent } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { hasMedia, usePlayer } from "@/features/player/store";
import { commands, events, type Subscription, subscription, type UpdateStatus } from "@/ipc";
import { notifyFailure, TWO_LINES_MS } from "@/lib/notify";

/**
 * Lumen's own updates (DESIGN.md §7, "Updates"). The backend looks at the
 * releases, fetches and installs; this keeps what it last said.
 */
export const useUpdates = create<{ status: UpdateStatus }>(() => ({
  status: { state: "idle" },
}));

/**
 * The one toast that says how an update stands. Each thing said takes the
 * place of the last, a failure included: asking again takes the failure away.
 */
const TOAST = "update";

/** An update has been asked for and not yet answered: a second click asks for nothing more. */
let asked = false;

/** A new version being fetched or put in place. */
export function underWay(
  status: UpdateStatus,
): status is Extract<UpdateStatus, { state: "downloading" | "installing" }> {
  return status.state === "downloading" || status.state === "installing";
}

/** A size as it is read: "41 MB". */
export function sizeText(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** How much of a download has arrived, 0–1, or `null` while its size is not known. */
export function shareOf(status: Extract<UpdateStatus, { state: "downloading" }>): number | null {
  if (status.total === null || status.total <= 0) {
    return null;
  }
  return Math.min(1, status.received / status.total);
}

/** "17 of 41 MB", or what has arrived when the size is not known. */
export function arrivedText(status: Extract<UpdateStatus, { state: "downloading" }>): string {
  if (status.total === null || status.total <= 0) {
    return `${sizeText(status.received)} so far`;
  }
  return `${Math.round(status.received / 1_000_000)} of ${sizeText(status.total)}`;
}

/**
 * Says something in the update's toast. Every field is given each time: a
 * toast that is replaced keeps whatever the new one leaves out, and the
 * Update button of "is available" must not stay on "is up to date".
 */
function say(
  title: string,
  options: {
    description?: string;
    action?: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void };
    /** Stays for as long as it is true of the moment: while something is being done. */
    lasting?: boolean;
  } = {},
): void {
  toast(title, {
    id: TOAST,
    description: options.description,
    classNames: { description: "tabular-nums text-ink-2" },
    action: options.action,
    duration: options.lasting
      ? Number.POSITIVE_INFINITY
      : options.description === undefined
        ? 5000
        : TWO_LINES_MS,
  });
}

/**
 * What pressing a button in the toast does to the toast: it stays, to say
 * what follows, or it goes. It is not left to close itself. Closed that way
 * it is still the toast of this id while it leaves, and a failure said in
 * that moment would leave with it; closed here, whatever is said next is a
 * toast of its own.
 */
function pressed(event: MouseEvent<HTMLButtonElement>, stays: boolean): void {
  event.preventDefault();
  if (!stays) {
    toast.dismiss(TOAST);
  }
}

/** Says how an update that is on its way in stands. */
function sayProgress(status: Extract<UpdateStatus, { state: "downloading" | "installing" }>): void {
  if (status.state === "installing") {
    say(`Installing Lumen ${status.version}`, { lasting: true });
    return;
  }
  const share = shareOf(status);
  say(`Downloading Lumen ${status.version}`, {
    description:
      share === null ? arrivedText(status) : `${Math.round(share * 100)}% · ${arrivedText(status)}`,
    lasting: true,
  });
}

/** Says that the new version is in place, with the way to start using it. */
function sayReady(version: string): void {
  say(`Lumen ${version} is installed`, {
    description: "It opens the next time Lumen starts",
    action: {
      label: "Restart",
      onClick: (event) => {
        pressed(event, false);
        restartToUpdate();
      },
    },
  });
}

/**
 * Looks for a newer version because the user asked, and answers in a toast
 * whatever is found: someone who asks is always told.
 */
export function checkForUpdates(): void {
  say("Checking for updates…", { lasting: true });
  void commands.updateCheck().then((result) => {
    if (result.status === "error") {
      notifyFailure("check for updates", result.error, TOAST);
      return;
    }
    const status = result.data;
    useUpdates.setState({ status });
    switch (status.state) {
      case "available":
        say(`Lumen ${status.version} is available`, {
          description: `You have ${status.current}`,
          action: {
            label: "Update",
            onClick: (event) => {
              // Over a film this toast is where the update is followed, so it
              // stays; on the home screen the title bar's control takes over.
              pressed(event, hasMedia(usePlayer.getState()));
              installUpdate();
            },
          },
        });
        break;
      case "downloading":
      case "installing":
        sayProgress(status);
        break;
      case "ready":
        sayReady(status.version);
        break;
      case "current":
        say("Lumen is up to date", { description: `${status.version} is the newest version` });
        break;
      case "idle":
        toast.dismiss(TOAST);
        break;
    }
  });
}

/**
 * Fetches the version that was found and puts it in place. With nothing
 * open, Lumen then starts again as the new version at once: that is what
 * was asked for, and there is nothing to interrupt. Over a film it only
 * says that the new version is ready, and leaves the moment to the viewer.
 */
export function installUpdate(): void {
  if (asked || underWay(useUpdates.getState().status)) {
    return;
  }
  asked = true;
  // A failure of the last attempt is not true of this one. Over a film the
  // download takes its place in the toast; on the home screen nothing would.
  const failed = toast
    .getToasts()
    .some((shown) => shown.id === TOAST && "type" in shown && shown.type === "error");
  if (failed && !hasMedia(usePlayer.getState())) {
    toast.dismiss(TOAST);
  }
  void commands.updateInstall().then((result) => {
    asked = false;
    if (result.status === "error") {
      notifyFailure("update", result.error, TOAST);
      return;
    }
    const status = result.data;
    useUpdates.setState({ status });
    if (status.state !== "ready") {
      return;
    }
    if (hasMedia(usePlayer.getState())) {
      sayReady(status.version);
    } else {
      restartToUpdate();
    }
  });
}

/** Closes Lumen and opens the version that was put in place. */
export function restartToUpdate(): void {
  void commands.updateRestart().then((result) => {
    if (result.status === "error") {
      notifyFailure("restart", result.error, TOAST);
    }
  });
}

/**
 * Follows the backend's word on updates. While a film is open, an update on
 * its way in is said in a toast; on the home screen the title bar's control
 * shows it, and a toast as well would say one thing twice.
 */
export function connectUpdates(): Subscription {
  const changes = subscription(
    events.updateChanged.listen((event) => {
      useUpdates.setState({ status: event.payload });
    }),
  );
  void Promise.resolve(commands.updateStatus()).then((status) => {
    // What an event has already said is newer than this answer.
    if (useUpdates.getState().status.state === "idle") {
      useUpdates.setState({ status });
    }
  });

  /** Whether the toast is the one showing the update come in. */
  let shown = false;
  const reflect = () => {
    const { status } = useUpdates.getState();
    const wanted = underWay(status) && hasMedia(usePlayer.getState());
    if (wanted) {
      shown = true;
      sayProgress(status);
    } else if (shown) {
      shown = false;
      // Back on the home screen, the control has it. Given up: whoever asked
      // says why, in this toast; if nobody here did, it has nothing left to say.
      if (underWay(status) || (status.state === "available" && !asked)) {
        toast.dismiss(TOAST);
      }
    }
  };
  const unsubscribes = [
    useUpdates.subscribe(reflect),
    usePlayer.subscribe((now, before) => {
      if (hasMedia(now) !== hasMedia(before)) {
        reflect();
      }
    }),
  ];

  return {
    ready: changes.ready,
    stop: () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      changes.stop();
    },
  };
}
