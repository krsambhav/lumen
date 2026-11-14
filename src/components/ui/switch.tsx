import { Switch as SwitchPrimitive } from "radix-ui";
import { type ReactNode, useId } from "react";
import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The id of the element that names it, when it is not in a `SwitchRow`. */
  labelledBy?: string;
  /** Its name, when nothing on screen names it. */
  label?: string;
  className?: string;
}

/**
 * On and off (DESIGN.md §7): 28 × 16 with a 12 px knob. The track is the
 * accent's fill when on, so the state reads at a glance; the knob's place
 * says it too, for anyone who does not see the colour.
 */
export function Switch({ checked, onChange, disabled, labelledBy, label, className }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onChange}
      {...(disabled === undefined ? {} : { disabled })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      {...(label === undefined ? {} : { "aria-label": label })}
      className={cn(
        // A 16 px control is small to hit: the area around it, out to the
        // 32 px height of a row, belongs to it too.
        "relative inline-flex h-4 w-7 flex-none items-center rounded-full bg-surface-4",
        "before:absolute before:-inset-x-1 before:-inset-y-2 before:content-['']",
        "transition-colors duration-fast ease-out data-[state=checked]:bg-accent-fill",
        "disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-3 translate-x-0.5 rounded-full bg-ink-2",
          "transition-[transform,background-color] duration-fast ease-out motion-reduce:transition-none",
          "data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-accent-fg",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

interface SwitchRowProps extends Omit<SwitchProps, "labelledBy" | "label" | "className"> {
  /** What it switches. */
  name: string;
  /** A line under the name, for what the name cannot say. */
  hint?: ReactNode;
  className?: string;
}

/**
 * A switch with its name: the name stretches and truncates, the switch
 * keeps its size at the trailing end, and a click anywhere on the row works
 * it.
 */
export function SwitchRow({ name, hint, className, ...control }: SwitchRowProps) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the switch is the control, named by the span through aria-labelledby; the label only widens what can be clicked
    <label
      className={cn(
        "flex min-h-8 min-w-0 cursor-default items-center gap-3",
        control.disabled && "opacity-45",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col py-1.5">
        <span id={id} className="truncate text-body text-ink-2">
          {name}
        </span>
        {hint ? <span className="text-caption text-ink-3">{hint}</span> : null}
      </span>
      <Switch {...control} labelledBy={id} />
    </label>
  );
}
