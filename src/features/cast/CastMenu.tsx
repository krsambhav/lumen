import { Airplay, Cast } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { useChromeHold } from "@/features/player/chrome";
import { hasMedia, usePlayer } from "@/features/player/store";
import { type CastDevice, commands } from "@/ipc";
import { send } from "@/lib/notify";
import { stopCasting } from "./actions";
import { isCasting, useCast } from "./store";

/** How long the menu says it is looking before it says nothing was found. */
export const LOOKING_MS = 6000;

/** Where an element is in the window, for the AirPlay picker to open from. */
type Anchor = () => DOMRect | undefined;

/** The devices worth offering for what is open: speakers only for sound. */
function useOffered(): CastDevice[] {
  const devices = useCast((state) => state.devices);
  const hasPicture = usePlayer((state) => state.video !== null);
  return devices.filter((device) => device.video || !hasPicture);
}

/** "Looking…" for a while after the menu opens with nothing found yet, then not. */
function useLooking(open: boolean, found: boolean): boolean {
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    if (!open || found) {
      setLooking(false);
      return;
    }
    setLooking(true);
    const timer = setTimeout(() => setLooking(false), LOOKING_MS);
    return () => clearTimeout(timer);
  }, [open, found]);
  return looking;
}

function deviceKind(device: CastDevice): string {
  return device.model.trim() || (device.video ? "Chromecast" : "Speaker");
}

/**
 * The menu's items: the Chromecasts found, AirPlay (whose devices macOS
 * lists in its own picker), and Stop while something is cast. In the cast
 * button's menu and, on a tight stage, in More.
 */
export function CastChoices({ open, anchor }: { open: boolean; anchor: Anchor }) {
  const offered = useOffered();
  const session = useCast((state) => state.session);
  const looking = useLooking(open, offered.length > 0);
  const castingTo = session?.protocol === "chromecast" ? session.device : null;

  const openAirPlay = () => {
    const box = anchor();
    if (box === undefined) {
      return;
    }
    send(
      "open AirPlay",
      commands.castAirplay({ x: box.x, y: box.y, width: box.width, height: box.height }),
    );
  };

  return (
    <>
      <MenuLabel>Chromecast</MenuLabel>
      {offered.map((device) => (
        <MenuItem
          key={device.id}
          checked={castingTo === device.name}
          detail={deviceKind(device)}
          onSelect={() => {
            if (castingTo !== device.name) {
              send(`cast to ${device.name}`, commands.castStart(device.id));
            }
          }}
        >
          {device.name}
        </MenuItem>
      ))}
      {offered.length === 0 ? (
        <MenuItem disabled>
          {looking ? "Looking for devices…" : "None found on this network"}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        checked={session?.protocol === "airPlay" && session.phase !== "choosing"}
        detail={
          session?.protocol === "airPlay" && session.phase !== "choosing"
            ? session.device
            : undefined
        }
        onSelect={openAirPlay}
      >
        AirPlay…
      </MenuItem>
      {session !== null && session.phase !== "choosing" ? (
        <>
          <MenuSeparator />
          <MenuItem onSelect={stopCasting}>Stop casting</MenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * The cast button in the transport row (DESIGN.md §7, "Cast"). Lit while a
 * film is on a TV; its tooltip says which.
 */
export function CastMenu() {
  const open = useCast((state) => state.menuOpen);
  const setOpen = useCast((state) => state.setMenuOpen);
  const session = useCast((state) => state.session);
  const media = usePlayer(hasMedia);
  const trigger = useRef<HTMLButtonElement>(null);
  useChromeHold("menu", open);

  // Devices are looked for once the menu is first wanted, not at launch: the
  // first search is when macOS asks about the local network.
  useEffect(() => {
    if (open) {
      void commands.castSearch();
    }
  }, [open]);

  const casting = isCasting({ session });
  const Icon = session?.protocol === "airPlay" ? Airplay : Cast;
  const detail =
    session === null || session.phase === "choosing"
      ? undefined
      : session.phase === "connecting"
        ? `Connecting to ${session.device}…`
        : `Playing on ${session.device}`;
  return (
    <Menu open={open && media} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <IconButton
          ref={trigger}
          label="Cast"
          shortcut="Alt+Cmd+c"
          detail={detail}
          pressed={casting}
          disabled={!media}
        >
          <Icon />
        </IconButton>
      </MenuTrigger>
      <MenuContent side="top" align="end" checkable>
        <CastChoices open={open} anchor={() => trigger.current?.getBoundingClientRect()} />
      </MenuContent>
    </Menu>
  );
}
