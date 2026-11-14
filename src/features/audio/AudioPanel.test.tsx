import { clearMocks } from "@tauri-apps/api/mocks";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/boot";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { resetSettingsForTests, useSettings } from "@/features/settings/store";
import type { AudioSettings, Settings, Track } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { AudioPanel } from "./AudioPanel";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const settingsSet = vi.fn((_: { settings: Settings }) => null);
const playerSelectTrack = vi.fn((_: { kind: string; id: number | null }) => null);
const playerSetAudioDelay = vi.fn((_: { seconds: number }) => null);

function audio(id: number, given: Partial<Track> = {}): Track {
  return {
    id,
    kind: "audio",
    title: null,
    language: null,
    codec: "aac",
    selected: false,
    default: false,
    forced: false,
    external: false,
    file: null,
    secondary: false,
    channels: 2,
    ...given,
  };
}

const TRACKS = [
  audio(1, { language: "eng", codec: "ac3", channels: 6, selected: true }),
  audio(2, { language: "eng", title: "Version française" }),
];

const DEVICES = [
  { id: "coreaudio/speakers", name: "MacBook Pro Speakers" },
  { id: "coreaudio/tv", name: "Living Room TV" },
];

function group(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function reading(scale: string): HTMLElement {
  const row = screen.getByRole("slider", { name: scale }).closest(".h-8");
  const found = row?.querySelector<HTMLElement>("[data-reading]");
  if (!found) {
    throw new Error(`no reading for ${scale}`);
  }
  return found;
}

function picker(label: string, choice: string): HTMLElement {
  const escaped = choice.replace(/[.]/g, "\\.");
  return screen.getByRole("button", { name: new RegExp(`^${label}:\\s?${escaped}$`) });
}

function withAudio(change: Partial<AudioSettings>) {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, audio: { ...DEFAULT_SETTINGS.audio, ...change } },
  });
}

const audioSettings = () => useSettings.getState().settings.audio;

beforeEach(() => {
  settingsSet.mockClear();
  playerSelectTrack.mockClear();
  playerSetAudioDelay.mockClear();
  mockCommands({ settingsSet, playerSelectTrack, playerSetAudioDelay });
  resetSettingsForTests(DEFAULT_SETTINGS);
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/films/a.mkv",
    status: "paused",
    tracks: TRACKS,
    audioDelay: 0,
    audioDevices: DEVICES,
  });
});

afterEach(async () => {
  await flush();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  clearMocks();
});

describe("the Audio tab", () => {
  it("is headed by its name, then the Track, Equaliser and Output groups", () => {
    renderUi(<AudioPanel />);
    expect(screen.getByRole("heading", { level: 2, name: "Audio" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Track", "Equaliser", "Output"]);
  });
});

describe("the Track group", () => {
  it("lists the file's sound by language and title, with the format", () => {
    renderUi(<AudioPanel />);
    const list = within(group("Track")).getByRole("radiogroup", { name: "Audio track" });
    expect(
      within(list)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["English, 5.1 · Dolby Digital", "English · Version française, Stereo · AAC"]);
    expect(within(list).getByRole("radio", { name: /5\.1/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("asks the player for the track chosen", async () => {
    renderUi(<AudioPanel />);
    await userEvent.click(screen.getByRole("radio", { name: /Version française/ }));
    await flush();
    expect(playerSelectTrack).toHaveBeenCalledWith({ kind: "audio", id: 2 });
  });

  it("reads the delay with its sign and unit, neutral at 0 ms", async () => {
    renderUi(<AudioPanel />);
    expect(reading("Delay")).toHaveTextContent("0 ms");
    expect(reading("Delay")).toHaveClass("text-ink-3");
    expect(screen.getByRole("slider", { name: "Delay" })).toHaveAttribute(
      "aria-valuetext",
      "no delay",
    );
    screen.getByRole("slider", { name: "Delay" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(reading("Delay")).toHaveTextContent("−10 ms");
    expect(reading("Delay")).toHaveClass("text-ink-1");
    await flush();
    expect(playerSetAudioDelay).toHaveBeenLastCalledWith({ seconds: -0.01 });
  });

  it("says when the file has no sound, and its delay cannot be moved", () => {
    usePlayer.setState({ tracks: [] });
    renderUi(<AudioPanel />);
    expect(screen.getByText("This file has no sound.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Audio track" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Delay" })).toHaveAttribute("data-disabled");
  });
});

describe("the Equaliser group", () => {
  it("carries the preset picker and the switch in its heading, and no Reset", () => {
    renderUi(<AudioPanel />);
    const heading = screen.getByRole("heading", { name: "Equaliser" }).parentElement as HTMLElement;
    expect(within(heading).getByRole("switch", { name: "Equaliser" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      within(heading).getByRole("button", { name: /^Equaliser preset:\s?Flat$/ }),
    ).toBeInTheDocument();
    expect(within(group("Equaliser")).queryByRole("button", { name: "Reset" })).toBeNull();
    // Switched off, the bands keep their places and step back.
    expect(screen.getByRole("slider", { name: "31 hertz" })).toHaveClass("bg-ink-3");
  });

  it("switches on and off, keeping its gains", async () => {
    withAudio({ equaliser: { enabled: false, gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] } });
    renderUi(<AudioPanel />);
    await userEvent.click(screen.getByRole("switch", { name: "Equaliser" }));
    expect(audioSettings().equaliser).toEqual({
      enabled: true,
      gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(screen.getByRole("slider", { name: "31 hertz" })).not.toHaveClass("bg-ink-3");
  });

  it("reads Custom once a band is moved by hand, and turns itself on", async () => {
    renderUi(<AudioPanel />);
    screen.getByRole("slider", { name: "1 kilohertz" }).focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(audioSettings().equaliser.enabled).toBe(true);
    expect(audioSettings().equaliser.gains[5]).toBe(0.5);
    expect(picker("Equaliser preset", "Custom")).toBeInTheDocument();
  });

  it("applies a preset, and is reset through Flat, its first choice", async () => {
    renderUi(<AudioPanel />);
    await userEvent.click(picker("Equaliser preset", "Flat"));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices[0]).toHaveTextContent("Flat");
    expect(choices[0]).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Bass boost" }));
    expect(audioSettings().equaliser).toEqual({
      enabled: true,
      gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    });
    expect(picker("Equaliser preset", "Bass boost")).toBeInTheDocument();

    await userEvent.click(picker("Equaliser preset", "Bass boost"));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Flat" }));
    expect(audioSettings().equaliser.gains).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("saves gains set by hand under a name", async () => {
    withAudio({ equaliser: { enabled: true, gains: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0] } });
    renderUi(<AudioPanel />);
    await userEvent.click(picker("Equaliser preset", "Custom"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Save as preset…" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Headphones{Enter}");
    expect(audioSettings().presets).toEqual([
      { name: "Headphones", gains: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0] },
    ]);
    expect(picker("Equaliser preset", "Headphones")).toBeInTheDocument();
  });

  it("deletes a saved preset in use, with Undo", async () => {
    const gains = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
    withAudio({ equaliser: { enabled: true, gains }, presets: [{ name: "Headphones", gains }] });
    renderUi(<AudioPanel />);
    await userEvent.click(picker("Equaliser preset", "Headphones"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete “Headphones”" }));
    expect(audioSettings().presets).toEqual([]);
    expect(picker("Equaliser preset", "Custom")).toBeInTheDocument();
  });

  it("says why it is not heard while Dolby and DTS are passed through", () => {
    withAudio({
      passthrough: true,
      equaliser: { enabled: true, gains: DEFAULT_SETTINGS.audio.equaliser.gains },
    });
    renderUi(<AudioPanel />);
    expect(
      screen.getByText("Not applied while Dolby and DTS are passed through."),
    ).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "31 hertz" })).toHaveClass("bg-ink-3");
  });
});

describe("the Output group", () => {
  it("sends sound to the system's device unless another is chosen", async () => {
    renderUi(<AudioPanel />);
    await userEvent.click(picker("Device", "System default"));
    expect(screen.getAllByRole("menuitemradio").map((choice) => choice.textContent)).toEqual([
      "System default",
      "MacBook Pro Speakers",
      "Living Room TV",
    ]);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Living Room TV" }));
    expect(audioSettings().device).toBe("coreaudio/tv");
    expect(picker("Device", "Living Room TV")).toBeInTheDocument();
  });

  it("says a chosen device is not connected", () => {
    withAudio({ device: "coreaudio/headphones" });
    renderUi(<AudioPanel />);
    expect(picker("Device", "Not connected")).toBeInTheDocument();
  });

  it("chooses the channels", async () => {
    renderUi(<AudioPanel />);
    await userEvent.click(picker("Channels", "Automatic"));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "5.1" }));
    expect(audioSettings().channels).toBe("surround51");
  });

  it("switches pass-through and the visualiser by a click on their names", async () => {
    renderUi(<AudioPanel />);
    expect(screen.getByRole("switch", { name: "Visualiser" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByText("Pass through Dolby and DTS"));
    expect(audioSettings().passthrough).toBe(true);
    await userEvent.click(screen.getByText("Visualiser"));
    expect(audioSettings().visualiser).toBe(false);
    await flush();
    expect(settingsSet).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({
        audio: expect.objectContaining({ passthrough: true, visualiser: false }),
      }),
    });
  });
});
