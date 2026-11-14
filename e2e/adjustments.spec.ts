import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { box, calls, PANEL, settle, tab, test, WCAG } from "./support";

const WIDTH = 1120 + PANEL;

/** The tabs with adjustments, and the keys that open each. */
const TABS = [
  { name: "Video", key: "Shift+Meta+v" },
  { name: "Audio", key: "Shift+Meta+a" },
] as const;

/** Opens the pretend film (paused, with its tracks) and then one tab from its keys. */
async function openTab(page: Page, key: string, name: string): Promise<Locator> {
  await page.goto("/#mock-film");
  await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  await page.keyboard.press(key);
  const panel = page.getByRole("complementary", { name: "Panel" });
  await expect(panel.getByRole("heading", { level: 2, name })).toBeVisible();
  await settle(page);
  return panel;
}

/** The column the tab's groups stand in, which scrolls. */
function column(panel: Locator): Locator {
  return panel.locator('[role="tabpanel"][data-state="active"] .overflow-y-auto');
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The boxes of each visible child of every row in the column that matches `selector`. */
function rowsOf(panel: Locator, selector: string): Promise<{ row: Rect; cells: Rect[] }[]> {
  return column(panel).evaluate((root, wanted) => {
    const rect = (element: Element): Rect => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return Array.from(root.querySelectorAll(wanted)).map((row) => ({
      row: rect(row),
      cells: Array.from(row.children)
        .filter((child) => child.getClientRects().length > 0)
        .map(rect),
    }));
  }, selector);
}

for (const { name, key } of TABS) {
  test.describe(`the ${name} tab`, () => {
    test.use({ viewport: { width: WIDTH, height: 680 } });

    test("has no WCAG A or AA violations", async ({ page }) => {
      await openTab(page, key, name);
      const results = await new AxeBuilder({ page })
        .withTags(WCAG)
        // The panel is drawn on its own opaque fill, so its contrast can be computed here.
        .include('aside[aria-label="Panel"]')
        .analyze();
      expect(
        results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`),
      ).toEqual([]);
    });

    test("lines up the name, scale and value of every scale row", async ({ page }) => {
      const panel = await openTab(page, key, name);
      const rows = await rowsOf(panel, ":scope .h-8:has([data-reading])");
      expect(rows.length).toBeGreaterThan(0);
      const [first] = rows;
      if (!first) {
        throw new Error("no scale rows");
      }
      for (const { row, cells } of rows) {
        expect(row.height).toBe(32);
        expect(cells).toHaveLength(3);
        const [label, scale, value] = cells as [Rect, Rect, Rect];
        const [label0, scale0, value0] = first.cells as [Rect, Rect, Rect];
        // The name's column is 112 px and the value's 56 px, in every row alike.
        expect(label.width).toBe(112);
        expect(value.width).toBe(56);
        expect(label.x).toBe(label0.x);
        expect(scale.x).toBe(scale0.x);
        expect(scale.x + scale.width).toBe(scale0.x + scale0.width);
        expect(value.x + value.width).toBe(value0.x + value0.width);
        // 12 px between the three, nothing touching or overlapping.
        expect(scale.x - (label.x + label.width)).toBe(12);
        expect(value.x - (scale.x + scale.width)).toBe(12);
      }
    });

    test("keeps group headings 28 px and rows 32 px, nothing overlapping across a row", async ({
      page,
    }) => {
      const panel = await openTab(page, key, name);
      const headings = await column(panel).evaluate((root) =>
        Array.from(root.querySelectorAll("section > div:first-child")).map(
          (row) => row.getBoundingClientRect().height,
        ),
      );
      expect(headings.length).toBeGreaterThan(1);
      for (const height of headings) {
        expect(height).toBe(28);
      }

      const edges = await box(column(panel));
      const rows = await rowsOf(panel, ":scope section .h-8, :scope section label.min-h-8");
      expect(rows.length).toBeGreaterThan(2);
      for (const { row, cells } of rows) {
        expect(row.height).toBeGreaterThanOrEqual(32);
        for (let one = 0; one < cells.length; one += 1) {
          for (let other = one + 1; other < cells.length; other += 1) {
            const a = cells[one] as Rect;
            const b = cells[other] as Rect;
            const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5;
            expect(apart, `cells ${one} and ${other} of a row at y=${row.y}`).toBe(true);
          }
          // And nothing reaches past the column, where the scroll container would cut it off.
          const cell = cells[one] as Rect;
          expect(cell.x).toBeGreaterThanOrEqual(edges.x);
          expect(cell.x + cell.width).toBeLessThanOrEqual(edges.x + edges.width);
        }
      }
    });

    test("takes the keyboard to its first control, whose focus ring is not cut off", async ({
      page,
    }) => {
      const panel = await openTab(page, key, name);
      const focused = page.locator(":focus");
      await expect(focused).toHaveCount(1);
      expect(
        await focused.evaluate(
          (element, root) => root?.contains(element),
          await panel.elementHandle(),
        ),
      ).toBe(true);
      const ring = await focused.evaluate((element) => {
        const style = getComputedStyle(element);
        const reach =
          Number.parseFloat(style.outlineOffset || "0") +
          Number.parseFloat(style.outlineWidth || "0");
        const rect = element.getBoundingClientRect();
        let clip = element.parentElement;
        while (clip && getComputedStyle(clip).overflowY === "visible") {
          clip = clip.parentElement;
        }
        const edge = clip?.getBoundingClientRect();
        return {
          style: style.outlineStyle,
          reach,
          top: rect.top - reach,
          left: rect.left - reach,
          right: rect.right + reach,
          clipTop: edge?.top ?? 0,
          clipLeft: edge?.left ?? 0,
          clipRight: edge?.right ?? 0,
        };
      });
      expect(ring.style).not.toBe("none");
      expect(ring.reach).toBeGreaterThan(0);
      expect(ring.top).toBeGreaterThanOrEqual(ring.clipTop);
      expect(ring.left).toBeGreaterThanOrEqual(ring.clipLeft);
      expect(ring.right).toBeLessThanOrEqual(ring.clipRight);
    });
  });
}

test.describe("the Video tab from the keyboard", () => {
  test.use({ viewport: { width: WIDTH, height: 680 } });

  test("reaches every control with Tab, in reading order", async ({ page }) => {
    const panel = await openTab(page, "Shift+Meta+v", "Video");
    const reached: string[] = [];
    const root = await panel.elementHandle();
    for (let press = 0; press < 30; press += 1) {
      // The name of what has the keyboard, while it is in the panel.
      const focused = await page.evaluate((panelRoot) => {
        const element = document.activeElement;
        if (!element || !panelRoot?.contains(element)) {
          return null;
        }
        return (
          element.getAttribute("aria-label") ??
          element.textContent?.replace(/\s+/g, " ").trim() ??
          ""
        );
      }, root);
      if (focused === null) {
        break;
      }
      reached.push(focused);
      await tab(page);
    }
    // The preset picker's name is its hidden label and the present choice.
    expect(reached[0]).toMatch(/^Picture preset:\s?Neutral$/);
    expect(reached.slice(1, 8)).toEqual([
      "Brightness",
      "Contrast",
      "Saturation",
      "Gamma",
      "Hue",
      "Sharpness",
      "Noise reduction",
    ]);
    expect(reached[8]).toMatch(/^Aspect:\s?Original$/);
    expect(reached[9]).toMatch(/^Crop:\s?None$/);
    expect(reached.slice(10, 15)).toEqual([
      "Zoom",
      "Rotate anticlockwise",
      "Rotate clockwise",
      "Mirror",
      "Flip",
    ]);
    expect(reached[15]).toMatch(/^Deinterlace:\s?Off$/);
  });

  test("names each picker for what it chooses and what is chosen", async ({ page }) => {
    const panel = await openTab(page, "Shift+Meta+v", "Video");
    // In a browser the words keep their space: "Aspect: Original".
    await expect(
      panel.getByRole("button", { name: "Aspect: Original", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Picture preset: Neutral", exact: true }),
    ).toBeVisible();
  });

  test("moves a scale with the arrows, reading the new value with its sign", async ({ page }) => {
    const panel = await openTab(page, "Shift+Meta+v", "Video");
    const brightness = panel.getByRole("slider", { name: "Brightness" });
    const reading = brightness.locator(
      "xpath=ancestor::div[contains(@class,'h-8')][1]//*[@data-reading]",
    );
    await expect(reading).toHaveText("0");
    const neutral = await reading.evaluate((element) => getComputedStyle(element).color);

    await brightness.focus();
    await page.keyboard.press("ArrowRight");
    await expect(brightness).toHaveAttribute("aria-valuenow", "1");
    await expect(reading).toHaveText("+1");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(brightness).toHaveAttribute("aria-valuenow", "-9");
    await expect(reading).toHaveText("−9");
    await expect(brightness).toHaveAttribute("aria-valuetext", "minus 9");
    // Changed from neutral, the reading is drawn in full ink.
    await settle(page);
    expect(await reading.evaluate((element) => getComputedStyle(element).color)).not.toBe(neutral);
    // The preset no longer names it.
    await expect(
      panel.getByRole("button", { name: "Picture preset: Custom", exact: true }),
    ).toBeVisible();
    // And what was set reached the backend.
    await expect
      .poll(async () => {
        const saved = (await calls(page, "settingsSet")) as {
          settings: { video: { picture: { brightness: number } } };
        }[];
        return saved.at(-1)?.settings.video.picture.brightness;
      })
      .toBe(-9);
  });

  test("shows the frame's Reset only once the frame is changed, without moving the rows", async ({
    page,
  }) => {
    const panel = await openTab(page, "Shift+Meta+v", "Video");
    const frame = panel.getByRole("region", { name: "Frame" });
    await expect(frame.getByRole("button", { name: "Reset" })).toHaveCount(0);
    const aspect = await box(frame.getByRole("button", { name: /^Aspect/ }));
    await frame.getByRole("button", { name: "Mirror" }).click();
    await expect(frame.getByRole("button", { name: "Reset" })).toBeVisible();
    expect((await box(frame.getByRole("button", { name: /^Aspect/ }))).y).toBe(aspect.y);
    await frame.getByRole("button", { name: "Reset" }).click();
    await expect(frame.getByRole("button", { name: "Reset" })).toHaveCount(0);
  });
});

test.describe("the Audio tab's lists", () => {
  test.use({ viewport: { width: WIDTH, height: 680 } });

  test("names the film's sound tracks as a person would", async ({ page }) => {
    const panel = await openTab(page, "Shift+Meta+a", "Audio");
    const tracks = panel.getByRole("radiogroup", { name: "Audio track" }).getByRole("radio");
    await expect(tracks).toHaveCount(2);
    await expect(tracks.nth(0)).toHaveAccessibleName("English, 5.1 · Dolby Digital");
    await expect(tracks.nth(1)).toHaveAccessibleName("French · Version française, Stereo · AAC");
    await expect(tracks.nth(0)).toHaveAttribute("aria-checked", "true");
    // Each row is 28 px, its format at the trailing end clear of the name.
    for (const index of [0, 1]) {
      expect((await box(tracks.nth(index))).height).toBe(28);
    }
  });

  test("lines the ten bands of the equaliser up in one row of one height", async ({ page }) => {
    const panel = await openTab(page, "Shift+Meta+a", "Audio");
    const bands = panel.getByRole("group", { name: "Equaliser bands" }).getByRole("slider");
    await expect(bands).toHaveCount(10);
    const centres: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const band = await box(bands.nth(index));
      centres.push(band.y + band.height / 2);
    }
    // Every needle at 0 dB stands on one line.
    for (const centre of centres) {
      expect(Math.abs(centre - (centres[0] ?? 0))).toBeLessThanOrEqual(0.5);
    }
  });
});
