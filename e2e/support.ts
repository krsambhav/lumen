import { test as base, expect, type Locator, type Page } from "@playwright/test";

/**
 * The tests' `test`. A page here has the interface font in before anything
 * is done with it, as the app's window does: that is not shown until the
 * font is in. A box measured while the font is still on its way is measured
 * in another face, a pixel or two out, and only now and then.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const fontIn = () =>
      page.evaluate(async () => {
        await document.fonts.load('1em "Plus Jakarta Sans Variable"');
        await document.fonts.ready;
      });
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await fontIn();
      return response;
    };
    page.reload = async (options) => {
      const response = await reload(options);
      await fontIn();
      return response;
    };
    await use(page);
  },
});

export const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
export const FILM = "/Users/me/Films/The Long Take (2019).mkv";
/** The pretend film's length: 2:01:45. */
export const TWO_HOURS = 7305;
/** The stage's side padding, where the traffic lights, the timeline and the home screen all start. */
export const GUTTER = 20;

/** An element's box on the page; fails if it is not laid out. */
export async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) {
    throw new Error("element is not laid out");
  }
  return rect;
}

/** The app on its simulated backend, with nothing open. */
export async function openHome(page: Page) {
  await page.goto("/#mock");
  await expect(page.getByRole("heading", { name: "Drop a file to play" })).toBeVisible();
}

/** Opens the pretend film, paused by default so nothing moves under the test. */
export async function openFilm(page: Page, options: { position?: number; paused?: boolean } = {}) {
  await openHome(page);
  await page.evaluate(
    ({ source, duration, position, paused }) =>
      window.__lumenMock?.open({ source, duration, position, paused }),
    {
      source: FILM,
      duration: TWO_HOURS,
      position: options.position ?? 2537,
      paused: options.paused ?? true,
    },
  );
  await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
}

/** The pretend series: five episodes, the third with a very long name, the fifth of unknown length. */
export const EPISODES = [
  "/Users/me/Series/The Crossing S01E01 Departures.mkv",
  "/Users/me/Series/The Crossing S01E02 The Ferryman.mkv",
  "/Users/me/Series/The Crossing S01E03 A Very Long Episode Title That Goes On And On.mkv",
  "/Users/me/Series/The Crossing S01E04 Night Passage.mkv",
  "/Users/me/Series/The Crossing S01E05 Low Water.mkv",
];
/** The width of the panel beside the picture. */
export const PANEL = 348;

/** Opens a playlist of the pretend series, paused on its first episode ten minutes in. */
export async function openQueue(page: Page, sources: string[] = EPISODES) {
  await openHome(page);
  await page.evaluate((list) => {
    const mock = window.__lumenMock;
    if (mock) {
      mock.lengths["/Users/me/Series/The Crossing S01E05 Low Water.mkv"] = null;
      mock.openQueue(list, { paused: true, at: 600 });
    }
  }, sources);
  await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  // It says so once; the tests that are not about that do not want it in the
  // way. Escape closes it, and leaves the pointer where it was.
  await expect(page.getByText(/items in the playlist/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/items in the playlist/)).toHaveCount(0);
}

/**
 * Waits until nothing is on its way in or out: a panel sliding in, a menu
 * dropping, a toast leaving. Measuring something mid-flight gives numbers
 * that are true of no frame anyone sees.
 */
export async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // The working indicator sweeps for as long as work lasts; it is never "finished".
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Opens the panel beside the picture on the playlist, from its key. */
export async function showPlaylist(page: Page) {
  await page.keyboard.press("Meta+p");
  await expect(page.getByRole("listbox", { name: "Playlist" })).toBeVisible();
  await settle(page);
}

/** The home screen with things played before: see `#mock-history` in src/main.tsx. */
export async function openHistory(page: Page) {
  await page.goto("/#mock-history");
  await expect(page.getByRole("region", { name: "Recently played" })).toBeVisible();
}

/** True if two boxes share any area. */
export function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The arguments of every call the page has made to one backend command. */
export function calls(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window.__lumenMock?.calls ?? [])
        .filter((call) => call.command === name)
        .map((call) => call.args),
    command,
  );
}

/** The wrapper whose opacity is the control bar's visibility. */
export function controlBar(page: Page): Locator {
  return page
    .getByRole("group", { name: "Player controls" })
    .locator("xpath=ancestor::div[contains(@class,'z-chrome')][1]");
}

/** The visible box of whichever tooltip is open (the `role="tooltip"` element is its hidden copy). */
export function tooltipBox(page: Page): Locator {
  // One that is fading out is still in the tree for a moment; it does not count.
  return page.locator(
    '[data-radix-popper-content-wrapper] > [data-side]:not([data-state="closed"])',
  );
}

/**
 * Moves keyboard focus to the next control, as the Tab key does in the app.
 *
 * In the app, Tab stops at every control: the backend turns on the WebKit
 * preference for it (src-tauri/src/platform/macos/web_view.rs). A bare WebKit
 * follows the Keyboard navigation setting of macOS instead, and there
 * Option+Tab is the chord that always visits every control.
 */
export async function tab(page: Page): Promise<void> {
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  await page.keyboard.press(webkit ? "Alt+Tab" : "Tab");
}

/**
 * The WCAG contrast between two colours as the page computes them, in
 * whatever notation they come: each is painted on a canvas and read back as
 * sRGB. For text that assistive-technology checks skip (a placeholder, a
 * cell hidden from the accessibility tree because its row says it in words).
 */
export function contrast(page: Page, foreground: string, background: string): Promise<number> {
  return page.evaluate(
    ([text, fill]) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("no canvas to measure colours on");
      }
      const luminance = (colour: string | undefined) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = colour ?? "";
        context.fillRect(0, 0, 1, 1);
        const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
        const linear = (value: number) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
      };
      const one = luminance(text);
      const other = luminance(fill);
      return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
    },
    [foreground, background],
  );
}

/**
 * The on-screen display's label, as it is drawn. (A label that may be cut
 * to fit is in the page three times: once for assistive technology, once
 * unseen to be measured, and once to be read. This is the last.)
 */
export function osdLabel(page: Page, text: string): Locator {
  const exactly = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  return page.locator("[data-osd] [data-shown]").filter({ hasText: exactly });
}

/**
 * Moves the pointer to the middle of a control the way a hand does: across
 * the ground between, not by appearing there. A menu decides whether a
 * pointer leaving an item is on its way to that item's submenu from the
 * direction it has been travelling in, and a pointer that teleports has none.
 */
export async function glide(page: Page, control: Locator): Promise<void> {
  const target = await box(control);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
}

/** Tabs until `control` has focus. */
export async function tabTo(page: Page, control: Locator): Promise<void> {
  for (let presses = 0; presses < 20; presses += 1) {
    await tab(page);
    if (await control.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error("Tab never reached the control");
}

/**
 * Text that is not set in the interface font, as "text → font-family".
 *
 * The whole interface is Plus Jakarta Sans. A library that brings its own
 * stylesheet can quietly put the system font back, and jsdom cannot see it.
 * Key symbols (⌘ ⇧ ←) are the one deliberate exception: see shortcut.tsx.
 */
export function textNotInTheInterfaceFont(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const strays: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent || parent.closest("script, style, noscript")) {
        continue;
      }
      if (parent.classList.contains("font-[system-ui]")) {
        continue;
      }
      const family = getComputedStyle(parent).fontFamily.replace(/^["']/, "");
      if (!family.startsWith("Plus Jakarta Sans Variable")) {
        strays.push(`${text.slice(0, 40)} → ${family}`);
      }
    }
    return strays;
  });
}
