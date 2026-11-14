import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import {
  box,
  calls,
  contrast,
  EPISODES,
  GUTTER,
  glide,
  openFilm,
  openQueue,
  overlap,
  PANEL,
  settle,
  showPlaylist,
  tab,
  test,
  WCAG,
} from "./support";

const WIDTH = 1120 + PANEL;

test.describe("the panel beside the picture", () => {
  test.use({ viewport: { width: WIDTH, height: 630 } });

  test("takes its width from the window and none from the picture", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const panel = await box(page.getByRole("complementary", { name: "Panel" }));
    expect(panel.width).toBe(PANEL);
    expect(panel.x).toBe(WIDTH - PANEL);
    expect(panel.y).toBe(0);
    expect(panel.height).toBe(630);

    // The window is asked for exactly that much more room.
    expect(await calls(page, "windowSetPanelWidth")).toContainEqual({ width: PANEL });

    // The stage ends where the panel begins: its timeline keeps its gutters inside it.
    const timeline = await box(page.getByRole("slider", { name: "Position" }));
    expect(timeline.x).toBe(GUTTER);
    expect(Math.round(timeline.x + timeline.width)).toBe(WIDTH - PANEL - GUTTER);
    const full = await box(page.getByRole("button", { name: "Enter full screen" }));
    expect(Math.round(full.x + full.width - 9)).toBe(WIDTH - PANEL - GUTTER);
    // And the title is centred on the picture, not on the window.
    const title = await box(page.getByRole("heading", { level: 1 }));
    expect(Math.abs(title.x + title.width / 2 - (WIDTH - PANEL) / 2)).toBeLessThanOrEqual(0.5);
  });

  test("gives the room back when it closes, and when the film does", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    await page.getByRole("button", { name: "Hide panel" }).click();
    // It slides out first; the window gives its room back once it has gone.
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect
      .poll(async () => (await calls(page, "windowSetPanelWidth")).at(-1))
      .toEqual({ width: 0 });

    await showPlaylist(page);
    await page.keyboard.press("Meta+w");
    await expect(page.getByRole("heading", { name: "Drop a file to play" })).toBeVisible();
    expect((await calls(page, "windowSetPanelWidth")).at(-1)).toEqual({ width: 0 });
  });

  test("has a header as tall as the title bar, with its controls on one line", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const playlist = await box(page.getByRole("tab", { name: "Playlist" }));
    const chapters = await box(page.getByRole("tab", { name: "Chapters" }));
    const hide = await box(page.getByRole("button", { name: "Hide panel" }));
    const title = await box(page.getByRole("heading", { level: 1 }));

    // Tabs are label-sized, 4 px apart, and share a centre line with the stage's title and the close control.
    expect(chapters.x - (playlist.x + playlist.width)).toBe(4);
    const centre = (rect: { y: number; height: number }) => rect.y + rect.height / 2;
    expect(centre(playlist)).toBe(22);
    expect(centre(chapters)).toBe(22);
    expect(centre(hide)).toBe(22);
    expect(Math.abs(centre(title) - 22)).toBeLessThanOrEqual(1.5);
    // The close control is at the corner, inside the panel's padding.
    expect(Math.round(hide.x + hide.width)).toBe(WIDTH - 8);
    expect(hide.x).toBeGreaterThan(chapters.x + chapters.width);
    // Controls that share a row are one height.
    expect(playlist.height).toBe(hide.height);
    expect(chapters.height).toBe(hide.height);
    // The active tab's lamp lies on the header's bottom edge, as wide as its label.
    const lamp = await page.getByRole("tab", { name: "Playlist" }).evaluate((tab) => {
      const line = getComputedStyle(tab, "::after");
      const rect = tab.getBoundingClientRect();
      return {
        bottom: rect.bottom - Number.parseFloat(line.bottom),
        height: Number.parseFloat(line.height),
        lit: line.backgroundColor,
      };
    });
    expect(lamp.bottom).toBe(44);
    expect(lamp.height).toBe(2);
    expect(lamp.lit).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("has no WCAG A or AA violations, in either theme", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      // Colours cross-fade when the theme changes; what counts is where they end up.
      await settle(page);
      const results = await new AxeBuilder({ page })
        .withTags(WCAG)
        // The stage is transparent over a native video layer; its contrast is computed in unit tests.
        .exclude(".stage")
        .analyze();
      expect(
        results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`),
        theme,
      ).toEqual([]);
    }
  });
});

test.describe("the playlist", () => {
  test.use({ viewport: { width: WIDTH, height: 630 } });

  test("lines its rows up: number, name and length each in their own column", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const options = page.getByRole("option");
    await expect(options).toHaveCount(5);
    const rows = await Promise.all((await options.all()).map((option) => box(option)));
    const panel = await box(page.getByRole("complementary"));
    rows.forEach((row, index) => {
      expect(row.height).toBe(28);
      // 8 px in from each edge of the panel (its own left edge is a 1 px line).
      expect(row.x).toBe(panel.x + 1 + 8);
      expect(Math.round(row.x + row.width)).toBe(WIDTH - 8);
      if (index > 0) {
        expect(row.y).toBe((rows[index - 1]?.y ?? 0) + 28);
      }
    });

    // In every row the name ends before the length begins, however long the name.
    for (const option of await options.all()) {
      const cells = option.locator(":scope > span > *");
      const number = await box(cells.nth(0));
      const name = await box(cells.nth(1));
      const length = await box(cells.nth(2));
      // As wide as the longest place needs: one figure here.
      expect(number.width).toBeGreaterThan(6);
      expect(number.width).toBeLessThan(9);
      // 16 px in from the panel's edge, where every list has its lamp.
      expect(number.x).toBe(panel.x + 1 + 16);
      expect(length.width).toBe(56);
      expect(Math.round(name.x - (number.x + number.width))).toBe(8);
      expect(Math.round(length.x - (name.x + name.width))).toBe(8);
      expect(name.height).toBeLessThanOrEqual(20);
    }
  });

  test("cuts a long name in the middle, keeps its end, and offers the whole of it", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const long = page.getByRole("option", { name: /A Very Long Episode Title/ });
    const shown = long.locator('[data-part="fitted"]');
    // The end is where one episode differs from the next: its last ten characters stay.
    await expect(shown).toHaveText(/^The Crossing S01E03.*… On And On$/);
    const name = await box(shown);
    const row = await box(long);
    expect(name.x + name.width).toBeLessThanOrEqual(row.x + row.width - 56 - 8 - 8 + 0.5);
    await shown.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      /A Very Long Episode Title That Goes On And On\.mkv/,
    );
  });

  test("marks the one playing with the lamp where the others have their number", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const playing = page.getByRole("option", { name: /Departures.*playing/ });
    await expect(playing).toHaveAttribute("aria-current", "true");
    const lamp = await box(playing.locator("[data-lamp]"));
    const number = await box(page.getByRole("option").nth(1).getByText("2", { exact: true }));
    expect(lamp.width).toBe(2);
    expect(lamp.height).toBe(12);
    // At the leading edge of the column the numbers stand in, 16 px in from the panel's edge.
    const panel = await box(page.getByRole("complementary"));
    expect(lamp.x).toBe(panel.x + 1 + 16);
    expect(lamp.x).toBe(number.x);
    // Centred on the row's line.
    const row = await box(playing);
    expect(lamp.y + lamp.height / 2).toBe(row.y + 14);

    // And in the same place on the other tab, so it does not jump when the tab changes.
    await page.goto("/#mock-film");
    // Only the fragment changed, which does not load the page again by itself.
    await page.reload();
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    await page.keyboard.press("Meta+Shift+c");
    await expect(page.getByRole("listbox", { name: "Chapters" })).toBeVisible();
    await settle(page);
    const chapter = await box(page.locator('[role="option"][aria-current] [data-lamp]'));
    const other = await box(page.getByRole("complementary"));
    expect(chapter.x - other.x).toBe(lamp.x - panel.x);
  });

  test("leaves a length blank when it is not known, and totals only when all are", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    await expect(page.getByText("5 items", { exact: true })).toBeVisible();
    await expect(page.getByRole("option").nth(4)).not.toHaveText(/\d:\d\d/);
  });

  test("totals the lengths once every one of them is known", async ({ page }) => {
    await openQueue(page, EPISODES.slice(0, 4));
    await showPlaylist(page);
    await expect(page.getByText("4 items · 8 h 7 min")).toBeVisible();
  });

  test("shows the control that removes a row in place of its length, under the pointer", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const row = page.getByRole("option").nth(1);
    const remove = row.locator("[data-remove]");
    await expect(remove).toBeHidden();
    await row.hover();
    await expect(remove).toBeVisible();
    const control = await box(remove);
    const rowBox = await box(row);
    // Where the length was: at the end of the row, inside its padding, centred on its line.
    expect(Math.round(control.x + control.width)).toBe(Math.round(rowBox.x + rowBox.width - 8));
    expect(control.y + control.height / 2).toBe(rowBox.y + 14);
    await remove.click();
    expect(await calls(page, "playlistRemove")).toHaveLength(1);
    await expect(page.getByRole("option")).toHaveCount(4);
    // And it can be put back.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("option")).toHaveCount(5);
    await expect(page.getByRole("option").nth(1)).toHaveAccessibleName(/The Ferryman/);
  });

  test("keeps a selected row's place number readable on its fill, in both themes", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const fourth = page.getByRole("option", { name: /Night Passage/ });
    await fourth.click();
    await expect(fourth).toHaveAttribute("aria-selected", "true");
    for (const theme of ["dark", "light"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      await settle(page);
      // The cells are hidden from assistive technology (the row says them in
      // words), so an accessibility scan never looks at their colours.
      const colours = await fourth.evaluate((row) => {
        const place = Array.from(row.querySelectorAll("span")).find(
          (span) => span.textContent === "4",
        );
        if (!place) {
          throw new Error("the row shows no place number");
        }
        return { text: getComputedStyle(place).color, fill: getComputedStyle(row).backgroundColor };
      });
      expect(await contrast(page, colours.text, colours.fill), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("plays on a double-click, and a single click only selects", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const fourth = page.getByRole("option", { name: /Night Passage/ });
    await fourth.click();
    await expect(fourth).toHaveAttribute("aria-selected", "true");
    expect(await calls(page, "playlistPlay")).toHaveLength(0);
    await fourth.dblclick();
    expect(await calls(page, "playlistPlay")).toHaveLength(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Night Passage/);
    await expect(fourth).toHaveAttribute("aria-current", "true");
  });

  test("leaves the player's keys alone after a row is clicked", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    await page.getByRole("option", { name: /Night Passage/ }).click();
    await page.keyboard.press("Space");
    expect(await calls(page, "playerTogglePaused")).toHaveLength(1);
    await page.keyboard.press("ArrowUp");
    expect(await calls(page, "playerSetVolume")).toHaveLength(1);
    // Return and Delete are nobody's shortcut: they act on the row that was clicked.
    await page.keyboard.press("Delete");
    expect(await calls(page, "playlistRemove")).toHaveLength(1);
  });

  test("works from the keyboard: Tab in, arrows to choose, Return to play", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const list = page.getByRole("listbox", { name: "Playlist" });
    // Past the stage's controls and the panel's header to the list itself.
    for (let presses = 0; presses < 24; presses += 1) {
      if (await list.evaluate((element) => element === document.activeElement)) {
        break;
      }
      await tab(page);
    }
    // Opened from the keyboard, the panel has taken the keyboard to its list already.
    await expect(list).toBeFocused();
    // It starts on the one playing, and the ring is on that row, inside its
    // edge, not around the whole list.
    const chosen = page.getByRole("option", { selected: true });
    await expect(chosen).toHaveAccessibleName(/Departures/);
    await expect(list).toHaveCSS("outline-style", "none");
    await expect(chosen).toHaveCSS("outline-style", "solid");
    await expect(chosen).toHaveCSS("outline-offset", "-2px");
    await expect(chosen).toHaveCSS("outline-width", "2px");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    // The arrows moved the selection, not the volume.
    expect(await calls(page, "playerSetVolume")).toHaveLength(0);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/S01E03/);
    // Space is not the list's: the film still answers to it.
    await page.keyboard.press("Space");
    expect(await calls(page, "playerTogglePaused")).toHaveLength(1);

    // Option with an arrow carries the row.
    await page.keyboard.press("Alt+ArrowUp");
    expect(await calls(page, "playlistMove")).toHaveLength(1);
    await expect(page.getByRole("option").nth(1)).toHaveAccessibleName(/S01E03/);
  });

  test("reorders by dragging, showing where the row will land", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const first = await box(page.getByRole("option").nth(0));
    const fourth = await box(page.getByRole("option").nth(3));
    await page.mouse.move(first.x + 120, first.y + 14);
    await page.mouse.down();
    await page.mouse.move(first.x + 120, first.y + 30, { steps: 4 });
    await page.mouse.move(fourth.x + 120, fourth.y + 20, { steps: 8 });

    // A 2 px accent line between the fourth row and the fifth.
    const line = await box(page.locator("[data-insertion]"));
    expect(line.height).toBe(2);
    expect(line.y + 1).toBe(fourth.y + 28);
    await page.mouse.up();
    await expect(page.locator("[data-insertion]")).toHaveCount(0);

    expect(await calls(page, "playlistMove")).toHaveLength(1);
    const names = await page
      .getByRole("option")
      .evaluateAll((options) => options.map((option) => option.textContent?.match(/S01E0\d/)?.[0]));
    expect(names).toEqual(["S01E02", "S01E03", "S01E04", "S01E01", "S01E05"]);
    // A drag is not a click: nothing started playing.
    expect(await calls(page, "playlistPlay")).toHaveLength(0);
  });

  test("lifts the row under the pointer while it is dragged, and dims where it came from", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const first = page.getByRole("option").nth(0);
    const from = await box(first);
    await page.mouse.move(from.x + 120, from.y + 14);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y + 30, { steps: 4 });
    await page.mouse.move(from.x + 100, from.y + 70, { steps: 6 });

    const lifted = page.locator("[data-lifted]");
    await expect(lifted).toBeVisible();
    await expect(lifted).toContainText("Departures");
    const rect = await box(lifted);
    // The row itself, as large as it was, moved as far as the pointer has gone: under the
    // pointer, inside the window, not measured from the panel it came out of.
    expect(Math.round(rect.width)).toBe(Math.round(from.width));
    expect(rect.height).toBe(28);
    expect(Math.round(rect.x)).toBe(Math.round(from.x - 20));
    expect(Math.round(rect.y)).toBe(Math.round(from.y + 56));
    expect(rect.x + rect.width).toBeLessThanOrEqual(WIDTH);
    // In the panel's colours, though it is drawn outside the panel.
    const panel = page.getByRole("complementary");
    expect(await lifted.evaluate((element) => getComputedStyle(element).color)).toBe(
      await panel.evaluate((element) => getComputedStyle(element).color),
    );
    await expect(first).toHaveCSS("opacity", "0.45");

    await page.mouse.up();
    await expect(lifted).toHaveCount(0);
    await expect(page.getByRole("option").nth(0)).toHaveCSS("opacity", "1");
  });

  test("measures a name again when its row becomes the one playing", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    // The third has the long name; playing, it is set in a heavier weight, which is wider.
    await page.keyboard.press("n");
    await page.keyboard.press("n");
    const playing = page.getByRole("option", { name: /A Very Long Episode Title.*playing/ });
    await expect(playing).toHaveAttribute("aria-current", "true");
    const shown = playing.locator('[data-part="fitted"]');
    await expect(shown).toHaveCSS("font-weight", "600");
    const name = await box(shown);
    const row = await box(playing);
    // Still inside its cell: 8 px before the 56 px the length has, 8 px in from the row's end.
    expect(name.x + name.width).toBeLessThanOrEqual(row.x + row.width - 56 - 8 - 8 + 0.5);
    await expect(shown).toHaveText(/… On And On$/);
  });

  test("goes on saying that an item would not play, in place of its length", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    await page.evaluate((source) => window.__lumenMock?.skip(source), EPISODES[1] ?? "");
    const row = page.getByRole("option").nth(1);
    await expect(row).toHaveAccessibleName(/The Ferryman.*would not play: Not found/);
    const cells = row.locator(":scope > span[aria-hidden] > *");
    await expect(cells.nth(2)).toHaveText("Not found");
    // In the length's column, ending where the lengths end; the name stepped back.
    const said = await box(cells.nth(2));
    const length = await box(
      page.getByRole("option").nth(0).locator(":scope > span[aria-hidden] > *").nth(2),
    );
    expect(Math.round(said.x + said.width)).toBe(Math.round(length.x + length.width));
    const name = await box(cells.nth(1));
    expect(said.x - (name.x + name.width)).toBeGreaterThanOrEqual(8 - 0.5);
    expect(await cells.nth(1).evaluate((element) => getComputedStyle(element).color)).not.toBe(
      await page
        .getByRole("option")
        .nth(0)
        .locator(":scope > span[aria-hidden] > *")
        .nth(1)
        .evaluate((element) => getComputedStyle(element).color),
    );

    // The toast says it once, with the name on a line of its own, and leaves by itself.
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast.locator("[data-title]")).toHaveText(
      "Skipped a file that is no longer there",
    );
    await expect(toast.locator("[data-description]")).toHaveText(
      "The Crossing S01E02 The Ferryman",
    );
  });

  test("does not move a row's name when the pointer comes to it, whatever its last cell says", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    // The row with the very long name, and a reason wider than any length.
    await page.evaluate(
      (source) => window.__lumenMock?.skip(source, { kind: "notMedia" }),
      EPISODES[2] ?? "",
    );
    const row = page.getByRole("option").nth(2);
    const cells = row.locator(":scope > span[aria-hidden] > *");
    await expect(cells.nth(2)).toContainText("Would not play");
    await settle(page);
    const name = cells.nth(1);
    const before = await box(name);
    const shown = await name.locator("[data-shown]").textContent();
    expect(shown).toContain("…");

    await row.hover();
    const remove = row.locator("[data-remove]");
    await expect(remove).toBeVisible();
    await expect(cells.nth(2).getByText("Would not play")).toBeHidden();
    // What gave way kept its room, so the name is cut exactly as it was.
    expect(await box(name)).toEqual(before);
    expect(await name.locator("[data-shown]").textContent()).toBe(shown);
    // And the control is at the row's end, centred on its line.
    const control = await box(remove);
    const rowBox = await box(row);
    expect(Math.round(control.x + control.width)).toBe(Math.round(rowBox.x + rowBox.width - 8));
    expect(control.y + control.height / 2).toBe(rowBox.y + 14);
  });

  test("draws only the rows in view of a very long playlist, and still reaches the last", async ({
    page,
  }) => {
    const many = Array.from(
      { length: 1500 },
      (_, index) => `/Users/me/Music/Track ${index + 1}.flac`,
    );
    await openQueue(page, many);
    await showPlaylist(page);
    await expect(page.getByText("1500 items", { exact: false })).toBeVisible();
    expect(await page.getByRole("option").count()).toBeLessThan(60);

    const list = page.getByRole("listbox", { name: "Playlist" });
    await list.focus();
    await page.keyboard.press("End");
    const last = page.getByRole("option", { name: /Track 1500/ });
    await expect(last).toBeVisible();
    await expect(last).toHaveAttribute("aria-selected", "true");
    // Its number has four figures, and the column is as wide as four figures need.
    const number = await box(last.getByText("1500", { exact: true }));
    expect(number.width).toBeGreaterThan(24);
    expect(number.width).toBeLessThanOrEqual(34);
    const name = await box(last.locator("[data-shown]"));
    expect(Math.round(name.x - (number.x + number.width))).toBe(8);
  });

  test("names the playlist once it is saved, from a form beside its menu", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    await page.getByRole("button", { name: "Playlist menu" }).click();
    await page.getByRole("menuitem", { name: /Save as…/ }).click();
    const form = page.getByRole("dialog", { name: "Save playlist" });
    const name = form.getByRole("textbox", { name: "Name" });
    await expect(name).toBeFocused();
    await settle(page);

    // The form is inside the panel, and its two buttons are on one line at its right.
    const formBox = await box(form);
    const panel = await box(page.getByRole("complementary"));
    expect(formBox.x).toBeGreaterThanOrEqual(panel.x);
    expect(formBox.x + formBox.width).toBeLessThanOrEqual(WIDTH);
    const cancel = await box(form.getByRole("button", { name: "Cancel" }));
    const save = await box(form.getByRole("button", { name: "Save" }));
    expect(cancel.y).toBe(save.y);
    expect(save.x - (cancel.x + cancel.width)).toBe(8);

    // Typing a name is typing: K does not pause the film.
    await name.fill("Weeknights");
    await page.keyboard.press("k");
    expect(await calls(page, "playerTogglePaused")).toHaveLength(0);
    await name.fill("Weeknights");
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Weeknights" })).toBeVisible();
  });

  test("keeps its heading true to the saved playlist: renamed, deleted and brought back with it", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const panel = page.getByRole("complementary");
    await page.keyboard.press("Meta+s");
    await page.getByRole("textbox", { name: "Name" }).fill("Friday night");
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("heading", { name: "Friday night" })).toBeVisible();

    // Renamed from its own menu: the heading is the new name.
    await page.getByRole("button", { name: "Playlist menu" }).click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const form = page.getByRole("dialog", { name: "Rename playlist" });
    await form.getByRole("textbox", { name: "Name" }).fill("Saturday");
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "Saturday" })).toBeVisible();

    // It is still the playlist that can be renamed and deleted from here.
    await page.getByRole("button", { name: "Playlist menu" }).click();
    await page.getByRole("menuitem", { name: "Delete “Saturday”" }).click();
    // Deleted: what is open plays on, as a list without a name, headed as the tab is.
    await expect(panel.getByRole("heading", { name: "Playlist" })).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(5);
    await page.getByRole("button", { name: "Playlist menu" }).click();
    await expect(page.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Undo brings the playlist back, and its name to the list that was it.
    await page.keyboard.press("Meta+z");
    await expect(panel.getByRole("heading", { name: "Saturday" })).toBeVisible();
  });

  test("is headed by the tab's name until it has one of its own, with the count beneath", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const panel = page.getByRole("complementary");
    const heading = await box(panel.getByRole("heading", { name: "Playlist" }));
    const summary = await box(panel.getByText(/^5 items/));
    expect(summary.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
    // The list below does not move when a name arrives.
    const before = await box(page.getByRole("option").nth(0));
    await page.keyboard.press("Meta+s");
    await page.getByRole("textbox", { name: "Name" }).fill("Friday night");
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("heading", { name: "Friday night" })).toBeVisible();
    expect((await box(page.getByRole("option").nth(0))).y).toBe(before.y);
  });

  test("names Repeat for what it is, with its state as the tooltip's second line", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const repeat = page.getByRole("button", { name: "Repeat", exact: true });
    await expect(repeat).toHaveAttribute("aria-pressed", "false");
    await repeat.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/Off/);
    await repeat.click();
    await expect(repeat).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(600, 300);
    await repeat.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/All/);
  });

  test("opens a saved playlist from one submenu, which never lies over the menu it came from", async ({
    page,
  }) => {
    await openQueue(page);
    await page.evaluate(() => {
      window.__lumenMock?.seedPlaylist("Friday night", ["/a.mkv", "/b.mkv"]);
      window.__lumenMock?.seedPlaylist("Kurosawa", ["/c.mkv"]);
    });
    await showPlaylist(page);
    await page.getByRole("button", { name: "Playlist menu" }).click();
    const names = await page
      .getByRole("menu")
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.querySelector(".truncate")?.textContent));
    expect(names).toEqual(["Add files…", "Save as…", "Open playlist", "Clear"]);
    await glide(page, page.getByRole("menuitem", { name: "Open playlist" }));
    const friday = page.getByRole("menuitem", { name: /Friday night/ });
    await expect(friday).toBeVisible();
    await settle(page);
    const menus = await Promise.all((await page.getByRole("menu").all()).map((menu) => box(menu)));
    expect(menus).toHaveLength(2);
    const [root, sub] = menus;
    if (!root || !sub) {
      throw new Error("two menus should be open");
    }
    expect(overlap(root, sub)).toBe(false);
    for (const menu of menus) {
      expect(menu.x).toBeGreaterThanOrEqual(8);
      expect(menu.x + menu.width).toBeLessThanOrEqual(WIDTH - 8);
    }
    // One level: choosing the name opens it.
    await glide(page, friday);
    await friday.click();
    expect(await calls(page, "playlistsOpen")).toHaveLength(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("keeps its header's controls clear of a very long name", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    await page.getByRole("button", { name: "Playlist menu" }).click();
    await page.getByRole("menuitem", { name: /Save as…/ }).click();
    const long = "Everything we mean to watch this winter and probably will not finish";
    await page.getByRole("textbox", { name: "Name" }).fill(long);
    await page.keyboard.press("Enter");
    const heading = page.getByRole("heading", { name: long });
    await expect(heading).toBeVisible();
    const name = await box(heading);
    const shuffle = await box(page.getByRole("button", { name: "Shuffle" }));
    const repeat = await box(page.getByRole("button", { name: /^Repeat/ }));
    const menu = await box(page.getByRole("button", { name: "Playlist menu" }));
    expect(name.x + name.width).toBeLessThanOrEqual(shuffle.x - 8);
    expect(repeat.x - (shuffle.x + shuffle.width)).toBe(4);
    expect(menu.x - (repeat.x + repeat.width)).toBe(4);
    expect(overlap(name, shuffle)).toBe(false);
    expect(name.height).toBe(24);
  });
});

test.describe("the panel's colours and its going", () => {
  test.use({ viewport: { width: WIDTH, height: 630 } });

  test("is dark beside the film in a light window, and so is what opens from it", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const panel = page.getByRole("complementary");
    const dark = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await settle(page);
    // The same surface in either theme: it stands beside a film.
    expect(await panel.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(dark);
    await page.getByRole("button", { name: "Playlist menu" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    expect(
      await contrast(
        page,
        await menu.evaluate((element) => getComputedStyle(element).color),
        await menu.evaluate((element) => getComputedStyle(element).backgroundColor),
      ),
    ).toBeGreaterThan(7);
    // Light ink on a dark surface, not the window's dark ink on white.
    expect(
      await contrast(
        page,
        await menu.evaluate((element) => getComputedStyle(element).backgroundColor),
        "white",
      ),
    ).toBeGreaterThan(10);
    await page.keyboard.press("Escape");

    // Ordinary controls: 32 px, not the 36 px ones that sit over the picture.
    const hide = await box(page.getByRole("button", { name: "Hide panel" }));
    expect(hide.width).toBe(32);
    expect(hide.height).toBe(32);
  });

  test("slides out before the window takes its room back, and cannot be clicked on its way", async ({
    page,
  }) => {
    await openQueue(page);
    await showPlaylist(page);
    const panel = page.getByRole("complementary", { includeHidden: true });
    await page.getByRole("button", { name: "Hide panel" }).click();
    // Still there for a moment, on its way out and out of reach.
    await expect(panel).toHaveCSS("pointer-events", "none");
    expect((await calls(page, "windowSetPanelWidth")).at(-1)).toEqual({ width: PANEL });
    await expect(panel).toHaveCount(0);
    await expect
      .poll(async () => (await calls(page, "windowSetPanelWidth")).at(-1))
      .toEqual({ width: 0 });
    // Opened again before it has gone, it simply stays.
    await showPlaylist(page);
    await page.keyboard.press("Meta+Shift+p");
    await page.keyboard.press("Meta+Shift+p");
    await expect(page.getByRole("listbox", { name: "Playlist" })).toBeVisible();
    await settle(page);
    expect((await calls(page, "windowSetPanelWidth")).at(-1)).toEqual({ width: PANEL });
  });

  test("takes the keyboard to its list when a key opened it, and leaves it alone for the pointer", async ({
    page,
  }) => {
    await openQueue(page);
    await page.getByRole("button", { name: "Show playlist" }).click();
    await expect(page.getByRole("listbox", { name: "Playlist" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Playlist" })).not.toBeFocused();
    await page.getByRole("button", { name: "Hide panel" }).click();
    await expect(page.getByRole("complementary")).toHaveCount(0);

    await showPlaylist(page);
    await expect(page.getByRole("listbox", { name: "Playlist" })).toBeFocused();
    // Escape gives the keyboard back to the picture; the panel stays.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "Playlist" })).not.toBeFocused();
    await expect(page.getByRole("complementary")).toBeVisible();
  });
});

test.describe("the chapters tab", () => {
  test.use({ viewport: { width: WIDTH, height: 630 } });

  test("leaves no row selected after a click, so nothing outshines the lamp", async ({ page }) => {
    await page.goto("/#mock-film");
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    await page.keyboard.press("Meta+Shift+c");
    const list = page.getByRole("listbox", { name: "Chapters" });
    await expect(list).toBeVisible();
    // Opened by key: the selection starts on the chapter that is playing.
    await expect(page.getByRole("option", { selected: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.getByRole("option", { name: /Morning/ }).click();
    expect((await calls(page, "playerSeekTo")).at(-1)).toMatchObject({ seconds: 6300 });
    await expect(page.getByRole("option", { selected: true })).toHaveCount(0);
  });

  test("lists the chapters, times in one column, and goes to the one clicked", async ({ page }) => {
    await page.goto("/#mock-film");
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    await page.keyboard.press("Meta+Shift+c");
    const list = page.getByRole("listbox", { name: "Chapters" });
    await expect(list).toBeVisible();
    await settle(page);
    const options = page.getByRole("option");
    await expect(options).toHaveCount(5);

    // Every start time ends on the same line; every name starts on the same line.
    const ends = new Set<number>();
    const starts = new Set<number>();
    for (const option of await options.all()) {
      const cells = option.locator(":scope > span > *");
      const time = await box(cells.nth(1));
      const name = await box(cells.nth(2));
      ends.add(Math.round(time.x + time.width));
      starts.add(Math.round(name.x));
      expect(name.x - (time.x + time.width)).toBe(8);
    }
    expect(ends.size).toBe(1);
    expect(starts.size).toBe(1);

    // The film is 42 minutes in: the third chapter has the lamp.
    await expect(options.nth(2)).toHaveAttribute("aria-current", "true");
    await options.nth(3).click();
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 4020, exact: true });
    await expect(options.nth(3)).toHaveAttribute("aria-current", "true");
  });

  test("says so, in one line, when the film has none", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("Meta+Shift+c");
    await expect(page.getByText("This file has no chapters.")).toBeVisible();
  });
});

test.describe("the smallest window that can hold the panel", () => {
  test.use({ viewport: { width: 560 + PANEL, height: 360 } });

  test("still gives the stage its 560 px, with nothing touching", async ({ page }) => {
    await openQueue(page);
    await showPlaylist(page);
    const row = [
      page.getByRole("button", { name: "Previous item" }),
      page.getByRole("button", { name: "Play", exact: true }),
      page.getByRole("button", { name: "Next item" }),
      page.getByRole("button", { name: "Mute" }),
      page.getByRole("button", { name: /^10 minutes/ }),
      page.getByRole("button", { name: "More" }),
      page.getByRole("button", { name: "Enter full screen" }),
    ];
    const boxes = await Promise.all(row.map((control) => box(control)));
    boxes.forEach((current, index) => {
      const before = boxes[index - 1];
      if (before) {
        expect(current.x, `control ${index}`).toBeGreaterThanOrEqual(before.x + before.width + 4);
      }
      expect(current.y).toBe(boxes[0]?.y);
    });
    // The last control ends at the stage's gutter, not under the panel.
    const last = boxes.at(-1);
    expect(Math.round((last?.x ?? 0) + (last?.width ?? 0) - 9)).toBe(560 - GUTTER);
  });
});
