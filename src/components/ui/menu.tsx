import { Check, ChevronRight } from "lucide-react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useRef,
} from "react";
import { getAction, runAction } from "@/actions/registry";
import { cn } from "@/lib/cn";
import { Shortcut } from "./shortcut";
import { useSurfaceClass } from "./surface";

/**
 * How far an overlay keeps from the window's edges: 8 px, and below the
 * title bar (44 px) at the top, so a long menu never covers the traffic
 * lights or the title; it scrolls instead.
 */
const CLEAR_OF_EDGES = { top: 52, right: 8, bottom: 8, left: 8 } as const;

/**
 * Menus (DESIGN.md §7): one look for the menu a button opens and for the
 * menu a secondary click opens. Radix supplies the behaviour for each; the
 * parts below pick the right primitive from context, so a menu's contents
 * are written once and work in either.
 */

type Kind = "dropdown" | "context";

const KindContext = createContext<Kind>("dropdown");
/** A menu with any checked item keeps the check's column for all of them, so names line up. */
const CheckColumnContext = createContext(false);

// The two primitives have the same parts with the same props, as far as
// these components use them; one type serves for both.
function useParts(): typeof DropdownMenu {
  return useContext(KindContext) === "context"
    ? (ContextMenu as unknown as typeof DropdownMenu)
    : DropdownMenu;
}

interface MenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/** A menu opened by a button: put a `MenuTrigger` and a `MenuContent` inside. */
export function Menu({ open, onOpenChange, children }: MenuProps) {
  return (
    <KindContext.Provider value="dropdown">
      <DropdownMenu.Root
        // The rest of the window stays live: a film goes on playing behind a menu.
        modal={false}
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
      >
        {children}
      </DropdownMenu.Root>
    </KindContext.Provider>
  );
}

export const MenuTrigger = DropdownMenu.Trigger;

interface ContextMenuAreaProps {
  /** The menu's items. */
  menu: ReactNode;
  /** Whether any of them can be checked. */
  checkable?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What a secondary click on opens the menu. Must accept a ref and DOM props. */
  children: ReactElement;
}

/** Gives its child a menu that opens on a secondary click. */
export function ContextMenuArea({
  menu,
  checkable = false,
  onOpenChange,
  children,
}: ContextMenuAreaProps) {
  return (
    <KindContext.Provider value="context">
      <ContextMenu.Root modal={false} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <MenuContent checkable={checkable}>{menu}</MenuContent>
      </ContextMenu.Root>
    </KindContext.Provider>
  );
}

const SURFACE = cn(
  "z-popover min-w-[11.25rem] max-w-[20rem] rounded-md border border-line bg-surface-2 p-1",
  // Never taller than the room Radix measures between its trigger and the
  // window's edge (less the collision padding): a long list (twenty subtitle
  // tracks, every font) scrolls inside the menu instead of running off-window.
  "max-h-[var(--radix-dropdown-menu-content-available-height,var(--radix-context-menu-content-available-height,calc(100vh-1rem)))]",
  "scrollbar-thin overflow-y-auto overscroll-contain",
  "text-body text-ink-1 shadow-pop outline-none",
  // Toward the control that opened it; plain fade when closing.
  "data-[state=open]:animate-fade-in data-[side=bottom]:data-[state=open]:animate-drop-in",
  "data-[side=top]:data-[state=open]:animate-rise-in data-[state=closed]:animate-fade-out",
);

interface MenuContentProps {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Some of the items can be checked: keep a column for the check on all of them. */
  checkable?: boolean;
  /**
   * Asked as the menu closes: true if focus should stay where it has gone
   * rather than return to the menu's button. For an item that opens
   * something which takes the focus itself.
   */
  keepFocus?: () => boolean;
  className?: string;
  children: ReactNode;
}

export function MenuContent({
  side = "bottom",
  align = "start",
  sideOffset = 8,
  checkable = false,
  keepFocus,
  className,
  children,
}: MenuContentProps) {
  const kind = useContext(KindContext);
  const surfaceClass = useSurfaceClass();
  const classes = cn(surfaceClass, SURFACE, className);
  const content = useRef<HTMLDivElement>(null);
  return (
    <CheckColumnContext.Provider value={checkable}>
      {kind === "context" ? (
        <ContextMenu.Portal>
          <ContextMenu.Content
            collisionPadding={CLEAR_OF_EDGES}
            className={classes}
            onKeyDownCapture={noKeysForAClosingMenu}
          >
            {children}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      ) : (
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            ref={content}
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={CLEAR_OF_EDGES}
            className={classes}
            onKeyDownCapture={noKeysForAClosingMenu}
            onPointerDownOutside={(event) => {
              // The menu's own button opens and closes it. Were a press on it
              // to close the menu from here as well, pressing the button while
              // the menu is still fading out would open it and close it in one.
              const button = document.getElementById(
                content.current?.getAttribute("aria-labelledby") ?? "",
              );
              if (event.target instanceof Node && button?.contains(event.target)) {
                event.preventDefault();
              }
            }}
            onCloseAutoFocus={(event) => {
              if (keepFocus?.()) {
                event.preventDefault();
              }
            }}
          >
            {children}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      )}
    </CheckColumnContext.Provider>
  );
}

/*
 * A menu is still in the page while it fades out, and Radix goes on treating
 * it as a menu. It is finished with (DESIGN.md §7): three things see to that.
 * The stylesheet takes its items out of the pointer's reach, so none can be
 * chosen a second time; the two functions below keep its keys and its
 * "pointer left" handling from doing anything.
 */

/** Return pressed twice chooses once: the second finds the menu closing. */
function noKeysForAClosingMenu(event: KeyboardEvent<HTMLElement>) {
  if (event.currentTarget.getAttribute("data-state") === "closed") {
    event.stopPropagation();
  }
}

/**
 * Radix gives the keyboard back to the menu whenever the pointer leaves an
 * item, so the arrows have somewhere to start from. A menu that is closing
 * must not do that: whatever its item opened may already have the keyboard,
 * and that thing coming up under the pointer is itself a "leave". Preventing
 * the event's default is how Radix is told to skip its own handling.
 */
function leaveAClosingMenuAlone(event: PointerEvent<HTMLElement>) {
  if (event.currentTarget.closest('[role="menu"]')?.getAttribute("data-state") === "closed") {
    event.preventDefault();
  }
}

const ITEM = cn(
  "relative flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 outline-none",
  "data-[highlighted]:bg-surface-3 data-[disabled]:opacity-45",
);

/** The check's column: a check, or the room one would take. */
function CheckSlot({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className="flex size-4 flex-none items-center justify-center">
      {checked ? <Check className="size-4 text-accent" /> : null}
    </span>
  );
}

function Trailing({
  shortcut,
  detail,
}: {
  shortcut?: string | undefined;
  detail?: string | undefined;
}) {
  if (shortcut) {
    return <Shortcut chord={shortcut} className="flex-none pl-4 text-caption text-ink-3" />;
  }
  return detail ? (
    <span className="tabular flex-none pl-4 text-caption text-ink-3">{detail}</span>
  ) : null;
}

interface MenuItemProps {
  /** Chord text for the item's shortcut, shown at the trailing edge. */
  shortcut?: string | undefined;
  /** A short value at the trailing edge, where there is no shortcut: a count, a length. */
  detail?: string | undefined;
  /** For an item that switches something on and off. Leave undefined for a plain item. */
  checked?: boolean | undefined;
  /** The destructive choice: its name must say what is destroyed. */
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}

export function MenuItem({
  shortcut,
  detail,
  checked,
  danger = false,
  disabled = false,
  onSelect,
  children,
}: MenuItemProps) {
  const Parts = useParts();
  const column = useContext(CheckColumnContext);
  const inner = (
    <>
      {column || checked !== undefined ? <CheckSlot checked={checked === true} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Trailing shortcut={shortcut} detail={detail} />
    </>
  );
  const className = cn(ITEM, danger && "text-danger");
  if (checked !== undefined) {
    return (
      <Parts.CheckboxItem
        checked={checked}
        disabled={disabled}
        className={className}
        onCheckedChange={() => onSelect?.()}
        onPointerLeave={leaveAClosingMenuAlone}
      >
        {inner}
      </Parts.CheckboxItem>
    );
  }
  return (
    <Parts.Item
      disabled={disabled}
      className={className}
      onSelect={() => onSelect?.()}
      onPointerLeave={leaveAClosingMenuAlone}
    >
      {inner}
    </Parts.Item>
  );
}

interface MenuActionProps {
  /** The id of a registered action. */
  action: string;
  /** Overrides the action's name. */
  label?: string;
}

/**
 * A menu item bound to a registered action: its name, shortcut, check and
 * availability all come from the registry.
 */
export function MenuAction({ action, label }: MenuActionProps) {
  const entry = getAction(action);
  if (!entry) {
    return null;
  }
  return (
    <MenuItem
      shortcut={entry.shortcuts[0]}
      checked={entry.checked?.()}
      disabled={entry.unavailable?.() !== undefined}
      onSelect={() => runAction(action, "menu")}
    >
      {/* The name it has now, as everywhere an action is offered. */}
      {label ?? entry.label?.() ?? entry.name}
    </MenuItem>
  );
}

interface MenuChoiceProps<T extends string> {
  /** The name of what is being chosen, for assistive technology. */
  label: string;
  value: T;
  options: readonly { value: T; name: string; detail?: string }[];
  onChange: (value: T) => void;
}

/** One of several: the chosen one carries the check. */
export function MenuChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: MenuChoiceProps<T>) {
  const Parts = useParts();
  return (
    <Parts.RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
    >
      {options.map((option) => (
        <Parts.RadioItem
          key={option.value}
          value={option.value}
          className={ITEM}
          onPointerLeave={leaveAClosingMenuAlone}
        >
          <CheckSlot checked={option.value === value} />
          <span className="min-w-0 flex-1 truncate">{option.name}</span>
          <Trailing detail={option.detail} />
        </Parts.RadioItem>
      ))}
    </Parts.RadioGroup>
  );
}

export function MenuSeparator() {
  const Parts = useParts();
  return <Parts.Separator className="mx-2 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  const Parts = useParts();
  return <Parts.Label className="label px-2 pb-1 pt-2 text-ink-3">{children}</Parts.Label>;
}

interface MenuSubProps {
  /** The name of the item that opens the submenu. */
  label: string;
  /** Whether any item inside can be checked. */
  checkable?: boolean;
  disabled?: boolean;
  children: ReactNode;
}

/** A submenu: it opens to the side, never as a second menu over the first. */
export function MenuSub({ label, checkable = false, disabled = false, children }: MenuSubProps) {
  const Parts = useParts();
  const column = useContext(CheckColumnContext);
  const surfaceClass = useSurfaceClass();
  return (
    <Parts.Sub>
      <Parts.SubTrigger
        disabled={disabled}
        className={cn(ITEM, "data-[state=open]:bg-surface-3")}
        onPointerLeave={leaveAClosingMenuAlone}
      >
        {column ? <CheckSlot checked={false} /> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight aria-hidden="true" className="-mr-1 size-4 flex-none text-ink-3" />
      </Parts.SubTrigger>
      <Parts.Portal>
        <CheckColumnContext.Provider value={checkable}>
          <Parts.SubContent
            // Measured from the item that opens it, which is 5 px inside the
            // menu's edge (its border and padding): 4 px clear of the menu
            // beside it, and its first row level with that item.
            sideOffset={9}
            alignOffset={-5}
            collisionPadding={CLEAR_OF_EDGES}
            className={cn(surfaceClass, SURFACE)}
            onKeyDownCapture={noKeysForAClosingMenu}
          >
            {children}
          </Parts.SubContent>
        </CheckColumnContext.Provider>
      </Parts.Portal>
    </Parts.Sub>
  );
}

export type MenuTriggerProps = ComponentProps<typeof DropdownMenu.Trigger>;
