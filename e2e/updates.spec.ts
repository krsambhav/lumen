import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import {
  box,
  calls,
  GUTTER,
  openFilm,
  openHome,
  overlap,
  settle,
  tabTo,
  test,
  textNotInTheInterfaceFont,
  tooltipBox,
  WCAG,
} from "./support";

const TITLEBAR = 44;

/** As the backend does when it finds a newer version by itself. */
async function find(page: Page, version = "1.5.0") {
  await page.evaluate((found) => window.__lumenMock?.findUpdate(found), version);
}

/** How a pretend download goes: how long each of its steps takes, and whether it says its size. */
async function pace(page: Page, update: { step: number; sized?: boolean; latest?: string }) {
  await page.evaluate((given) => {
    const mock = window.__lumenMock;
    if (mock) {
      mock.update = { ...mock.update, ...given };
    }
  }, update);
}

/** One report of a download, as the backend says it. */
async function arrive(page: Page, percent: number) {
  await page.evaluate((share) => {
    window.__lumenMock?.sayUpdate({
      state: "downloading",
      version: "1.5.0",
      received: (share / 100) * 41_250_000,
      total: 41_250_000,
    });
  }, percent);
}

/** The control at the end of the title bar, whatever it is saying. */
function control(page: Page) {
  return page.locator("header > div:last-child > div > div");
}

async function runFromPalette(page: Page, typed: string, name: string) {
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  // Whatever was typed into it last is taken away first.
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(typed);
  const row = page.getByRole("option", { name }).first();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test.describe("Lumen's own update, on the home screen", () => {
  test("is not there until a newer version is found", async ({ page }) => {
    await openHome(page);
    await expect(page.getByRole("button", { name: /Update/ })).toHaveCount(0);
    await expect(control(page)).toHaveCount(0);
    // And nothing is said of it: no toast.
    await find(page);
    await expect(page.getByRole("button", { name: "Update to 1.5.0" })).toBeVisible();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  for (const [width, height] of [
    [560, 360],
    [1120, 680],
    [1728, 1080],
  ] as const) {
    test(`is one control at the end of the title bar, its last letter at the gutter, at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await openHome(page);
      await find(page);
      const button = page.getByRole("button", { name: "Update to 1.5.0" });
      await expect(button).toBeVisible();
      await settle(page);

      const rect = await box(button);
      expect(rect.height).toBe(28);
      // Centred on the title bar's middle line, as the traffic lights are.
      expect(Math.abs(rect.y + rect.height / 2 - TITLEBAR / 2)).toBeLessThanOrEqual(0.5);
      // Its hover box runs 8 px past its words, so that the words end at the gutter.
      const words = await box(button.locator("span > span").last());
      // And the words stand on the line of the window's title.
      const titleLine = await box(page.getByRole("heading", { level: 1, name: "Lumen" }));
      expect(Math.abs(words.y - titleLine.y)).toBeLessThanOrEqual(0.5);
      expect(words.height).toBe(titleLine.height);
      expect(Math.abs(words.x + words.width - (width - GUTTER))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(rect.x + rect.width - (width - GUTTER + 8))).toBeLessThanOrEqual(0.5);

      // The lamp leads the words, on their middle line, 8 px before them.
      const lamp = await box(button.locator("span > span").first());
      expect(lamp.width).toBe(6);
      expect(lamp.height).toBe(6);
      expect(Math.abs(words.x - (lamp.x + lamp.width) - 8)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(lamp.y + 3 - (rect.y + 14))).toBeLessThanOrEqual(0.5);

      // The window's title is still centred on the window, and clear of it.
      const title = await box(page.getByRole("heading", { level: 1, name: "Lumen" }));
      expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThanOrEqual(0.5);
      expect(overlap(title, rect)).toBe(false);
      expect(rect.x - (title.x + title.width)).toBeGreaterThanOrEqual(12);
      // Nothing can be scrolled sideways to.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
  }

  test("has no accessibility violations, in either theme, offered or arriving", async ({
    page,
  }) => {
    await openHome(page);
    await find(page);
    await expect(page.getByRole("button", { name: "Update to 1.5.0" })).toBeVisible();
    for (const theme of ["dark", "light"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      await settle(page);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, theme).toEqual([]);
    }
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);

    // Arriving: a readout, read out as a progress bar.
    await pace(page, { step: 400 });
    await page.getByRole("button", { name: "Update to 1.5.0" }).click();
    await expect(page.getByRole("progressbar", { name: "Downloading Lumen 1.5.0" })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
      }, theme);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, theme).toEqual([]);
    }
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);
  });

  test("says on hover which version this is, under the control and inside the window", async ({
    page,
  }) => {
    await openHome(page);
    await find(page);
    const button = page.getByRole("button", { name: "Update to 1.5.0" });
    await button.hover();
    const tip = tooltipBox(page);
    await expect(tip).toContainText("Lumen 1.5.0 is available");
    await expect(tip).toContainText("You have 1.4.0. Updating restarts Lumen.");
    await settle(page);
    const tipBox = await box(tip);
    const rect = await box(button);
    expect(tipBox.y).toBeGreaterThanOrEqual(rect.y + rect.height);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(1120 - 8 + 0.5);
    expect(tipBox.x).toBeGreaterThanOrEqual(8);
  });

  test("is reached with Tab and worked with Return, showing where the keyboard is", async ({
    page,
  }) => {
    await openHome(page);
    await find(page);
    await pace(page, { step: 400 });
    const button = page.getByRole("button", { name: "Update to 1.5.0" });
    await tabTo(page, button);
    const ring = await button.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(ring).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("progressbar", { name: "Downloading Lumen 1.5.0" })).toBeVisible();
    expect(await calls(page, "updateInstall")).toHaveLength(1);
  });

  test("turns into a readout in the button's place: same height, same end, nothing that moves", async ({
    page,
  }) => {
    await openHome(page);
    await find(page);
    const button = page.getByRole("button", { name: "Update to 1.5.0" });
    await expect(button).toBeVisible();
    await settle(page);
    const offered = await box(button);

    const bar = page.getByRole("progressbar", { name: "Downloading Lumen 1.5.0" });

    // Each report of the download, as it is drawn: the word, the share, the scale.
    const seen = new Map<string, { word: number; share: number; scale: number; right: number }>();
    for (const percent of [0, 7, 12, 37, 61, 99, 100]) {
      const share = `${percent}%`;
      await arrive(page, percent);
      await expect(control(page)).toContainText(share);
      await settle(page);
      const readout = await box(control(page));
      const word = await box(control(page).getByText("Downloading", { exact: true }));
      // The figure itself, not the unseen "100%" its column is sized by; and that column.
      const shown = control(page).getByText(share, { exact: true }).last();
      const figure = await box(shown);
      const column = await box(shown.locator("xpath=.."));
      const scale = await box(bar);
      expect(readout.height, share).toBe(28);
      expect(readout.y, share).toBe(offered.y);
      // Name, scale, value: 8 px apart, none touching, the scale 48 px long.
      expect(scale.width, share).toBe(48);
      expect(Math.abs(scale.x - (word.x + word.width) - 8), share).toBeLessThanOrEqual(0.5);
      expect(Math.abs(column.x - (scale.x + scale.width) - 8), share).toBeLessThanOrEqual(0.5);
      // The value is set to the right of its column, and ends at the gutter, where the
      // button's words did. The column is as wide as "100%" and no wider.
      expect(Math.abs(figure.x + figure.width - (1120 - GUTTER)), share).toBeLessThanOrEqual(0.5);
      expect(Math.abs(column.x + column.width - (1120 - GUTTER)), share).toBeLessThanOrEqual(0.5);
      expect(figure.x, share).toBeGreaterThanOrEqual(column.x - 0.5);
      if (share === "100%") {
        expect(Math.abs(figure.width - column.width), share).toBeLessThanOrEqual(0.5);
      }
      // The words share the title's line; the scale is centred on the bar's.
      const title = await box(page.getByRole("heading", { level: 1, name: "Lumen" }));
      expect(Math.abs(word.y - title.y), share).toBeLessThanOrEqual(0.5);
      expect(Math.abs(figure.y - title.y), share).toBeLessThanOrEqual(0.5);
      expect(Math.abs(scale.y + scale.height / 2 - TITLEBAR / 2), share).toBeLessThanOrEqual(0.5);
      seen.set(share, {
        word: word.x,
        share: column.x,
        scale: scale.x,
        right: readout.x + readout.width,
      });
    }
    // From 0% to 100% a digit comes and another: nothing in the readout moves for it.
    // (To a tenth of a pixel: an engine lays text out in sixty-fourths, and rounds them.)
    const places = [...seen.entries()];
    const first = places[0]?.[1];
    for (const [share, place] of places) {
      for (const part of ["word", "scale", "share", "right"] as const) {
        expect(
          Math.abs(place[part] - (first?.[part] ?? Number.NaN)),
          `${part} at ${share}`,
        ).toBeLessThan(0.1);
      }
    }
    // The title bar never grew something to scroll to.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1120);
  });

  test("sweeps instead of guessing when the download does not say how large it is", async ({
    page,
  }) => {
    await openHome(page);
    await find(page);
    await pace(page, { step: 300, sized: false });
    await page.getByRole("button", { name: "Update to 1.5.0" }).click();
    await expect(control(page)).toContainText("Downloading");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(control(page)).not.toContainText("%");
    const readout = await box(control(page));
    expect(readout.height).toBe(28);
    const sweep = await box(control(page).locator("span[aria-hidden='true']").last());
    expect(sweep.width).toBe(48);
    expect(Math.abs(sweep.x + sweep.width - (1120 - GUTTER))).toBeLessThanOrEqual(0.5);
  });

  test("starts Lumen again as the new version once it is in place, with no toast on the way", async ({
    page,
  }) => {
    await openHome(page);
    await find(page);
    await page.getByRole("button", { name: "Update to 1.5.0" }).click();
    await expect.poll(() => calls(page, "updateRestart")).toHaveLength(1);
    expect(await calls(page, "updateInstall")).toHaveLength(1);
    // The control showed all of it: a toast would have said one thing twice.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  test("says why an update failed, and goes on offering it", async ({ page }) => {
    await openHome(page);
    await find(page);
    await page.evaluate(() => {
      const mock = window.__lumenMock;
      if (mock) {
        mock.update = {
          latest: "1.5.0",
          step: 30,
          fails: {
            kind: "network",
            message: "The download was cut short. Check the connection and try again",
          },
        };
      }
    });
    await page.getByRole("button", { name: "Update to 1.5.0" }).click();
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen could not update");
    await expect(toast).toContainText(
      "The download was cut short. Check the connection and try again.",
    );
    await expect(page.getByRole("button", { name: "Update to 1.5.0" })).toBeVisible();
    expect(await calls(page, "updateRestart")).toHaveLength(0);

    // Asked again, with the connection back: the failure is taken away.
    await page.evaluate(() => {
      const mock = window.__lumenMock;
      if (mock) {
        mock.update = { latest: "1.5.0", step: 30 };
      }
    });
    await page.getByRole("button", { name: "Update to 1.5.0" }).click();
    await expect(toast).toHaveCount(0);
    await expect.poll(() => calls(page, "updateRestart")).toHaveLength(1);
  });
});

test.describe("checking for updates when asked", () => {
  test("answers in a toast that Lumen is up to date, and which version that is", async ({
    page,
  }) => {
    await openHome(page);
    await runFromPalette(page, "check for up", "Check for updates");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen is up to date");
    await expect(toast).toContainText("1.4.0 is the newest version");
    await expect(toast).toHaveCount(1);
    expect(await calls(page, "updateCheck")).toHaveLength(1);
    await expect(control(page)).toHaveCount(0);
  });

  test("offers a newer version in the toast and in the title bar, laid out without a squeeze", async ({
    page,
  }) => {
    await openHome(page);
    await pace(page, { step: 80, latest: "1.5.0" });
    await runFromPalette(page, "check for up", "Check for updates");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen 1.5.0 is available");
    await expect(toast).toContainText("You have 1.4.0");
    await settle(page);

    const rect = await box(toast);
    expect(rect.width).toBe(356);
    expect(Math.round(rect.x + rect.width)).toBe(1120 - GUTTER);
    // Under the title bar, clear of the control that now stands in it.
    const offered = await box(page.getByRole("button", { name: "Update to 1.5.0" }));
    expect(rect.y).toBeGreaterThanOrEqual(offered.y + offered.height);

    // Its words on one line each, then Update, then the control that closes it.
    const title = await box(toast.getByText("Lumen 1.5.0 is available"));
    const detail = await box(toast.getByText("You have 1.4.0"));
    const update = await box(toast.getByRole("button", { name: "Update" }));
    const dismiss = await box(toast.getByRole("button", { name: "Dismiss" }));
    expect(title.height).toBe(20);
    expect(detail.height).toBe(20);
    expect(update.height).toBe(28);
    expect(update.x).toBeGreaterThanOrEqual(
      Math.max(title.x + title.width, detail.x + detail.width),
    );
    expect(dismiss.x).toBeGreaterThanOrEqual(update.x + update.width + 8);
    expect(dismiss.x + dismiss.width).toBeLessThanOrEqual(rect.x + rect.width);
    for (const part of [title, detail, update, dismiss]) {
      expect(part.y).toBeGreaterThanOrEqual(rect.y);
      expect(part.y + part.height).toBeLessThanOrEqual(rect.y + rect.height);
    }
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
  });

  test("says why it could not look, and stays until it is closed", async ({ page }) => {
    await openHome(page);
    await page.evaluate(() =>
      window.__lumenMock?.refuse("updateCheck", {
        kind: "network",
        message: "GitHub could not be reached. Check the connection and try again",
      }),
    );
    await runFromPalette(page, "check for up", "Check for updates");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen could not check for updates");
    await expect(toast).toContainText(
      "GitHub could not be reached. Check the connection and try again.",
    );
    await expect(toast).toHaveCount(1);
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await expect(toast).toHaveCount(0);
  });

  test("is in the palette under Lumen, with the switch for looking by itself", async ({ page }) => {
    await openHome(page);
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("updates");
    await expect(
      page.getByRole("option", { name: "Check for updates", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Check for updates automatically" }),
    ).toBeVisible();
    // Nothing to update to: it is listed, dimmed, with the reason.
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("update lumen");
    const update = page.getByRole("option", { name: /Update Lumen/ });
    await expect(update).toContainText("No newer version has been found");
    await expect(update).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // Switched off, it is the setting that is sent.
    await runFromPalette(page, "updates automat", "Check for updates automatically");
    await expect
      .poll(async () => (await calls(page, "settingsSet")).length)
      .toBeGreaterThanOrEqual(1);
    const sent = (await calls(page, "settingsSet")).at(-1) as {
      settings: { general: { checkForUpdates: boolean } };
    };
    expect(sent.settings.general.checkForUpdates).toBe(false);
  });
});

test.describe("an update while a film is open", () => {
  test("is never announced: nothing in the title bar, and no toast", async ({ page }) => {
    await openFilm(page);
    await find(page);
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 320);
    await expect(page.getByRole("button", { name: /Update to/ })).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    // It is waiting on the home screen.
    await page.keyboard.press("Meta+.");
    await expect(page.getByRole("heading", { name: "Drop a file to play" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update to 1.5.0" })).toBeVisible();
  });

  test("asked for, is followed in one toast, and leaves the moment to restart to the viewer", async ({
    page,
  }) => {
    await openFilm(page);
    await pace(page, { step: 250, latest: "1.5.0" });
    await runFromPalette(page, "check for up", "Check for updates");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen 1.5.0 is available");
    await toast.getByRole("button", { name: "Update" }).click();

    await expect(toast).toContainText("Downloading Lumen 1.5.0");
    await expect(toast).toContainText(/\d+% · \d+ of 41 MB/);
    await expect(toast).toHaveCount(1);
    // Nothing to choose while it arrives but to close the toast.
    await expect(toast.getByRole("button", { name: "Update" })).toHaveCount(0);
    await settle(page);
    const arriving = await box(toast);
    expect(arriving.width).toBe(356);

    await expect(toast).toContainText("Lumen 1.5.0 is installed");
    await expect(toast).toContainText("It opens the next time Lumen starts");
    await expect(toast).toHaveCount(1);
    // The film was not interrupted, and Lumen did not restart by itself.
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    expect(await calls(page, "updateRestart")).toHaveLength(0);

    await toast.getByRole("button", { name: "Restart" }).click();
    await expect.poll(() => calls(page, "updateRestart")).toHaveLength(1);
  });

  test("can be started from the palette, by the name of what it will do", async ({ page }) => {
    await openFilm(page);
    await find(page);
    await pace(page, { step: 40 });
    await runFromPalette(page, "update to", "Update to 1.5.0");
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen 1.5.0 is installed");
    expect(await calls(page, "updateInstall")).toHaveLength(1);
    expect(await calls(page, "updateRestart")).toHaveLength(0);
    // Then the same action restarts.
    await runFromPalette(page, "restart to", "Restart to update");
    await expect.poll(() => calls(page, "updateRestart")).toHaveLength(1);
  });
});
