import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Ellipsis, Repeat, Repeat1, Shuffle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button";
import { ListBox, type ListBoxHandle, type OptionProps } from "@/components/ui/list-box";
import {
  ContextMenuArea,
  Menu,
  MenuAction,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuTrigger,
} from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { PopoverAnchor } from "@/components/ui/popover";
import { useSurfaceClass } from "@/components/ui/surface";
import { Tooltip } from "@/components/ui/tooltip";
import { ActionButton } from "@/features/player/ActionButton";
import { Timecode } from "@/features/player/Timecode";
import { failedLabel, nameOf } from "@/features/shell/failure";
import { registerPlaylistDropZone } from "@/features/shell/useFileDrop";
import { commands, type QueueItem } from "@/ipc";
import { cn } from "@/lib/cn";
import { send } from "@/lib/notify";
import { shortDuration, spokenDuration } from "@/lib/timecode";
import { REPEAT_CHOICES, removeItem } from "./actions";
import { SaveForm } from "./SaveForm";
import { countOf, deleteSaved, openSaved, useSaved } from "./saved";
import { totalLength, useQueue } from "./store";
import { usePlaylistUi } from "./ui";

const ROW_HEIGHT = 28;

/** The playlist's name, how much is in it, and the controls that act on all of it. */
function Header() {
  const name = useQueue((state) => state.name);
  const repeat = useQueue((state) => state.repeat);
  const shuffle = useQueue((state) => state.shuffle);
  const length = useQueue((state) => state.items.length);
  const total = useQueue((state) => {
    const { seconds, complete } = totalLength(state);
    // Shown only once every length is known: until then it would be a total of some of them.
    return complete && seconds > 0 ? Math.round(seconds) : null;
  });
  const saving = usePlaylistUi((state) => state.saving);
  const renaming = usePlaylistUi((state) => state.renaming);
  const saved = useSaved((state) => state.entries);
  // The saved playlist this is, if it is one: the one that can be renamed and deleted from here.
  const kept = name === null ? undefined : saved.find((playlist) => playlist.name === name);

  const summary = total === null ? countOf(length) : `${countOf(length)} · ${shortDuration(total)}`;
  return (
    <div className="flex flex-none items-center gap-2 px-4 pb-2 pt-3">
      {/* As tall as two lines either way, so the list below does not move when a name arrives. */}
      <div className="flex min-h-10 min-w-0 flex-1 flex-col justify-center">
        {/* Its name if it has one; else the tab's, as every tab is headed (DESIGN.md §7). */}
        <h2 className="flex min-w-0 text-heading text-ink-1">
          <MiddleTruncate text={name ?? "Playlist"} />
        </h2>
        <p className="tabular truncate text-caption text-ink-2">{summary}</p>
      </div>
      {/* Three controls of one height, 4 px apart; they never shrink, the name does. */}
      <div className="-mr-2 flex flex-none items-center gap-1">
        <ActionButton action="playlist.shuffle" pressed={shuffle}>
          <Shuffle />
        </ActionButton>
        <ActionButton
          action="playlist.repeat"
          // Named for what it is; which of its three states it is in is the second line.
          detail={REPEAT_CHOICES.find((choice) => choice.value === repeat)?.name ?? ""}
          pressed={repeat !== "off"}
        >
          {repeat === "one" ? <Repeat1 /> : <Repeat />}
        </ActionButton>
        <SaveForm open={saving || renaming !== null} renaming={renaming}>
          <PopoverAnchor asChild>
            <span className="flex flex-none">
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label="Playlist menu">
                    <Ellipsis />
                  </IconButton>
                </MenuTrigger>
                <MenuContent
                  align="end"
                  // The menu gives focus back to its button as it closes. When
                  // an item has just opened the form, that would take the
                  // focus out of the form, which would then close.
                  keepFocus={() => {
                    const ui = usePlaylistUi.getState();
                    return ui.saving || ui.renaming !== null;
                  }}
                >
                  <MenuAction action="file.add" label="Add files…" />
                  <MenuAction action="playlist.save" label="Save as…" />
                  {/* One level: choosing a name opens it. */}
                  <MenuSub label="Open playlist" disabled={saved.length === 0}>
                    {saved.map((playlist) => (
                      <MenuItem
                        key={playlist.id}
                        detail={countOf(playlist.count)}
                        onSelect={() => openSaved(playlist)}
                      >
                        {playlist.name}
                      </MenuItem>
                    ))}
                  </MenuSub>
                  {kept ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onSelect={() => usePlaylistUi.getState().setRenaming(kept)}>
                        Rename…
                      </MenuItem>
                      <MenuItem danger onSelect={() => deleteSaved(kept)}>
                        Delete “{kept.name}”
                      </MenuItem>
                    </>
                  ) : null}
                  <MenuSeparator />
                  <MenuAction action="playlist.clear" label="Clear" />
                </MenuContent>
              </Menu>
            </span>
          </PopoverAnchor>
        </SaveForm>
      </div>
    </div>
  );
}

/** What a row shows of an item: its place or the lamp, its name, its length or why it would not play. */
function Cells({
  item,
  index,
  digits,
  current,
  removable,
}: {
  item: QueueItem;
  index: number;
  /** How many figures the longest place in the list has. */
  digits: number;
  current: boolean;
  /** Under the pointer the length gives way to the control that removes the row. */
  removable: boolean;
}) {
  return (
    <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 px-2">
      {/*
        The place in the list, in a column as wide as the longest place
        needs; for the one playing, the lamp, at the column's leading edge,
        where every list has it (DESIGN.md §7, "List row").
      */}
      <span
        className="tabular relative flex h-4 flex-none items-center justify-end text-caption text-ink-3"
        style={{ width: `${digits}ch` }}
      >
        {current ? (
          <span data-lamp="" className="needle absolute left-0 h-3 w-0.5 rounded-xs" />
        ) : (
          index + 1
        )}
      </span>
      <MiddleTruncate
        text={item.title}
        full={nameOf(item.source)}
        className={cn(
          "flex-1",
          current && "font-semibold",
          // One that would not play steps back until it does.
          item.failed === null ? "text-ink-1" : "text-ink-3",
        )}
      />
      {/*
        Under the pointer what is here gives way to the control that removes
        the row, without giving up its room: the name beside it is cut to fit
        that room, and must not be cut differently because it is pointed at.
      */}
      <span className="relative flex h-7 min-w-14 flex-none items-center justify-end">
        {item.failed !== null ? (
          <span
            className={cn(
              "whitespace-nowrap text-caption text-ink-3",
              removable && "group-hover/row:invisible",
            )}
          >
            {failedLabel(item.failed)}
          </span>
        ) : item.duration === null ? null : (
          <Timecode
            seconds={item.duration}
            className={cn("text-caption text-ink-2", removable && "group-hover/row:invisible")}
          />
        )}
        {removable ? (
          /*
            A convenience for the pointer only. An option may not hold a
            control of its own, so this is not one: from the keyboard,
            Delete removes the selected row, and the row's menu has it too.
          */
          <Tooltip label="Remove from playlist">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
            <span
              data-remove=""
              onClick={(event) => {
                event.stopPropagation();
                removeItem(item);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              className="absolute right-0 top-1/2 hidden size-6 -translate-y-1/2 items-center justify-center rounded-sm text-ink-2 hover:bg-surface-4 hover:text-ink-1 group-hover/row:flex [&_svg]:size-3.5"
            >
              <X />
            </span>
          </Tooltip>
        ) : null}
      </span>
    </span>
  );
}

interface RowProps {
  item: QueueItem;
  index: number;
  digits: number;
  current: boolean;
  option: OptionProps;
  dragging: boolean;
}

/** One item of the playlist: where it is in the list, what it is, how long it runs. */
function Row({ item, index, digits, current, option, dragging }: RowProps) {
  const drag = useDraggable({ id: item.id });
  const drop = useDroppable({ id: item.id });
  const local = !item.source.includes("://");
  return (
    <ContextMenuArea
      menu={
        <>
          <MenuItem onSelect={() => send("play that", commands.playlistPlay(item.id))}>
            {current ? "Play from the beginning" : "Play"}
          </MenuItem>
          {local ? (
            <MenuItem
              onSelect={() =>
                send("show that in the Finder", commands.filesShowInFinder(item.source))
              }
            >
              Show in Finder
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onSelect={() => removeItem(item)}>Remove from playlist</MenuItem>
        </>
      }
    >
      <div
        {...option}
        ref={(node) => {
          drag.setNodeRef(node);
          drop.setNodeRef(node);
        }}
        {...drag.listeners}
        className={cn(option.className, "group/row", dragging && "opacity-45")}
      >
        {/*
          What a screen reader calls the row is what the row shows, as one
          sentence, with words where the eye gets figures: its place, its
          name, its length, and that it is playing. The cells themselves are
          for the eye.
        */}
        <span className="sr-only">
          {[
            `${index + 1}`,
            item.title,
            item.duration === null ? null : spokenDuration(item.duration),
            current ? "playing" : null,
            item.failed === null ? null : `would not play: ${failedLabel(item.failed)}`,
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
        <Cells item={item} index={index} digits={digits} current={current} removable />
      </div>
    </ContextMenuArea>
  );
}

/** The 2 px accent line that shows where a dragged row, or dropped files, would go. */
function InsertionLine({ index }: { index: number }) {
  return (
    <div
      aria-hidden="true"
      data-insertion=""
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-accent"
      style={{ transform: `translateY(${index * ROW_HEIGHT - 1}px)` }}
    />
  );
}

/**
 * The Playlist tab: the queue (DESIGN.md §7, "Playlist"). A click selects, a
 * double-click or Return plays, Delete removes, a drag reorders.
 */
export function PlaylistPanel() {
  const items = useQueue((state) => state.items);
  const current = useQueue((state) => state.current);
  const selected = usePlaylistUi((state) => state.selected);
  const select = usePlaylistUi((state) => state.select);
  const dropIndex = usePlaylistUi((state) => state.dropIndex);

  const list = useRef<ListBoxHandle>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  // A press becomes a drag only once it has travelled, so clicks stay clicks.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Files dragged in from the Finder are added where they are dropped.
  useEffect(() => {
    const element = list.current?.element;
    if (!element) {
      return;
    }
    return registerPlaylistDropZone({
      element,
      indexAt: (clientY) => list.current?.indexAt(clientY) ?? 0,
    });
  }, []);

  function place(event: DragMoveEvent | DragEndEvent): number | null {
    const rect = event.active.rect.current.translated;
    if (!rect) {
      return null;
    }
    return list.current?.indexAt(rect.top + rect.height / 2) ?? null;
  }

  function onDragEnd(event: DragEndEvent) {
    const to = place(event);
    const from = items.findIndex((item) => item.id === event.active.id);
    setDragged(null);
    setTarget(null);
    if (to === null || from < 0) {
      return;
    }
    // Taking the row out moves everything after it up by one.
    const index = to > from ? to - 1 : to;
    if (index !== from) {
      send("move that", commands.playlistMove(Number(event.active.id), index));
    }
  }

  function move(item: QueueItem, index: number) {
    send("move that", commands.playlistMove(item.id, index));
  }

  const line = dragged !== null ? target : dropIndex;
  const held = items.find((item) => item.id === dragged);
  const digits = String(items.length).length;
  const surfaceClass = useSurfaceClass();

  return (
    <>
      <Header />
      <DndContext
        sensors={sensors}
        onDragStart={(event) => {
          setDragged(Number(event.active.id));
          select(Number(event.active.id));
        }}
        onDragMove={(event) => setTarget(place(event))}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragged(null);
          setTarget(null);
        }}
      >
        <ListBox
          handle={list}
          label="Playlist"
          items={items}
          getId={(item) => item.id}
          rowHeight={ROW_HEIGHT}
          selected={selected}
          onSelect={select}
          onActivate={(item) => send("play that", commands.playlistPlay(item.id))}
          onRemove={removeItem}
          onMove={move}
          current={current}
          className="pb-2"
          renderRow={() => null}
          renderOption={(item, state, option) => (
            <Row
              item={item}
              index={state.index}
              digits={digits}
              current={item.id === current}
              option={option}
              dragging={item.id === dragged}
            />
          )}
          overlay={line === null ? null : <InsertionLine index={line} />}
        />
        {/*
          The row that is lifted, under the pointer. It is put in the body:
          it is placed by fixed position, and inside the panel that would be
          measured from the panel, not the window.
        */}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {held ? (
              <div
                data-lifted=""
                className={cn(
                  surfaceClass,
                  "flex size-full items-center rounded-sm border border-line bg-surface-3 text-body text-ink-1 shadow-pop",
                )}
              >
                <Cells
                  item={held}
                  index={items.indexOf(held)}
                  digits={digits}
                  current={held.id === current}
                  removable={false}
                />
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}
