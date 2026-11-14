import { clearMocks } from "@tauri-apps/api/mocks";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/boot";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { resetSettingsForTests, useSettings } from "@/features/settings/store";
import type { Settings, Shape } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { NEUTRAL_PICTURE } from "./picture";
import { OWN_SHAPE } from "./shape";
import { VideoPanel } from "./VideoPanel";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const settingsSet = vi.fn((_: { settings: Settings }) => null);
const playerSetShape = vi.fn((_: { shape: Shape }) => null);

function group(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The reading at the end of a scale's row. */
function reading(scale: string): HTMLElement {
  const row = screen.getByRole("slider", { name: scale }).closest(".h-8");
  const found = row?.querySelector<HTMLElement>("[data-reading]");
  if (!found) {
    throw new Error(`no reading for ${scale}`);
  }
  return found;
}

/** A picker's button, by what it chooses (jsdom drops the space after the colon). */
function picker(label: string, choice: string): HTMLElement {
  const escaped = choice.replace(/[.]/g, "\\.");
  return screen.getByRole("button", { name: new RegExp(`^${label}:\\s?${escaped}$`) });
}

function withPicture(
  picture: Partial<typeof NEUTRAL_PICTURE>,
  presets: Settings["video"]["presets"] = [],
) {
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      video: { picture: { ...NEUTRAL_PICTURE, ...picture }, presets },
    },
  });
}

beforeEach(() => {
  settingsSet.mockClear();
  playerSetShape.mockClear();
  mockCommands({ settingsSet, playerSetShape });
  resetSettingsForTests(DEFAULT_SETTINGS);
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/films/a.mkv",
    status: "paused",
    shape: OWN_SHAPE,
  });
});

afterEach(async () => {
  await flush();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  clearMocks();
});

describe("the Video tab", () => {
  it("is headed by its name, then the Picture and Frame groups", () => {
    renderUi(<VideoPanel />);
    expect(screen.getByRole("heading", { level: 2, name: "Video" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Picture", "Frame"]);
  });
});

describe("the Picture group", () => {
  it("has a scale for each level, reading neutral in tertiary ink", () => {
    renderUi(<VideoPanel />);
    const sliders = within(group("Picture")).getAllByRole("slider");
    expect(sliders.map((slider) => slider.getAttribute("aria-label"))).toEqual([
      "Brightness",
      "Contrast",
      "Saturation",
      "Gamma",
      "Hue",
      "Sharpness",
      "Noise reduction",
    ]);
    expect(reading("Brightness")).toHaveTextContent(/^0$/);
    expect(reading("Brightness")).toHaveClass("text-ink-3");
    expect(reading("Sharpness")).toHaveClass("text-ink-3");
  });

  it("reads a changed level with its sign, in full ink", () => {
    withPicture({ brightness: 12, hue: -30, sharpness: 40 });
    renderUi(<VideoPanel />);
    expect(reading("Brightness")).toHaveTextContent("+12");
    expect(reading("Brightness")).toHaveClass("text-ink-1");
    expect(reading("Hue")).toHaveTextContent("−30");
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveAttribute(
      "aria-valuetext",
      "minus 30",
    );
    // One-way levels have no sign.
    expect(reading("Sharpness")).toHaveTextContent(/^40$/);
    expect(reading("Contrast")).toHaveClass("text-ink-3");
  });

  it("lights two-way levels from 0 and one-way levels from their minimum", () => {
    renderUi(<VideoPanel />);
    const marked = (name: string) =>
      screen
        .getByRole("slider", { name })
        .parentElement?.closest("[data-orientation]")
        ?.querySelector("[data-level]");
    expect(marked("Brightness")).not.toBeNull();
    expect(marked("Sharpness")).toBeNull();
  });

  it("saves a level moved from the keyboard", async () => {
    renderUi(<VideoPanel />);
    screen.getByRole("slider", { name: "Contrast" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(useSettings.getState().settings.video.picture.contrast).toBe(1);
    expect(reading("Contrast")).toHaveTextContent("+1");
    await flush();
    expect(settingsSet).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({
        video: expect.objectContaining({ picture: { ...NEUTRAL_PICTURE, contrast: 1 } }),
      }),
    });
  });

  it("returns a level to 0 on a double-click on its needle", () => {
    withPicture({ gamma: 25 });
    renderUi(<VideoPanel />);
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Gamma" }));
    expect(useSettings.getState().settings.video.picture.gamma).toBe(0);
  });

  it("is reset through its preset picker, whose first choice is Neutral, and has no Reset of its own", async () => {
    withPicture({ brightness: 12 });
    renderUi(<VideoPanel />);
    expect(within(group("Picture")).queryByRole("button", { name: "Reset" })).toBeNull();
    await userEvent.click(picker("Picture preset", "Custom"));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices[0]).toHaveTextContent("Neutral");
    await userEvent.click(choices[0] as HTMLElement);
    expect(useSettings.getState().settings.video.picture).toEqual(NEUTRAL_PICTURE);
    expect(picker("Picture preset", "Neutral")).toBeInTheDocument();
  });

  it("reads Neutral while nothing is changed, and Custom once a level is", async () => {
    renderUi(<VideoPanel />);
    expect(picker("Picture preset", "Neutral")).toBeInTheDocument();
    screen.getByRole("slider", { name: "Saturation" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(picker("Picture preset", "Custom")).toBeInTheDocument();
  });

  it("names the levels after a saved preset, and applies one when it is chosen", async () => {
    const warm = { ...NEUTRAL_PICTURE, saturation: 20 };
    withPicture({}, [{ name: "Warm", picture: warm }]);
    renderUi(<VideoPanel />);
    await userEvent.click(picker("Picture preset", "Neutral"));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Warm" }));
    expect(useSettings.getState().settings.video.picture).toEqual(warm);
    expect(picker("Picture preset", "Warm")).toBeInTheDocument();
  });

  it("saves the levels set by hand under a name", async () => {
    withPicture({ contrast: 10 });
    renderUi(<VideoPanel />);
    await userEvent.click(picker("Picture preset", "Custom"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Save as preset…" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Projector{Enter}");
    expect(useSettings.getState().settings.video.presets).toEqual([
      { name: "Projector", picture: { ...NEUTRAL_PICTURE, contrast: 10 } },
    ]);
    expect(picker("Picture preset", "Projector")).toBeInTheDocument();
  });
});

describe("the Frame group", () => {
  it("shows Reset only when the frame differs from the file's own", () => {
    renderUi(<VideoPanel />);
    expect(within(group("Frame")).queryByRole("button", { name: "Reset" })).toBeNull();
    act(() => usePlayer.setState({ shape: { ...OWN_SHAPE, mirrored: true } }));
    expect(within(group("Frame")).getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("puts the frame back as the file has it from Reset", async () => {
    usePlayer.setState({ shape: { ...OWN_SHAPE, zoom: 2, turns: 1 } });
    renderUi(<VideoPanel />);
    await userEvent.click(within(group("Frame")).getByRole("button", { name: "Reset" }));
    expect(usePlayer.getState().shape).toEqual(OWN_SHAPE);
    await flush();
    expect(playerSetShape).toHaveBeenLastCalledWith({ shape: OWN_SHAPE });
    expect(within(group("Frame")).queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("picks an aspect from the usual ratios, Original first, with the present one checked", async () => {
    renderUi(<VideoPanel />);
    await userEvent.click(picker("Aspect", "Original"));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Original",
      "4:3",
      "16:10",
      "16:9",
      "1.85:1",
      "2:1",
      "2.35:1",
      "2.39:1",
    ]);
    expect(choices[0]).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "16:9" }));
    expect(usePlayer.getState().shape.aspect).toEqual({ width: 16, height: 9 });
    await flush();
    expect(playerSetShape).toHaveBeenLastCalledWith({
      shape: { ...OWN_SHAPE, aspect: { width: 16, height: 9 } },
    });
    await userEvent.click(picker("Aspect", "16:9"));
    expect(screen.getByRole("menuitemradio", { name: "16:9" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("crops to a ratio, None first", async () => {
    renderUi(<VideoPanel />);
    await userEvent.click(picker("Crop", "None"));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "2.39:1" }));
    expect(usePlayer.getState().shape.crop).toEqual({ width: 239, height: 100 });
    expect(picker("Crop", "2.39:1")).toBeInTheDocument();
  });

  it("shows an unusual ratio by its numbers", () => {
    usePlayer.setState({ shape: { ...OWN_SHAPE, aspect: { width: 5, height: 4 } } });
    renderUi(<VideoPanel />);
    expect(picker("Aspect", "5:4")).toBeInTheDocument();
  });

  it("reads the zoom as a percentage, neutral at 100%", () => {
    renderUi(<VideoPanel />);
    expect(reading("Zoom")).toHaveTextContent("100%");
    expect(reading("Zoom")).toHaveClass("text-ink-3");
    act(() => usePlayer.setState({ shape: { ...OWN_SHAPE, zoom: 1.5 } }));
    expect(reading("Zoom")).toHaveTextContent("150%");
    expect(reading("Zoom")).toHaveClass("text-ink-1");
    expect(screen.getByRole("slider", { name: "Zoom" })).toHaveAttribute(
      "aria-valuetext",
      "150 percent",
    );
  });

  it("zooms in twentieths from the keyboard", async () => {
    renderUi(<VideoPanel />);
    screen.getByRole("slider", { name: "Zoom" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(usePlayer.getState().shape.zoom).toBe(1.05);
  });

  it("turns, mirrors and flips from its buttons", async () => {
    renderUi(<VideoPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Rotate clockwise" }));
    expect(usePlayer.getState().shape.turns).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Rotate anticlockwise" }));
    await userEvent.click(screen.getByRole("button", { name: "Rotate anticlockwise" }));
    expect(usePlayer.getState().shape.turns).toBe(3);
    const mirror = screen.getByRole("button", { name: "Mirror" });
    expect(mirror).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(mirror);
    expect(usePlayer.getState().shape.mirrored).toBe(true);
    expect(screen.getByRole("button", { name: "Mirror" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Flip" }));
    expect(usePlayer.getState().shape.flipped).toBe(true);
  });

  it("deinterlaces off, automatically or always", async () => {
    renderUi(<VideoPanel />);
    await userEvent.click(picker("Deinterlace", "Off"));
    expect(screen.getAllByRole("menuitemradio").map((choice) => choice.textContent)).toEqual([
      "Off",
      "AutomaticWhen the file says it is interlaced",
      "On",
    ]);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Automatic/ }));
    expect(usePlayer.getState().shape.deinterlace).toBe("auto");
  });
});
