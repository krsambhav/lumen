import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActions, registerActions } from "@/actions/registry";
import { renderUi } from "@/test/render";
import {
  ContextMenuArea,
  Menu,
  MenuAction,
  MenuChoice,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuTrigger,
} from "./menu";

afterEach(() => {
  clearActions();
});

describe("Menu", () => {
  it("opens from its trigger, runs the item chosen and closes", async () => {
    const chosen = vi.fn();
    renderUi(
      <Menu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={chosen}>Add files…</MenuItem>
          <MenuSeparator />
          <MenuItem disabled>Clear</MenuItem>
        </MenuContent>
      </Menu>,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Clear" })).toHaveAttribute("data-disabled");

    await userEvent.click(screen.getByRole("menuitem", { name: "Add files…" }));
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows a shortcut or a short value at the trailing edge", async () => {
    renderUi(
      <Menu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent>
          <MenuItem shortcut="Shift+Cmd+p">Show playlist</MenuItem>
          <MenuItem detail="12 items">Open</MenuItem>
        </MenuContent>
      </Menu>,
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: /Show playlist/ })).toHaveTextContent(
      "Shift Command P",
    );
    expect(screen.getByRole("menuitem", { name: /Open/ })).toHaveTextContent("12 items");
  });

  it("keeps the check's column on every item of a menu that has a checked one", async () => {
    renderUi(
      <Menu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent checkable>
          <MenuItem checked onSelect={() => {}}>
            Shuffle
          </MenuItem>
          <MenuItem>Go to time…</MenuItem>
        </MenuContent>
      </Menu>,
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const shuffle = screen.getByRole("menuitemcheckbox", { name: "Shuffle" });
    expect(shuffle).toHaveAttribute("aria-checked", "true");
    // The plain item has the same empty column, so the two names line up.
    const plain = screen.getByRole("menuitem", { name: "Go to time…" });
    expect(plain.firstElementChild).toHaveClass("size-4");
    expect(shuffle.firstElementChild).toHaveClass("size-4");
  });

  it("opens a submenu to the side from its item", async () => {
    renderUi(
      <Menu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent>
          <MenuSub label="Speed">
            <MenuItem>Normal</MenuItem>
          </MenuSub>
        </MenuContent>
      </Menu>,
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const speed = screen.getByRole("menuitem", { name: "Speed" });
    expect(speed).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.click(speed);
    expect(screen.getByRole("menuitem", { name: "Normal" })).toBeInTheDocument();
  });
});

describe("MenuAction", () => {
  it("takes its name, shortcut, tick and availability from the registry", async () => {
    const run = vi.fn();
    let on = false;
    registerActions([
      {
        id: "playlist.shuffle",
        name: "Shuffle",
        category: "playback",
        shortcuts: ["s"],
        checked: () => on,
        run,
      },
      {
        id: "playlist.next",
        name: "Next item",
        category: "playback",
        shortcuts: ["Cmd+Right"],
        unavailable: () => "This is the last item",
        run,
      },
    ]);
    on = true;
    renderUi(
      <Menu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent checkable>
          <MenuAction action="playlist.shuffle" />
          <MenuAction action="playlist.next" />
          <MenuAction action="no.such.action" />
        </MenuContent>
      </Menu>,
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const shuffle = screen.getByRole("menuitemcheckbox", { name: /Shuffle/ });
    expect(shuffle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitem", { name: /Next item/ })).toHaveAttribute("data-disabled");
    // An action that is not registered is not shown at all.
    expect(screen.getByRole("menu").children).toHaveLength(2);

    await userEvent.click(shuffle);
    expect(run).toHaveBeenCalledWith({ source: "menu" });
  });
});

describe("MenuChoice", () => {
  it("marks the one chosen and reports another", async () => {
    const changed = vi.fn();
    renderUi(
      <Menu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent checkable>
          <MenuChoice
            label="Repeat"
            value="all"
            options={[
              { value: "off", name: "Off" },
              { value: "all", name: "All" },
            ]}
            onChange={changed}
          />
        </MenuContent>
      </Menu>,
    );
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemradio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));
    expect(changed).toHaveBeenCalledWith("off");
  });
});

describe("ContextMenuArea", () => {
  it("opens its menu on a secondary click", async () => {
    const removed = vi.fn();
    renderUi(
      <ContextMenuArea menu={<MenuItem onSelect={removed}>Remove from playlist</MenuItem>}>
        <div>Episode 1.mkv</div>
      </ContextMenuArea>,
    );
    fireEvent.contextMenu(screen.getByText("Episode 1.mkv"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from playlist" }));
    expect(removed).toHaveBeenCalledTimes(1);
  });
});
