import { toast } from "sonner";
import type { AppError, CommandResult } from "@/ipc";
import { offerUndo, undoLast, withdrawUndo } from "./undo";

/** How long a toast with a second line to read stays, in milliseconds (DESIGN.md §7). */
export const TWO_LINES_MS = 8000;

interface Told {
  /** One toast per id: saying it again replaces what was said. */
  id: string;
  /** The name of what it concerns, on a line of its own, cut to fit (DESIGN.md §7). */
  name?: string | undefined;
}

/** What every toast with a name on its second line is given. */
function withName(name: string | undefined) {
  return name === undefined
    ? {}
    : {
        description: name,
        // One line: a film's name can be as long as a sentence.
        classNames: { description: "truncate text-ink-2" },
        duration: TWO_LINES_MS,
      };
}

/**
 * Says that something was done and offers to undo it (DESIGN.md §8: Undo
 * rather than a confirmation). ⌘Z takes the offer up for as long as the
 * toast is there.
 */
export function undoable(title: string, options: Told & { undo: () => void }): void {
  const { id, name, undo } = options;
  offerUndo(id, undo);
  toast(title, {
    id,
    ...withName(name),
    action: {
      label: "Undo",
      onClick: () => {
        withdrawUndo(id);
        undo();
      },
    },
    onDismiss: () => withdrawUndo(id),
    onAutoClose: () => withdrawUndo(id),
  });
}

/** Does what the newest Undo on show offers. False if there is none. */
export function undoNewest(): boolean {
  const id = undoLast();
  if (id === null) {
    return false;
  }
  toast.dismiss(id);
  return true;
}

/** Closes the toast in front, if there is one. For Escape. */
export function dismissFrontToast(): boolean {
  const front = toast.getToasts().at(-1);
  if (front === undefined) {
    return false;
  }
  toast.dismiss(front.id);
  return true;
}

/**
 * Says, in a toast, that something the user asked for did not happen
 * (PRODUCT.md: "say what happened"). `what` completes the sentence "Lumen
 * could not …": "seek", "change the volume".
 *
 * The same failure repeated, as it would be while a slider is dragged,
 * updates the one toast instead of stacking another.
 */
export function notifyFailure(what: string, error: AppError, id?: string): void {
  const title = `Lumen could not ${what}`;
  toast.error(title, {
    // Under an id of the caller's, the failure takes the place of what that
    // toast was saying, and a later attempt can take the failure's.
    id: id ?? `${title}|${error.message}`,
    description: explain(error),
    // Whatever the toast it replaces was offering is no longer on offer.
    action: undefined,
    // A failure is not said on a timer: it stays until it is closed (DESIGN.md §7).
    duration: Number.POSITIVE_INFINITY,
  });
}

/** The failure as a sentence a person can act on (DESIGN.md §10). */
function explain(error: AppError): string {
  const message = error.message.replace(/[.\s]+$/, "");
  switch (error.kind) {
    case "engine":
      return `The playback engine reported: ${message}. Try again, or open the file again.`;
    case "internal":
      return `This is a fault in Lumen, not in your file: ${message}.`;
    default:
      return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
  }
}

/**
 * Sends a command whose result is not otherwise needed and, if the backend
 * refuses it, says so. Nothing the user does fails silently.
 */
export function send(what: string, result: Promise<CommandResult<unknown>>): void {
  void result.then((settled) => {
    if (settled.status === "error") {
      notifyFailure(what, settled.error);
    }
  });
}
