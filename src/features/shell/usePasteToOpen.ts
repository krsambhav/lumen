import { useEffect } from "react";
import { usePalette } from "@/features/palette/store";
import { openSources } from "@/features/playlist/actions";
import { readAddress } from "@/features/playlist/address";

/** True if a paste into `target` belongs to it: a field or anything else that takes text. */
function takesText(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement)
  );
}

/**
 * ⌘V anywhere in the window but a text field plays a link that was copied,
 * the way a dropped file plays (DESIGN.md §7, "Open address"). Anything that
 * is not an address is left alone.
 */
export function usePasteToOpen(): void {
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (takesText(event.target) || usePalette.getState().open) {
        return;
      }
      const address = readAddress(event.clipboardData?.getData("text/plain") ?? "");
      if (address === null) {
        return;
      }
      event.preventDefault();
      openSources([address]);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}
