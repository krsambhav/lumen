import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { Menu, MenuChoice, MenuContent, MenuTrigger } from "./menu";

export interface PickerOption<T extends string> {
  value: T;
  name: string;
  /** A short note at the trailing edge of its menu row. */
  detail?: string;
}

interface PickerProps<T extends string> {
  /** What is being chosen: part of the control's accessible name. */
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  /** What to show when `value` is none of the options ("Custom"). */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * One of several (DESIGN.md §7): a ghost button showing the present choice
 * and an up-down chevron, which opens a menu of the choices with the
 * present one checked. The choice truncates; the chevron never shrinks.
 */
export function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  className,
}: PickerProps<T>) {
  const current = options.find((option) => option.value === value)?.name ?? placeholder ?? "";
  return (
    <Menu>
      <MenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "flex h-7 min-w-0 max-w-full select-none items-center gap-1 rounded-sm pl-2 pr-1 text-body text-ink-1",
            "transition-colors duration-fast ease-out hover:bg-surface-3 active:bg-surface-4",
            "data-[state=open]:bg-surface-3 disabled:pointer-events-none disabled:opacity-45",
            className,
          )}
        >
          {/* Its name is what it chooses and what is chosen: "Aspect: 16:9". */}
          <span className="sr-only">{label}: </span>
          <span className="min-w-0 truncate">{current}</span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 flex-none text-ink-3" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" checkable>
        <MenuChoice label={label} value={value} options={options} onChange={onChange} />
      </MenuContent>
    </Menu>
  );
}

interface PickerRowProps<T extends string> extends PickerProps<T> {
  /** The row's name, where it should differ from the picker's own label. */
  name?: string;
}

/**
 * A picker with its name, for panels: the name keeps the width every row's
 * name has, and the picker stands at the trailing end of what is left, its
 * chevron at the column's edge.
 */
export function PickerRow<T extends string>({ name, className, ...picker }: PickerRowProps<T>) {
  return (
    <div className={cn("flex h-8 min-w-0 items-center gap-3", className)}>
      <span className="w-28 flex-none truncate text-body text-ink-2">{name ?? picker.label}</span>
      <span className="flex min-w-0 flex-1 justify-end">
        <Picker {...picker} className="-mr-1" />
      </span>
    </div>
  );
}
