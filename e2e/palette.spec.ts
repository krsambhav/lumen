import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import {
  box,
  calls,
  contrast,
  GUTTER,
  openFilm,
  openHome,
  openQueue,
  osdLabel,
  settle,
  test,
  WCAG,
} from "./support";

async function openPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await settle(page);
  return palette;
}

test.describe("the command palette", () => {
  test("opens in the upper third, 600 px wide and centred, with its field ready", async ({
    page,
  }) => {
    await openFilm(page);
    const palette = await box(await openPalette(page));
    expect(palette.width).toBe(600);
    expect(Math.abs(palette.x + palette.width / 2 - 560)).toBeLessThanOrEqual(0.5);
    expect(Math.round(palette.y)).toBe(Math.round(680 * 0.18));
    expect(palette.y + palette.height).toBeLessThan(680 - GUTTER);
    await expect(page.getByRole("combobox")).toBeFocused();
  });

  test("lays each row out as icon, name and shortcut, with the first one chosen", async ({
    page,
  }) => {
    await openFilm(page);
    const palette = await openPalette(page);
    const first = page.getByRole("option").first();
    await expect(first).toHaveAttribute("aria-selected", "true");
    const row = await box(first);
    const paletteBox = await box(palette);
    expect(row.height).toBe(36);
    // 4 px inside the palette's edge (which is 1 px), on both sides.
    expect(row.x).toBe(paletteBox.x + 1 + 4);
    expect(Math.round(row.x + row.width)).toBe(Math.round(paletteBox.x + paletteBox.width - 1 - 4));

    const cells = first.locator(":scope > *");
    const icon = await box(cells.nth(0));
    const name = await box(cells.nth(1));
    const shortcut = await box(cells.nth(2));
    expect(icon.width).toBe(16);
    expect(name.x - (icon.x + icon.width)).toBe(12);
    expect(shortcut.x).toBeGreaterThanOrEqual(name.x + name.width + 12 - 0.5);
    expect(Math.round(shortcut.x + shortcut.width)).toBe(Math.round(row.x + row.width - 12));
    // The input's text starts on the same line as the names below it.
    const input = await box(page.getByRole("combobox"));
    expect(Math.round(input.x)).toBe(Math.round(name.x));
  });

  test("finds what is typed and runs it on Return", async ({ page }) => {
    await openFilm(page);
    await openPalette(page);
    await page.keyboard.type("mute");
    // The best answer leads and is the one Return will run; "1 minute" also has those letters in order.
    const first = page.getByRole("option").first();
    await expect(first).toHaveText(/^Mute/);
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await calls(page, "playerSetMuted")).toEqual([{ muted: true }]);
    // What was typed into the palette was typed: it did not also mute by its letter.
    expect(await calls(page, "playerSetMuted")).toHaveLength(1);
    // Run from the palette, it is confirmed on screen.
    await expect(osdLabel(page, "Muted")).toBeVisible();
  });

  test("lists what was used lately first, the next time it opens", async ({ page }) => {
    await openFilm(page);
    await openPalette(page);
    await page.keyboard.type("mute");
    await expect(page.getByRole("option").first()).toHaveText(/^Mute/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openPalette(page);
    await expect(page.getByText("Recently used")).toBeVisible();
    // Under the name it has now: the sound is off, so it would turn it on.
    await expect(page.getByRole("option").first()).toHaveText(/^Unmute/);
  });

  test("keeps the keys that move through text for its field", async ({ page }) => {
    await openQueue(page);
    await openPalette(page);
    await page.keyboard.type("night");
    // Command with an arrow goes to the end of what is typed, not to the next item.
    await page.keyboard.press("Meta+ArrowLeft");
    await page.keyboard.press("Meta+ArrowRight");
    expect(await calls(page, "playlistNext")).toHaveLength(0);
    expect(await calls(page, "playlistPrevious")).toHaveLength(0);
    await expect(page.getByRole("combobox")).toHaveValue("night");
    // And the plain arrows move through the rows, not the film or the volume.
    await page.keyboard.press("ArrowDown");
    expect(await calls(page, "playerSetVolume")).toHaveLength(0);
  });

  test("finds an item of the playlist and plays it", async ({ page }) => {
    await openQueue(page);
    await openPalette(page);
    await page.keyboard.type("night passage");
    await expect(page.getByText("Playlist", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Night Passage/);
  });

  test("goes to a time that is typed, and opens for that alone on its own key", async ({
    page,
  }) => {
    await openFilm(page);
    await page.keyboard.press("Meta+j");
    const palette = page.getByRole("dialog", { name: "Go to time" });
    await expect(palette).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.keyboard.type("1:30:00");
    await expect(page.getByRole("option", { name: "Go to 1:30:00" })).toBeVisible();
    await page.keyboard.press("Enter");
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 5400, exact: true });
    await expect(palette).toHaveCount(0);
  });

  test("closes on Escape, on its own key again, and on a click outside it", async ({ page }) => {
    await openFilm(page);
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openPalette(page);
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openPalette(page);
    await page.mouse.click(60, 400);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The click that closed it did not also pause the film.
    expect(await calls(page, "playerTogglePaused")).toHaveLength(0);
  });

  test("has the toasts step out of sight while it is open, and gives them back", async ({
    page,
  }) => {
    await openHome(page);
    // A playlist opens with a toast that says so, bottom left, where the palette's corner would reach.
    await page.evaluate(
      (list) => window.__lumenMock?.openQueue(list, { paused: true, at: 600 }),
      [
        "/Users/me/Series/The Crossing S01E01 Departures.mkv",
        "/Users/me/Series/The Crossing S01E02 The Ferryman.mkv",
      ],
    );
    const toast = page.getByText("2 items in the playlist");
    await expect(toast).toBeVisible();
    const palette = await openPalette(page);
    await expect(toast).toBeHidden();
    // Nothing of a toast can be clicked through the palette either.
    await expect(page.getByRole("button", { name: "Show playlist" })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(toast).toBeVisible();
  });

  /** The row Return would run: the one the palette has chosen. */
  async function chosen(page: import("@playwright/test").Page): Promise<string> {
    const row = page.locator('[role="option"][aria-selected="true"]');
    await expect(row).toHaveCount(1);
    return (await row.locator(".truncate").first().textContent()) ?? "";
  }

  test("chooses the best thing that can be done for what is typed, whatever kind it is", async ({
    page,
  }) => {
    await openQueue(page);
    await page.evaluate(() => {
      window.__lumenMock?.seedPlaylist("Friday night", ["/a.mkv", "/b.mkv"]);
    });
    await openPalette(page);
    const field = page.getByRole("combobox");

    // The word for a kind of thing: a step of it first, every one of the kind under it.
    await field.fill("speed");
    expect(await chosen(page)).toBe("Faster");
    await expect(page.getByRole("option", { name: /^Speed 0\.25×/ })).toBeVisible();
    // A figure is taken as typed.
    await field.fill("1.5");
    expect(await chosen(page)).toBe("Speed 1.5×");
    // A saved playlist, not an action that has those letters somewhere in it.
    await field.fill("fri");
    expect(await chosen(page)).toBe("Friday night");
    // An item of the playlist by a word from the middle of its name.
    await field.fill("ferry");
    expect(await chosen(page)).toBe("The Crossing S01E02 The Ferryman");
    // The other words people use.
    await field.fill("loop");
    expect(await chosen(page)).toBe("Repeat");
    await field.fill("louder");
    expect(await chosen(page)).toBe("Volume up");
    // The beginnings of its words.
    await field.fill("shp");
    expect(await chosen(page)).toBe("Show playlist");
    // The name it has now.
    await field.fill("full");
    expect(await chosen(page)).toBe("Enter full screen");
    await expect(page.getByRole("option", { name: /Exit full screen/ })).toHaveCount(0);
    // Nothing found by letters scattered through a name.
    await field.fill("mute");
    await expect(page.getByRole("option")).toHaveCount(1);
    await field.fill("delete");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(page.getByText("Nothing matches “delete”.")).toBeVisible();
  });

  test("sinks what cannot be done below what can, and never chooses it", async ({ page }) => {
    await openQueue(page);
    await openPalette(page);
    // On the first item there is no previous one; at normal speed there is nothing to reset.
    await page.getByRole("combobox").fill("previous");
    const rows = page.getByRole("option");
    await expect(rows.first()).toHaveText(/^Previous frame/);
    await expect(page.getByRole("option", { name: /Previous item/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const names = await rows.evaluateAll((all) =>
      all.map((row) => [row.querySelector(".truncate")?.textContent, row.ariaDisabled === "true"]),
    );
    const firstDimmed = names.findIndex(([, dimmed]) => dimmed);
    expect(names.slice(firstDimmed).every(([, dimmed]) => dimmed)).toBe(true);
  });

  test("knows what has been played since the home screen was last seen, and leaves out what is open", async ({
    page,
  }) => {
    await openFilm(page);
    // Another film is opened over the first, as a drop on the window does:
    // the home screen is not seen in between.
    await page.evaluate(() =>
      window.__lumenMock?.open({
        source: "/Users/me/Films/Solaris (1972).mkv",
        duration: 9960,
        position: 0,
        paused: true,
      }),
    );
    await expect(page.getByRole("heading", { level: 1, name: "Solaris (1972)" })).toBeVisible();
    const palette = await openPalette(page);
    await expect(palette.getByText("Recently played", { exact: true })).toBeVisible();
    // The film before this one is the thing to go back to; this one is not.
    await expect(page.getByRole("option", { name: /The Long Take \(2019\)/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Solaris/ })).toHaveCount(0);
  });

  test("shows what is at hand before anything is typed, and only what can be done", async ({
    page,
  }) => {
    await page.goto("/#mock-history");
    await expect(page.getByRole("region", { name: "Recently played" })).toBeVisible();
    await page.evaluate(() => {
      window.__lumenMock?.seedPlaylist("Friday night", ["/a.mkv", "/b.mkv"]);
    });
    // (Saved behind the interface's back: the backend says so, and the palette has it.)
    await openPalette(page);
    await expect(page.getByRole("option", { name: /Friday night/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const palette = await openPalette(page);
    await expect(palette.getByText("Playlists", { exact: true })).toBeVisible();
    await expect(palette.getByText("Recently played", { exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: /Friday night/ })).toBeVisible();
    // Nothing is open: nothing here says so, because nothing that needs a film is listed.
    await expect(palette.getByText("Nothing is open")).toHaveCount(0);
    await expect(page.locator('[role="option"][aria-disabled="true"]')).toHaveCount(0);
    expect(await chosen(page)).toBe("Friday night");
  });

  test("takes a bare number both ways, and a step from here, when asked for a time alone", async ({
    page,
  }) => {
    await openFilm(page);
    await page.keyboard.press("Meta+j");
    const field = page.getByRole("combobox");
    await expect(field).toBeFocused();
    await field.fill("90");
    await expect(page.getByRole("option")).toHaveText(["Go to 1:30:00", "Go to 0:01:30"]);
    await field.fill("1h30");
    await expect(page.getByRole("option")).toHaveText(["Go to 1:30:00"]);
    await field.fill("+30");
    await expect(page.getByRole("option")).toHaveText(["Go to 0:42:47"]);
    await page.keyboard.press("Enter");
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 2567, exact: true });
  });

  test("works on the home screen too, where most actions wait for something to be open", async ({
    page,
  }) => {
    await openHome(page);
    await openPalette(page);
    await page.keyboard.type("play or");
    // Found by the name it is listed under, shown under the one it has now.
    const row = page.getByRole("option", { name: /^Play/ });
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await expect(row).toHaveText(/Nothing is open/);
  });

  test("writes its placeholder in tertiary ink, readable on the field in either theme", async ({
    page,
  }) => {
    await openHome(page);
    await openPalette(page);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      await settle(page);
      // No accessibility scan measures a placeholder; a reset stylesheet's
      // own grey for it once won over the token, at 2.4:1 on a light field.
      const colours = await page.getByRole("combobox").evaluate((input) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ink-3)";
        input.after(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        // The nearest thing behind the field that is filled in.
        let fill = "rgba(0, 0, 0, 0)";
        for (
          let behind: Element | null = input;
          behind && fill === "rgba(0, 0, 0, 0)";
          behind = behind.parentElement
        ) {
          fill = getComputedStyle(behind).backgroundColor;
        }
        return { placeholder: getComputedStyle(input, "::placeholder").color, ink, fill };
      });
      expect(colours.placeholder, theme).toBe(colours.ink);
      expect(await contrast(page, colours.placeholder, colours.fill), theme).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  test("has no WCAG A or AA violations, in either theme", async ({ page }) => {
    await openHome(page);
    await openPalette(page);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      await settle(page);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(
        results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`),
        theme,
      ).toEqual([]);
    }
  });
});

test.describe("the command palette in the smallest window", () => {
  test.use({ viewport: { width: 560, height: 360 } });

  test("keeps the window's gutters and stays on screen", async ({ page }) => {
    await openFilm(page);
    const palette = await box(await openPalette(page));
    expect(palette.x).toBe(GUTTER);
    expect(palette.width).toBe(560 - 2 * GUTTER);
    expect(palette.y + palette.height).toBeLessThanOrEqual(360 - 8);
    // A reason that is long gives way to the name beside it; nothing wraps.
    await page.keyboard.type("next item");
    const row = page.getByRole("option", { name: /Next item/ });
    expect((await box(row)).height).toBe(36);
    const cells = row.locator(":scope > *");
    const name = await box(cells.nth(1));
    const reason = await box(cells.nth(2));
    expect(reason.x).toBeGreaterThanOrEqual(name.x + name.width + 12 - 0.5);
    expect(name.width).toBeGreaterThan(60);
  });
});
