import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { commands, type SavedPlaylist } from "@/ipc";
import { useSaved } from "./saved";
import { useQueue } from "./store";
import { usePlaylistUi } from "./ui";

interface SaveFormProps {
  open: boolean;
  /** The saved playlist being given another name; `null` to save the queue. */
  renaming: SavedPlaylist | null;
  /** Holds the `PopoverAnchor` the form stands beside. */
  children: ReactNode;
}

function close() {
  usePlaylistUi.getState().setSaving(false);
}

/**
 * The small form that names a playlist: to save the queue under a name, or
 * to give a saved playlist another one (DESIGN.md §7, "Menu and popover").
 */
export function SaveForm({ open, renaming, children }: SaveFormProps) {
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      {children}
      {open ? (
        <PopoverContent label={renaming ? "Rename playlist" : "Save playlist"}>
          <Form renaming={renaming} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function Form({ renaming }: { renaming: SavedPlaylist | null }) {
  const [name, setName] = useState(() => renaming?.name ?? useQueue.getState().name ?? "");
  const existing = useSaved((state) => state.entries);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // On opening: select the name, for typing over.
  useEffect(() => {
    input.current?.select();
  }, []);

  const typed = name.trim();
  const clash = existing.find(
    (playlist) =>
      playlist.name.toLowerCase() === typed.toLowerCase() && playlist.id !== renaming?.id,
  );
  const unchanged = renaming !== null && typed === renaming.name;
  const blocked = typed === "" || unchanged || (renaming !== null && clash !== undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked || busy) {
      return;
    }
    setBusy(true);
    setRefusal(null);
    const result = renaming
      ? await commands.playlistsRename(renaming.id, typed)
      : await commands.playlistsSave(typed, clash !== undefined);
    setBusy(false);
    if (result.status === "ok") {
      close();
      return;
    }
    if (result.error.kind === "exists") {
      // The name is taken, which the list here did not know: read it again,
      // and the name shows as taken.
      void useSaved.getState().load();
    } else {
      const said = result.error.message.replace(/[.\s]+$/, "");
      setRefusal(`${said.charAt(0).toUpperCase()}${said.slice(1)}.`);
    }
  }

  const error =
    refusal ?? (renaming && clash ? `Another playlist is called “${clash.name}”.` : undefined);
  const hint = !renaming && clash ? `Replaces the saved “${clash.name}”.` : undefined;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field
        ref={input}
        label="Name"
        value={name}
        maxLength={120}
        autoFocus
        error={error}
        hint={hint}
        onChange={(event) => {
          setName(event.target.value);
          setRefusal(null);
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={blocked}>
          {renaming ? "Rename" : clash ? "Replace" : "Save"}
        </Button>
      </div>
    </form>
  );
}
