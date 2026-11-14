import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { Picker, PickerRow } from "./picker";

const CHANNELS = [
  { value: "auto", name: "Automatic", detail: "As the device has" },
  { value: "stereo", name: "Stereo" },
  { value: "surround51", name: "5.1" },
] as const;

type Channels = (typeof CHANNELS)[number]["value"];

/**
 * "Channels: Stereo". jsdom joins the words of the hidden label and the
 * choice without the space between them, which a browser keeps.
 */
function named(label: string, choice: string): RegExp {
  return new RegExp(`^${label}:\\s?${choice.replace(/[.]/g, "\\.")}$`);
}

describe("Picker", () => {
  it("shows the present choice, and is named for what it chooses and what is chosen", () => {
    renderUi(
      <Picker<Channels> label="Channels" value="stereo" options={CHANNELS} onChange={() => {}} />,
    );
    const button = screen.getByRole("button", { name: named("Channels", "Stereo") });
    expect(button).toHaveClass("h-7", "min-w-0", "max-w-full");
    expect(button.querySelector(".truncate")).toHaveTextContent("Stereo");
    // The chevron never shrinks.
    expect(button.querySelector("svg")).toHaveClass("flex-none", "text-ink-3");
  });

  it("opens a menu of the choices with the present one checked", async () => {
    renderUi(
      <Picker<Channels> label="Channels" value="stereo" options={CHANNELS} onChange={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: named("Channels", "Stereo") }));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "AutomaticAs the device has",
      "Stereo",
      "5.1",
    ]);
    expect(screen.getByRole("menuitemradio", { name: /Stereo/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: /Automatic/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // Aligned to the button's trailing edge.
    expect(screen.getByRole("menu")).toHaveAttribute("data-align", "end");
  });

  it("says what was chosen", async () => {
    const onChange = vi.fn();
    renderUi(
      <Picker<Channels> label="Channels" value="stereo" options={CHANNELS} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: named("Channels", "Stereo") }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "5.1" }));
    expect(onChange).toHaveBeenCalledWith("surround51");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows its placeholder when the value is none of the choices", async () => {
    renderUi(
      <Picker
        label="Device"
        value="gone"
        placeholder="Not connected"
        options={[{ value: "system", name: "System default" }]}
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: named("Device", "Not connected") }));
    expect(screen.getByRole("menuitemradio", { name: "System default" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("does not open when disabled", async () => {
    renderUi(
      <Picker<Channels>
        label="Channels"
        value="auto"
        options={CHANNELS}
        disabled
        onChange={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: named("Channels", "Automatic") });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("PickerRow", () => {
  it("is its name in the names' column, then the picker at the trailing end", () => {
    renderUi(
      <PickerRow<Channels> label="Channels" value="auto" options={CHANNELS} onChange={() => {}} />,
    );
    const name = screen.getByText("Channels", { selector: "span.w-28" });
    expect(name).toHaveClass("w-28", "flex-none", "truncate");
    const row = name.parentElement;
    expect(row).toHaveClass("flex", "h-8", "items-center", "gap-3");
    const room = row?.lastElementChild;
    expect(room).toHaveClass("min-w-0", "flex-1", "justify-end");
    expect(room?.firstElementChild).toBe(
      screen.getByRole("button", { name: named("Channels", "Automatic") }),
    );
  });

  it("can be named apart from the picker's own label", () => {
    renderUi(
      <PickerRow<Channels>
        name="Speakers"
        label="Channels"
        value="auto"
        options={CHANNELS}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Speakers")).toHaveClass("w-28");
    expect(
      screen.getByRole("button", { name: named("Channels", "Automatic") }),
    ).toBeInTheDocument();
  });
});
