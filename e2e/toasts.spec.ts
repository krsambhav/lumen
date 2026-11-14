import { expect } from "@playwright/test";
import {
  box,
  calls,
  EPISODES,
  GUTTER,
  openFilm,
  openHistory,
  overlap,
  PANEL,
  settle,
  showPlaylist,
  test,
} from "./support";

/** The size the on-screen display's type has in this window. */
async function osdSize(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.width = "var(--osd-size)";
    document.body.append(probe);
    const size = probe.getBoundingClientRect().width;
    probe.remove();
    return size;
  });
}

/** Opens the pretend series and leaves its toast up. */
async function openSeries(page: import("@playwright/test").Page) {
  await page.goto("/#mock");
  await expect(page.getByRole("heading", { name: "Drop a file to play" })).toBeVisible();
  await page.evaluate((list) => {
    window.__lumenMock?.openQueue(list, { paused: true, at: 600 });
  }, EPISODES);
  await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  const toast = page.locator("[data-sonner-toast]");
  await expect(toast).toContainText("5 items in the playlist");
  await settle(page);
  return toast;
}

test.describe("toasts on the stage", () => {
  test("stand at the top right of the picture, under the line the on-screen display uses", async ({
    page,
  }) => {
    const toast = await openSeries(page);
    const rect = await box(toast);
    expect(rect.width).toBe(356);
    expect(Math.round(rect.x + rect.width)).toBe(1120 - GUTTER);
    expect(Math.abs(rect.y - (44 + 4 + 2.3 * (await osdSize(page)) + 8))).toBeLessThanOrEqual(0.5);

    // The on-screen display, at its tallest (a label and a scale), ends above it.
    await page.keyboard.press("ArrowUp");
    const osd = page.locator("[data-osd] > div");
    await expect(osd).toBeVisible();
    const said = await box(osd);
    expect(said.y + said.height).toBeLessThanOrEqual(rect.y - 4);
  });

  test("are clear of the loupe and of the transport row's tooltips, wherever on the timeline the pointer is", async ({
    page,
  }) => {
    const toast = await openSeries(page);
    const rect = await box(toast);
    const track = await box(page.getByRole("slider", { name: "Position" }));
    const y = track.y + track.height / 2;
    for (const x of [GUTTER + 4, 300, 700, 1120 - GUTTER - 4]) {
      await page.mouse.move(x, y - 30);
      await page.mouse.move(x, y, { steps: 3 });
      const loupe = page.locator("[data-loupe]");
      await expect(loupe).toBeVisible();
      expect(overlap(await box(loupe), rect), `loupe at ${x}`).toBe(false);
    }
    await page.getByRole("button", { name: "Next item" }).hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    expect(
      overlap(await box(page.locator("[data-radix-popper-content-wrapper]").last()), rect),
    ).toBe(false);
  });

  test("keep to the picture's corner when the panel is beside it", async ({ page }) => {
    await page.setViewportSize({ width: 1120 + PANEL, height: 630 });
    const toast = await openSeries(page);
    // Opening the panel takes the toast that offers it; another stays to be measured.
    await showPlaylist(page);
    await expect(toast).toHaveCount(0);
    await page.getByRole("option").nth(3).click();
    await page.keyboard.press("Delete");
    const removed = page.locator("[data-sonner-toast]");
    await expect(removed).toContainText("Removed from the playlist");
    await settle(page);
    const rect = await box(removed);
    const panel = await box(page.getByRole("complementary"));
    expect(Math.round(rect.x + rect.width)).toBe(Math.round(panel.x - GUTTER));
    expect(overlap(rect, panel)).toBe(false);
  });

  test("are no wider than 356 px in the narrowest window, not a slab from edge to edge", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 560, height: 360 });
    const toast = await openSeries(page);
    const rect = await box(toast);
    expect(rect.width).toBe(356);
    expect(Math.round(rect.x + rect.width)).toBe(560 - GUTTER);
    expect(rect.x).toBeGreaterThanOrEqual(GUTTER);
    // Above the controls, with the timeline clear.
    const track = await box(page.getByRole("slider", { name: "Position" }));
    expect(rect.y + rect.height).toBeLessThan(track.y);
  });

  test("say what happened in a few words, with the name on one line of its own", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1120 + PANEL, height: 630 });
    await openSeries(page);
    await showPlaylist(page);
    // The third episode has a name as long as a sentence.
    await page.getByRole("option").nth(2).click();
    await page.keyboard.press("Delete");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast.locator("[data-title]")).toHaveText("Removed from the playlist");
    const name = toast.locator("[data-description]");
    await expect(name).toHaveText(/A Very Long Episode Title/);
    await settle(page);
    // One line each: as tall as a toast with two lines, however long the name.
    expect((await box(name)).height).toBeLessThanOrEqual(20);
    expect((await box(toast)).height).toBeLessThanOrEqual(72);
    // Undo and Dismiss are one height on one centre line, 12 px apart,
    // inside the toast's padding.
    const undo = await box(toast.getByRole("button", { name: "Undo" }));
    const dismiss = await box(toast.getByRole("button", { name: "Dismiss" }));
    const rect = await box(toast);
    expect(undo.x + undo.width).toBeLessThanOrEqual(rect.x + rect.width - 12);
    expect(undo.x).toBeGreaterThanOrEqual((await box(name)).x + (await box(name)).width + 8);
    expect(dismiss.height).toBe(undo.height);
    expect(dismiss.y).toBe(undo.y);
    expect(Math.round(dismiss.x - (undo.x + undo.width))).toBe(12);
    // Its mark, not its box, is what stands at the padding.
    const mark = await box(toast.getByRole("button", { name: "Dismiss" }).locator("svg"));
    const inside = rect.x + rect.width - (mark.x + mark.width);
    expect(inside).toBeGreaterThanOrEqual(12);
    expect(inside).toBeLessThanOrEqual(14);
  });

  test("close on Escape, the one in front first, before Escape does anything else", async ({
    page,
  }) => {
    const toast = await openSeries(page);
    await page.evaluate(() =>
      window.__lumenMock?.skip("/Users/me/Series/The Crossing S01E02 The Ferryman.mkv"),
    );
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
    await expect(toast).toContainText("5 items in the playlist");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  test("offer an Undo that ⌘Z takes up", async ({ page }) => {
    await page.setViewportSize({ width: 1120 + PANEL, height: 630 });
    await openSeries(page);
    await showPlaylist(page);
    await page.getByRole("option").nth(1).click();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("option")).toHaveCount(4);
    await expect(page.locator("[data-sonner-toast]")).toContainText("Removed from the playlist");
    await page.keyboard.press("Meta+z");
    await expect(page.getByRole("option")).toHaveCount(5);
    await expect(page.getByRole("option").nth(1)).toHaveAccessibleName(/The Ferryman/);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    // With nothing left to undo, the key says so.
    await page.keyboard.press("Meta+z");
    await expect(page.locator("[data-osd]")).toContainText("There is nothing to undo");
    expect(await calls(page, "playlistAdd")).toHaveLength(1);
  });

  test("step out of sight while a menu on the stage is open, and are there again after", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 560, height: 360 });
    const toast = await openSeries(page);
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(toast).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toast).toBeVisible();
  });

  test("move on our two durations and our curve, and never animate a height", async ({ page }) => {
    const toast = await openSeries(page);
    const transition = await toast.evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(transition.property).toBe("transform, opacity");
    expect(transition.duration).toBe("0.2s, 0.2s");
  });

  test("say that a film was resumed, with the way to start it over", async ({ page }) => {
    await openFilm(page);
    await page.evaluate(() => window.__lumenMock?.resume(2534));
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Resumed at 0:42:14");
    await toast.getByRole("button", { name: "Start over" }).click();
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 0, exact: true });
  });
});

test.describe("toasts on the home screen", () => {
  test("stand at the top right under the title bar, clear of every tile and its caption", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1120, height: 560 });
    await openHistory(page);
    const tile = page.getByRole("button", { name: /Solaris/ });
    await tile.focus();
    await page.keyboard.press("Delete");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Removed from recently played");
    await settle(page);
    const rect = await box(toast);
    expect(Math.round(rect.x + rect.width)).toBe(1120 - GUTTER);
    expect(rect.y).toBe(44 + 8);
    for (const other of await page
      .getByRole("region", { name: "Recently played" })
      .getByRole("button")
      .all()) {
      expect(overlap(await box(other), rect)).toBe(false);
    }
    // The headline and the way to open something are clear of it too.
    expect(overlap(await box(page.getByRole("heading", { level: 2 })), rect)).toBe(false);
    expect(overlap(await box(page.getByRole("button", { name: "Open file…" })), rect)).toBe(false);
  });
});
