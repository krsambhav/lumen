import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { CUSTOM, PresetPicker } from "./PresetPicker";

const BUILT_IN = ["Flat", "Bass boost"];

function renderPicker(current: string | null, saved: string[] = ["Living room"]) {
  const handlers = { onChoose: vi.fn(), onSave: vi.fn(), onDelete: vi.fn() };
  renderUi(
    <PresetPicker
      label="Equaliser preset"
      current={current}
      builtIn={BUILT_IN}
      saved={saved}
      {...handlers}
    />,
  );
  return handlers;
}

/** The picker's button: named for what it chooses and what is chosen (jsdom drops the space). */
function trigger(choice: string) {
  return screen.getByRole("button", { name: new RegExp(`^Equaliser preset:\\s?${choice}$`) });
}

describe("PresetPicker", () => {
  it("shows the preset in use, or Custom when the values were set by hand", () => {
    renderPicker("Bass boost");
    expect(trigger("Bass boost")).toBeInTheDocument();
  });

  it("reads Custom for values that are nobody's preset", () => {
    renderPicker(null);
    expect(CUSTOM).toBe("Custom");
    expect(trigger("Custom")).toBeInTheDocument();
  });

  it("lists Lumen's presets, then the user's, with the one in use checked", async () => {
    renderPicker("Living room");
    await userEvent.click(trigger("Living room"));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Flat",
      "Bass boost",
      "Living room",
    ]);
    expect(screen.getByRole("menuitemradio", { name: "Living room" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Flat" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("checks nothing while the values are Custom", async () => {
    renderPicker(null);
    await userEvent.click(trigger("Custom"));
    for (const choice of screen.getAllByRole("menuitemradio")) {
      expect(choice).toHaveAttribute("aria-checked", "false");
    }
  });

  it("resets through its first choice, the neutral one", async () => {
    const { onChoose } = renderPicker(null);
    await userEvent.click(trigger("Custom"));
    await userEvent.click(screen.getAllByRole("menuitemradio")[0] as HTMLElement);
    expect(onChoose).toHaveBeenCalledWith("Flat");
  });

  it("saves only values set by hand", async () => {
    renderPicker("Bass boost");
    await userEvent.click(trigger("Bass boost"));
    expect(screen.getByRole("menuitem", { name: "Save as preset…" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("names a preset in a form, and saves it", async () => {
    const { onSave } = renderPicker(null);
    await userEvent.click(trigger("Custom"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Save as preset…" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(name, "Late films");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("Late films");
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("will not take the name of one of Lumen's own, and says it replaces a saved one", async () => {
    const { onSave } = renderPicker(null);
    await userEvent.click(trigger("Custom"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Save as preset…" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.type(name, "flat");
    expect(
      screen.getByText("“Flat” is one of Lumen’s own: choose another name."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, "living ROOM{Enter}");
    expect(onSave).toHaveBeenCalledWith("living ROOM");
  });

  it("offers to replace a saved preset of the same name", async () => {
    renderPicker(null);
    await userEvent.click(trigger("Custom"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Save as preset…" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Living room");
    expect(screen.getByText("Replaces the saved “Living room”.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
  });

  it("deletes a saved preset that is in use, and never one of Lumen's", async () => {
    const { onDelete } = renderPicker("Living room");
    await userEvent.click(trigger("Living room"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete “Living room”" }));
    expect(onDelete).toHaveBeenCalledWith("Living room");
  });

  it("offers no Delete for one of Lumen's own", async () => {
    renderPicker("Flat");
    await userEvent.click(trigger("Flat"));
    expect(screen.queryByRole("menuitem", { name: /Delete/ })).not.toBeInTheDocument();
  });
});
