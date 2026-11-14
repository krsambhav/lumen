import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import {
  box,
  calls,
  FILM,
  GUTTER,
  openHistory,
  openHome,
  overlap,
  settle,
  tabTo,
  test,
  textNotInTheInterfaceFont,
  WCAG,
} from "./support";

test.describe("home", () => {
  test("says how to start and has no accessibility violations", async ({ page }) => {
    await openHome(page);
    await expect(page.getByRole("button", { name: "Open file…" })).toBeVisible();
    await expect(page.getByText(/plays MKV, MP4, MOV/)).toBeVisible();
    await expect(page.getByText("Command O")).toBeAttached();
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);
  });

  test("the button and the shortcut both open the panel", async ({ page }) => {
    await openHome(page);
    await page.getByRole("button", { name: "Open file…" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "The Long Take (2019)" }),
    ).toBeVisible();

    await page.evaluate(() => window.__lumenMock?.fail("/x.mkv"));
    await expect(page.getByRole("heading", { name: "Drop a file to play" })).toBeVisible();
    await page.keyboard.press("Meta+o");
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  });

  for (const [width, height] of [
    [560, 360],
    [1120, 680],
    [1728, 1080],
  ] as const) {
    test(`has one left edge, and a scale that spans the window, at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await openHome(page);
      // Measured together, once the font is in: boxes read one at a time
      // while the page settles do not belong to the same layout.
      await page.evaluate(() => document.fonts.ready);
      const [heading, button, line, ruler] = await page.evaluate(() => {
        const rect = (element: Element | null | undefined) => {
          const { x, y, width: w, height: h } = (element as Element).getBoundingClientRect();
          return { x, y, width: w, height: h };
        };
        const main = document.querySelector("main") as HTMLElement;
        return [
          rect(main.querySelector("h2")),
          rect(main.querySelector("button")),
          rect(main.querySelector("p")),
          rect(main.querySelector("[aria-hidden='true']")),
        ] as const;
      });

      // Everything starts at the gutter, under the traffic lights.
      for (const rect of [heading, button, line, ruler]) {
        expect(rect.x).toBe(GUTTER);
      }
      // The scale runs to the other gutter, less at most one division, and
      // is a whole number of divisions long so that it ends on a tick.
      const end = ruler.x + ruler.width;
      expect(end).toBeLessThanOrEqual(width - GUTTER);
      expect(end).toBeGreaterThan(width - GUTTER - 10);
      expect((ruler.width - 1) % 10).toBe(0);

      // A little above the middle, and wholly inside the window.
      const top = ruler.y;
      const bottom = button.y + button.height;
      const centre = (top + bottom) / 2;
      expect(centre).toBeLessThan(height / 2 + 1);
      expect(centre).toBeGreaterThan(height * 0.38);
      expect(top).toBeGreaterThanOrEqual(44);
      expect(bottom).toBeLessThanOrEqual(height - GUTTER);

      // In order, with room between: scale, headline, line, actions.
      expect(heading.y).toBeGreaterThanOrEqual(ruler.y + ruler.height + 24);
      expect(line.y).toBeGreaterThanOrEqual(heading.y + heading.height + 4);
      expect(button.y).toBeGreaterThanOrEqual(line.y + line.height + 16);
    });
  }

  test("the needle is lit in both themes", async ({ page }) => {
    await openHome(page);
    const needle = page.locator("main .needle");
    const dark = await needle.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const light = await needle.evaluate((element) => getComputedStyle(element).backgroundColor);
    // The same bright accent, not the dark ink the accent becomes for text on a light surface.
    expect(light).toBe(dark);
    // On a light surface it takes a line around it, or it would be yellow on white.
    await expect(needle).not.toHaveCSS("box-shadow", /rgba\(0, 0, 0, 0\)/);
  });
});

test.describe("a file that cannot be opened", () => {
  test("is explained on the home screen, in a sentence that stays", async ({ page }) => {
    await openHome(page);
    await page.evaluate(() =>
      window.__lumenMock?.fail(
        "/Users/me/Films/Broken.mkv",
        { kind: "missing" },
        "/Users/me/Films",
      ),
    );
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText(
      "Lumen could not find “Broken.mkv”: it may have been moved or renamed, or its disk is not connected.",
    );
    await expect(page.getByRole("heading", { name: "Drop a file to play" })).toBeVisible();
    // It is said where the user is looking, not in a toast.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);

    // Thirty words cannot be read on a five-second timer: it is still there.
    await page.waitForTimeout(6000);
    await expect(alert).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations).toEqual([]);
  });

  test("offers the way forward and what is left of the file", async ({ page }) => {
    await openHome(page);
    await page.evaluate(() =>
      window.__lumenMock?.fail(
        "/Users/me/Films/Broken.mkv",
        { kind: "missing" },
        "/Users/me/Films",
      ),
    );
    const open = page.getByRole("button", { name: "Open file…" });
    const show = page.getByRole("button", { name: "Show in Finder" });
    await expect(show).toBeVisible();
    // Side by side on one line, the primary action first.
    const [first, second] = [await box(open), await box(show)];
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.width + 8);
    expect(Math.abs(first.y + first.height / 2 - (second.y + second.height / 2))).toBeLessThan(1);

    await show.click();
    expect(await calls(page, "filesShowInFinder")).toEqual([{ path: "/Users/me/Films" }]);
  });

  test("gives each cause its own words", async ({ page }) => {
    await openHome(page);
    const say = async (reason: object) => {
      await page.evaluate(
        (given) => window.__lumenMock?.fail("/Films/Notes.mkv", given as never, null),
        reason,
      );
      return (await page.getByRole("alert").textContent()) ?? "";
    };
    expect(await say({ kind: "notMedia" })).toContain("is not a video or audio file");
    expect(await say({ kind: "noPermission" })).toContain("macOS will not let Lumen read");
    expect(await say({ kind: "other", message: "audio output initialization failed" })).toContain(
      "The playback engine reported: audio output initialization failed.",
    );
    // Nothing to show in the Finder for these: no button that would do nothing.
    await expect(page.getByRole("button", { name: "Show in Finder" })).toHaveCount(0);
  });

  test("is forgotten once something else opens", async ({ page }) => {
    await openHome(page);
    await page.evaluate(() => window.__lumenMock?.fail("/Films/Broken.mkv"));
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Open file…" }).click();
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    await page.evaluate(() => window.__lumenMock?.calls.length);
    // Back on the home screen later, there is no stale complaint.
    await page.evaluate(() => {
      const mock = window.__lumenMock;
      mock?.fail("/Films/Other.mkv", { kind: "notMedia" }, null);
    });
    await expect(page.getByRole("alert")).toContainText("Other.mkv");
    await expect(page.getByRole("alert")).not.toContainText("Broken.mkv");
  });

  test("still fits the smallest window", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 360 });
    await openHome(page);
    await page.evaluate(() =>
      window.__lumenMock?.fail(
        "/Users/me/Films/A Very Long Documentary Title That Goes On (Restored Edition, 2019).mkv",
        { kind: "noPermission" },
        "/Users/me/Films",
      ),
    );
    const alert = await box(page.getByRole("alert"));
    const show = await box(page.getByRole("button", { name: "Show in Finder" }));
    expect(alert.x + alert.width).toBeLessThanOrEqual(560 - GUTTER);
    expect(show.x + show.width).toBeLessThanOrEqual(560 - GUTTER);
    expect(show.y + show.height).toBeLessThanOrEqual(360 - 8);
    // The words do not run into the buttons under them.
    expect(show.y).toBeGreaterThanOrEqual(alert.y + alert.height + 16);
  });
});

test.describe("home, once something has been played", () => {
  test("keeps its lead at the top and lists what was played beneath it, on the one left edge", async ({
    page,
  }) => {
    await openHistory(page);
    const headline = await box(page.getByRole("heading", { name: "Drop a file to play" }));
    const label = await box(page.getByRole("heading", { name: "Recently played" }));
    const tiles = page.getByRole("region", { name: "Recently played" }).getByRole("button");
    const first = await box(tiles.first());
    expect(headline.x).toBe(GUTTER);
    expect(label.x).toBe(GUTTER);
    expect(first.x).toBe(GUTTER);
    // The lead comes first, then 48 px, then the label, then 12 px, then the tiles.
    const open = await box(page.getByRole("button", { name: "Open file…" }));
    expect(label.y - (open.y + open.height)).toBe(48);
    expect(first.y - (label.y + label.height)).toBe(12);
    // Someone who has played a film knows what Lumen plays.
    await expect(page.getByText(/plays MKV, MP4, MOV/)).toHaveCount(0);
  });

  for (const width of [560, 1120, 1728]) {
    test(`fills a ${width} px window with tiles no narrower than 168 px, in two rows at most`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#mock-history-24");
      const region = page.getByRole("region", { name: "Recently played" });
      await expect(region).toBeVisible();
      const tiles = await Promise.all(
        (await region.getByRole("button").all()).map((tile) => box(tile)),
      );

      // As many as fit at 168 px or more, six at most: a wider window gets larger tiles.
      const columns = Math.min(6, Math.floor((width - 2 * GUTTER + 16) / (168 + 16)));
      expect(tiles).toHaveLength(Math.min(24, columns * 2));
      const rows = new Set(tiles.map((tile) => Math.round(tile.y)));
      expect(rows.size).toBeLessThanOrEqual(2);
      for (const tile of tiles) {
        expect(tile.width).toBeGreaterThanOrEqual(168);
      }
      // Gutter to gutter, 16 px between neighbours.
      expect(tiles[0]?.x).toBe(GUTTER);
      const lastOfRow = tiles[columns - 1];
      expect(Math.round((lastOfRow?.x ?? 0) + (lastOfRow?.width ?? 0))).toBe(width - GUTTER);
      expect(Math.round((tiles[1]?.x ?? 0) - ((tiles[0]?.x ?? 0) + (tiles[0]?.width ?? 0)))).toBe(
        16,
      );
    });
  }

  test("draws each tile as a 16:9 picture over a name and one line about it", async ({ page }) => {
    await openHistory(page);
    const tile = page.getByRole("button", { name: /The Long Take/ });
    const picture = await box(tile.locator(".stage"));
    expect(Math.abs(picture.width / picture.height - 16 / 9)).toBeLessThan(0.01);
    await expect(tile).toHaveText(/1 h 19 min left/);

    // Where it was left: a 2 px scale along the picture's bottom edge, the needle at 2537 of 7305 s.
    const scale = await box(tile.locator("[data-progress]"));
    expect(scale.height).toBe(2);
    expect(Math.round(scale.y + scale.height)).toBe(Math.round(picture.y + picture.height));
    // Inset by the picture's corner radius, along the straight part of its edge.
    expect(scale.x - picture.x).toBe(10);
    expect(Math.round(picture.x + picture.width - (scale.x + scale.width))).toBe(10);
    const needle = await box(tile.locator("[data-progress] .needle"));
    const through = (needle.x + needle.width / 2 - scale.x) / scale.width;
    expect(Math.abs(through - 2537 / 7305)).toBeLessThan(0.005);

    // Names never wrap, however long, and every tile's name starts on the same line as its picture.
    const name = await box(tile.locator("[data-part], .truncate").first());
    expect(name.height).toBeLessThanOrEqual(20);
    expect(Math.round(name.x)).toBe(Math.round(picture.x));
  });

  test("says what cannot be found, and gives sound without a picture the mark instead of an empty box", async ({
    page,
  }) => {
    await openHistory(page);
    const gone = page.getByRole("button", { name: /A Film That Was Moved/ });
    await expect(gone).toHaveText(/Not found/);
    await expect(gone.locator(".stage")).toHaveCSS("opacity", "0.45");
    const sound = page.getByRole("button", { name: /Night Drive/ });
    await expect(sound.locator("svg")).toBeVisible();
    await expect(sound.locator("img")).toHaveCount(0);
    // Too short to resume: its length, and no scale.
    await expect(sound).toHaveText(/4 min/);
    await expect(sound.locator("[data-progress]")).toHaveCount(0);
  });

  test("carries a tile's focus ring on its picture, clear of the name under it", async ({
    page,
  }) => {
    await openHistory(page);
    const tile = page.getByRole("button", { name: /The Long Take/ });
    await tabTo(page, tile);
    const picture = tile.locator(".stage");
    await expect(tile).toHaveCSS("outline-style", "none");
    await expect(picture).toHaveCSS("outline-style", "solid");
    await expect(picture).toHaveCSS("outline-width", "2px");
    await expect(picture).toHaveCSS("outline-offset", "2px");
    // The ring's outer edge stops short of the name: 4 px out from the picture, 8 px of gap.
    const name = await box(tile.locator("[data-shown]"));
    const frame = await box(picture);
    expect(name.y - (frame.y + frame.height)).toBeGreaterThanOrEqual(8);
  });

  test("takes the keyboard to the next tile when one is removed, so Delete can be pressed again", async ({
    page,
  }) => {
    await openHistory(page);
    const tiles = page.getByRole("region", { name: "Recently played" }).getByRole("button");
    const count = await tiles.count();
    await tabTo(page, tiles.first());
    const second = await tiles.nth(1).getAttribute("aria-label");
    await page.keyboard.press("Delete");
    await expect(tiles).toHaveCount(count - 1);
    await expect(tiles.first()).toBeFocused();
    expect(await tiles.first().getAttribute("aria-label")).toBe(second);
  });

  test("lists saved playlists under what was played, names at the page's left edge", async ({
    page,
  }) => {
    await page.goto("/#mock-history");
    await expect(page.getByRole("region", { name: "Recently played" })).toBeVisible();
    await page.evaluate(() => {
      window.__lumenMock?.seedPlaylist("Friday night", ["/a.mkv", "/b.mkv"]);
      window.__lumenMock?.seedPlaylist(
        "A playlist with a name that is a good deal longer than the room it has on one line",
        ["/c.mkv"],
      );
    });
    // The home screen reads them when it is come back to; the palette reads them too.
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    const region = page.getByRole("region", { name: "Playlists" });
    await expect(region).toBeVisible();
    const rows = region.getByRole("button");
    await expect(rows).toHaveCount(2);
    await expect(region.getByRole("button", { name: /Friday night/ })).toContainText(
      "2 items · 4 h 4 min",
    );

    // Under the tiles, 32 px after them; its label and the rows' icons on the gutter.
    const played = await box(page.getByRole("region", { name: "Recently played" }));
    const list = await box(region);
    expect(list.y - (played.y + played.height)).toBe(32);
    expect(list.x).toBe(GUTTER);
    for (const row of await rows.all()) {
      const rect = await box(row);
      expect(rect.height).toBe(44);
      // The icon is 8 px inside the row's fill, which reaches that far past the words.
      expect((await box(row.locator("svg"))).x).toBe(rect.x + 8);
      // A long name is cut to its line; it never widens its column or wraps.
      const name = await box(row.locator(".truncate").first());
      expect(name.height).toBeLessThanOrEqual(20);
      expect(name.x + name.width).toBeLessThanOrEqual(rect.x + rect.width - 8 + 0.5);
    }
    const [first, second] = await Promise.all([box(rows.nth(0)), box(rows.nth(1))]);
    // The first column's words are on the gutter; the next column is on the same line, clear of it.
    expect(first.x + 8).toBe(GUTTER);
    expect(second.y).toBe(first.y);
    expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(8);
    expect(overlap(first, second)).toBe(false);

    await region.getByRole("button", { name: /Friday night/ }).click();
    expect(await calls(page, "playlistsOpen")).toHaveLength(1);
  });

  test("plays a tile from where it was left, and says so", async ({ page }) => {
    await openHistory(page);
    await page.getByRole("button", { name: /The Long Take/ }).click();
    expect(await calls(page, "playlistOpen")).toEqual([{ sources: [FILM], resume: true }]);
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    // In a toast, which can offer the other choice; the on-screen display could not.
    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Resumed at 0:42:14");
    await expect(page.locator("[data-osd]")).toHaveText("");
    await toast.getByRole("button", { name: "Start over" }).click();
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 0, exact: true });
    await expect(toast).toHaveCount(0);
  });

  test("starts over from a tile's menu, and removes it with Undo", async ({ page }) => {
    await openHistory(page);
    const tile = page.getByRole("button", { name: /Solaris/ });
    await tile.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await settle(page);
    // Every item is 28 px and the same width; the menu is no wider than 320 px.
    const items = await Promise.all(
      (await menu.getByRole("menuitem").all()).map((item) => box(item)),
    );
    expect(new Set(items.map((item) => item.height))).toEqual(new Set([28]));
    expect(new Set(items.map((item) => Math.round(item.width))).size).toBe(1);
    expect((await box(menu)).width).toBeLessThanOrEqual(320);

    await page.getByRole("menuitem", { name: "Remove from recently played" }).click();
    await expect(page.getByRole("button", { name: /Solaris/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("button", { name: /Solaris/ })).toBeVisible();

    await page.getByRole("button", { name: /Solaris/ }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Play from the beginning" }).click();
    expect((await calls(page, "playlistOpen")).at(-1)).toEqual({
      sources: ["/Users/me/Films/Solaris (1972).mkv"],
      resume: false,
    });
  });

  test("scrolls in a window too short for it, with nothing cut off sideways", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 360 });
    await openHistory(page);
    const main = page.getByRole("main");
    const scrolls = await main.evaluate((element) => ({
      vertical: element.scrollHeight > element.clientHeight,
      sideways: element.scrollWidth > element.clientWidth,
    }));
    expect(scrolls).toEqual({ vertical: true, sideways: false });
  });

  test("has no WCAG A or AA violations, in either theme", async ({ page }) => {
    await openHistory(page);
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
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);
  });
});
