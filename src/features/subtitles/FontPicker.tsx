import { Command } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { commands } from "@/ipc";

/** What the choice that is no font in particular is called. */
export const SYSTEM_FONT = "System";

/** The fonts on this Mac. Asked for once: they do not change while a film plays. */
let families: Promise<string[]> | null = null;

function installedFonts(): Promise<string[]> {
  families ??= commands
    .fontsList()
    .then((result) => (result.status === "ok" ? result.data : []))
    .catch(() => []);
  return families;
}

/** Forgets the list, between tests. */
export function forgetFontsForTests(): void {
  families = null;
}

interface FontPickerProps {
  /** The family in use; `null` is the system's own. */
  value: string | null;
  onChange: (family: string | null) => void;
}

/**
 * Chooses the font subtitles are set in. There are hundreds on a Mac, which
 * is too many for a menu: this is a list with a field that narrows it, the
 * system's own font first.
 */
export function FontPicker({ value, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open || fonts !== null) {
      return;
    }
    let live = true;
    void installedFonts().then((list) => {
      if (live) {
        setFonts(list);
      }
    });
    return () => {
      live = false;
    };
  }, [open, fonts]);

  function choose(family: string | null) {
    onChange(family);
    setOpen(false);
  }

  const row =
    "flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 data-[selected=true]:bg-surface-3";
  const check = (chosen: boolean) => (
    <span aria-hidden="true" className="flex size-4 flex-none items-center justify-center">
      {chosen ? <Check className="size-4 text-accent" /> : null}
    </span>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="-mr-1 flex h-7 min-w-0 max-w-full select-none items-center gap-1 rounded-sm pl-2 pr-1 text-body text-ink-1 transition-colors duration-fast ease-out hover:bg-surface-3 active:bg-surface-4 data-[state=open]:bg-surface-3"
        >
          <span className="sr-only">Font: </span>
          <span className="min-w-0 truncate">{value ?? SYSTEM_FONT}</span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 flex-none text-ink-3" />
        </button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent label="Font" className="w-64 p-0">
          <Command label="Font" loop className="flex min-h-0 flex-col">
            <div className="flex h-9 flex-none items-center border-b border-line px-3">
              <Command.Input
                autoFocus
                placeholder="Find a font"
                // The popover's own edge says where typing goes.
                className="h-full min-w-0 flex-1 bg-transparent text-body text-ink-1 outline-none"
              />
            </div>
            <Command.List className="scrollbar-thin max-h-56 overflow-y-auto overscroll-contain p-1">
              <Command.Empty className="px-2 py-3 text-body text-ink-2">
                {fonts === null ? "Looking at the fonts on this Mac…" : "No font of that name."}
              </Command.Empty>
              <Command.Item value={SYSTEM_FONT} onSelect={() => choose(null)} className={row}>
                {check(value === null)}
                <span className="min-w-0 flex-1 truncate">{SYSTEM_FONT}</span>
              </Command.Item>
              {(fonts ?? []).map((family) => (
                <Command.Item
                  key={family}
                  value={family}
                  onSelect={() => choose(family)}
                  className={row}
                >
                  {check(family === value)}
                  <span className="min-w-0 flex-1 truncate">{family}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
