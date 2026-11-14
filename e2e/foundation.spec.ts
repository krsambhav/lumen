import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { tab, test } from "./support";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) {
    throw new Error("element is not laid out");
  }
  return rect;
}

async function openGallery(page: Page) {
  await page.goto("/#gallery");
  await expect(page.getByRole("button", { name: "Open file…" }).first()).toBeVisible();
}

test.describe("accessibility", () => {
  test("the app shell has no WCAG A or AA violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Lumen" })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
  });

  test("every primitive, in both themes and on the stage, has no WCAG A or AA violations", async ({
    page,
  }) => {
    await openGallery(page);
    const results = await new AxeBuilder({ page })
      .withTags(WCAG)
      // The gallery shows each theme side by side, so some names repeat by design.
      .disableRules(["landmark-unique", "region"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("keyboard focus", () => {
  test("a control focused from the keyboard shows the accent ring", async ({ page }) => {
    await openGallery(page);
    await tab(page);
    const focused = page.locator(":focus");
    await expect(focused).toHaveAccessibleName("Open file…");
    const ring = await focused.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset };
    });
    expect(ring).toEqual({ width: "2px", style: "solid", offset: "2px" });
  });

  test("a control clicked with the pointer does not show the ring", async ({ page }) => {
    await openGallery(page);
    const button = page.getByRole("button", { name: "Cancel" }).first();
    await button.click();
    expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  });

  test("tab order follows reading order and reaches unavailable controls", async ({ page }) => {
    await openGallery(page);
    const names: string[] = [];
    for (let press = 0; press < 12; press += 1) {
      await tab(page);
      names.push(
        await page
          .locator(":focus")
          .evaluate((element) => element.getAttribute("aria-label") ?? element.textContent ?? ""),
      );
    }
    expect(names.slice(0, 6)).toEqual([
      "Open file…",
      "Add folder",
      "Cancel",
      "Remove from library",
      "Download",
      "Add folder",
    ]);
    // "Cast" is unavailable, not disabled: it must still be reachable.
    expect(names).toContain("Cast");
  });

  test("an unavailable control explains itself when focused", async ({ page }) => {
    await openGallery(page);
    const cast = page.getByRole("button", { name: "Cast" }).first();
    await cast.focus();
    await expect(page.getByRole("tooltip")).toHaveText(/No devices found on this network/);
  });
});

test.describe("title bar layout", () => {
  for (const width of [560, 800, 1120, 1600]) {
    test(`the title is centred on a ${width} px window`, async ({ page }) => {
      await page.setViewportSize({ width, height: 400 });
      await page.goto("/");
      const title = await box(page.getByRole("heading", { level: 1 }));
      expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThanOrEqual(0.5);
      // Vertically inside the 44 px bar.
      expect(title.y).toBeGreaterThanOrEqual(0);
      expect(title.y + title.height).toBeLessThanOrEqual(44);
    });
  }
});

test.describe("title bar with a long file name", () => {
  test("truncates in the middle, keeps both ends clear, and offers the full name", async ({
    page,
  }) => {
    await openGallery(page);
    const bar = page.getByTestId("titlebar-long").first();
    await bar.scrollIntoViewIfNeeded();
    const barBox = await box(bar);
    const heading = bar.getByRole("heading", { level: 1 });
    const title = await box(heading);
    const action = await box(bar.getByRole("button", { name: "Keep on top" }));

    // Clear of the traffic lights on the left and of the action on the right.
    expect(title.x).toBeGreaterThanOrEqual(barBox.x + 88);
    expect(title.x + title.width).toBeLessThanOrEqual(action.x);
    // One line, inside the bar.
    expect(title.height).toBeLessThanOrEqual(24);

    // Cut to fit exactly: the start of the name, an ellipsis, and its last
    // ten characters (where one episode differs from the next), as one run
    // of text with no gap before the end.
    const shown = heading.locator('[data-part="fitted"]');
    await expect(shown).toHaveText(/^The\.Extremely\.Long.*[^ ]…0p\.HDR\.mkv$/);
    const fitted = await box(shown);
    // It uses the room it has, to within one character, and no more.
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(title.x + title.width + 0.5);
    expect(title.width - 24 - fitted.width).toBeLessThan(12);

    const head = shown;
    await head.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/The\.Extremely\.Long.*\.mkv/);
  });

  test("a short title stays centred when there are no actions", async ({ page }) => {
    await openGallery(page);
    const bar = page.getByTestId("titlebar-short").first();
    await bar.scrollIntoViewIfNeeded();
    const barBox = await box(bar);
    const title = await box(bar.getByRole("heading", { level: 1 }));
    expect(Math.abs(title.x + title.width / 2 - (barBox.x + barBox.width / 2))).toBeLessThanOrEqual(
      0.5,
    );
  });
});

test.describe("scale", () => {
  test("ticks stand exactly under the needle when it rests on a mark", async ({ page }) => {
    await openGallery(page);
    const slider = page.getByRole("slider", { name: "Brightness" }).first();
    const needle = await box(slider);
    const root = slider.locator("xpath=ancestor::span[@data-orientation][1]");
    // The mark at 0 is the middle one of the brightness scale.
    const ticks = await root.locator('span[aria-hidden="true"].bg-ink-2').all();
    expect(ticks.length).toBe(1);
    const tick = await box(ticks[0] as Locator);
    // The 1 px tick lies within the 2 px needle, on its left half.
    expect(tick.x).toBeGreaterThanOrEqual(needle.x - 0.01);
    expect(tick.x + tick.width).toBeLessThanOrEqual(needle.x + needle.width + 0.01);
    // And it stands on the track: its bottom edge meets the track's top edge.
    const track = await box(root.locator("span").first());
    expect(Math.abs(tick.y + tick.height - track.y)).toBeLessThanOrEqual(1);
  });

  test("the keyboard crosses a mark; a drag snaps to it within six pixels", async ({ page }) => {
    await openGallery(page);
    const slider = page.getByRole("slider", { name: "Volume" }).first();
    await slider.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", "95");
    for (const expected of ["96", "97", "98", "99", "100", "101", "102"]) {
      await page.keyboard.press("ArrowRight");
      await expect(slider).toHaveAttribute("aria-valuenow", expected);
    }

    // Move the needle away first: a press on the needle's own grab area starts
    // a drag from where it is instead of jumping.
    const root = slider.locator("xpath=ancestor::span[@data-orientation][1]");
    const track = await box(root);
    const middle = track.x + track.width / 2;
    await slider.focus();
    await page.keyboard.press("Home");
    await page.mouse.click(middle - 4, track.y + track.height / 2);
    await expect(slider).toHaveAttribute("aria-valuenow", "100");

    await slider.focus();
    await page.keyboard.press("Home");
    await page.mouse.click(middle - 9, track.y + track.height / 2);
    await expect(slider).not.toHaveAttribute("aria-valuenow", "100");
    await expect(slider).not.toHaveAttribute("aria-valuenow", "0");
  });

  test("after pointer use, the arrow keys no longer belong to the scale", async ({ page }) => {
    await openGallery(page);
    const slider = page.getByRole("slider", { name: "Volume" }).first();
    const root = slider.locator("xpath=ancestor::span[@data-orientation][1]");
    const track = await box(root);
    await page.mouse.click(track.x + 20, track.y + track.height / 2);
    const before = await slider.getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", before ?? "");
  });

  test("names and values in a scale row never wrap or overlap", async ({ page }) => {
    await openGallery(page);
    const name = page.getByText("Noise reduction", { exact: true }).first();
    const nameBox = await box(name);
    expect(nameBox.height).toBeLessThanOrEqual(20);
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const slider = await box(
      page
        .getByRole("slider", { name: "Noise reduction" })
        .first()
        .locator("xpath=ancestor::span[@data-orientation][1]"),
    );
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(slider.x);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the working indicator rests and pressing does not scale", async ({ page }) => {
    await openGallery(page);
    const needle = page.locator(".animate-sweep").first();
    expect(await needle.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      "none",
    );
    const durations = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [
        style.getPropertyValue("--dur-fast").trim(),
        style.getPropertyValue("--dur-base").trim(),
      ];
    });
    expect(durations).toEqual(["100ms", "100ms"]);
  });
});

test.describe("stage", () => {
  test("controls over video use the dark tokens in a light window", async ({ page }) => {
    await openGallery(page);
    const stages = page.locator(".stage");
    await expect(stages).toHaveCount(2);
    const colours = await stages.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).color),
    );
    // Same ivory ink in both, whatever the surrounding theme.
    expect(colours[0]).toBe(colours[1]);
  });

  test("a scrim element is as tall as its gradient, so the gradient is never cut off", async ({
    page,
  }) => {
    await openGallery(page);
    const scrim = await box(page.locator(".bg-scrim-bottom").first());
    expect(scrim.height).toBe(156);
  });
});
