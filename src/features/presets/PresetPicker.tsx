import { ChevronsUpDown } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  Menu,
  MenuChoice,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/** What the picker shows when the values are nobody's preset: set by hand. */
export const CUSTOM = "Custom";

interface PresetPickerProps {
  /** What the presets are of: "Picture preset". The control's accessible name. */
  label: string;
  /** The name of the preset the present values are, or `null` if they were set by hand. */
  current: string | null;
  /** The presets Lumen comes with, in order. */
  builtIn: readonly string[];
  /** The ones the user has saved, in the order they were saved. */
  saved: readonly string[];
  onChoose: (name: string) => void;
  /** Saves the present values under `name`, replacing a saved preset of that name. */
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
}

/**
 * Chooses a preset, and keeps the user's own (DESIGN.md §7): a Picker whose
 * menu ends with "Save as preset…", for values set by hand, and "Delete",
 * for a saved preset that is in use. Lumen's own presets cannot be replaced
 * or deleted.
 */
export function PresetPicker({
  label,
  current,
  builtIn,
  saved,
  onChoose,
  onSave,
  onDelete,
}: PresetPickerProps) {
  const [naming, setNaming] = useState(false);
  const mine = current !== null && saved.includes(current);
  const options = [...builtIn, ...saved].map((name) => ({ value: name, name }));
  return (
    <Popover open={naming} onOpenChange={setNaming}>
      <PopoverAnchor asChild>
        <span className="flex min-w-0 flex-initial">
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="flex h-7 min-w-0 max-w-full select-none items-center gap-1 rounded-sm pl-2 pr-1 text-body text-ink-1 transition-colors duration-fast ease-out hover:bg-surface-3 active:bg-surface-4 data-[state=open]:bg-surface-3"
              >
                <span className="sr-only">{label}: </span>
                <span className="min-w-0 truncate">{current ?? CUSTOM}</span>
                <ChevronsUpDown aria-hidden="true" className="size-3.5 flex-none text-ink-3" />
              </button>
            </MenuTrigger>
            <MenuContent
              align="end"
              checkable
              // The form that names a preset takes the keyboard itself.
              keepFocus={() => naming}
            >
              <MenuChoice
                label={label}
                value={current ?? ""}
                options={options}
                onChange={onChoose}
              />
              <MenuSeparator />
              <MenuItem
                // Values that are already a preset have nothing new to save.
                disabled={current !== null}
                onSelect={() => setNaming(true)}
              >
                Save as preset…
              </MenuItem>
              {mine ? (
                <MenuItem danger onSelect={() => onDelete(current)}>
                  Delete “{current}”
                </MenuItem>
              ) : null}
            </MenuContent>
          </Menu>
        </span>
      </PopoverAnchor>
      {naming ? (
        <PopoverContent label="Save preset">
          <NameForm
            builtIn={builtIn}
            saved={saved}
            onCancel={() => setNaming(false)}
            onSave={(name) => {
              onSave(name);
              setNaming(false);
            }}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

interface NameFormProps {
  builtIn: readonly string[];
  saved: readonly string[];
  onCancel: () => void;
  onSave: (name: string) => void;
}

function NameForm({ builtIn, saved, onCancel, onSave }: NameFormProps) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const typed = name.trim();
  const same = (other: string) => other.toLowerCase() === typed.toLowerCase();
  const own = builtIn.find(same);
  const replaced = saved.find(same);
  const blocked = typed === "" || own !== undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!blocked) {
      onSave(typed);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field
        ref={input}
        label="Name"
        value={name}
        maxLength={60}
        error={own ? `“${own}” is one of Lumen’s own: choose another name.` : undefined}
        hint={replaced ? `Replaces the saved “${replaced}”.` : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={blocked}>
          {replaced ? "Replace" : "Save"}
        </Button>
      </div>
    </form>
  );
}
