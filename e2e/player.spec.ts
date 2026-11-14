import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  box,
  calls,
  controlBar,
  GUTTER,
  glide,
  openFilm,
  openHome,
  openQueue,
  osdLabel,
  overlap,
  settle,
  TWO_HOURS,
  tab,
  tabTo,
  test,
  textNotInTheInterfaceFont,
  tooltipBox,
  WCAG,
} from "./support";

function playButton(page: Page): Locator {
  return page.getByRole("button", { name: "Play", exact: true });
}

function readout(page: Page): Locator {
  return page.getByRole("button", { name: /of 2 hours 1 minute/ });
}

/** The room the volume scale stands in: what is folded away on a narrow stage. */
function volumeRoom(page: Page): Locator {
  return volumeScale(page).locator("xpath=..");
}

/** The scale the volume needle runs along. */
function volumeScale(page: Page): Locator {
  return page
    .getByRole("slider", { name: "Volume" })
    .locator("xpath=ancestor::span[@data-orientation][1]");
}

test.describe("stage", () => {
  test("has no accessibility violations", async ({ page }) => {
    await openFilm(page);
    const results = await new AxeBuilder({ page })
      .withTags(WCAG)
      // Text here sits on a scrim over video; its contrast is proven for a
      // white picture in color.test.ts, which axe cannot see.
      .disableRules(["color-contrast"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  for (const width of [560, 720, 1120, 1728]) {
    test(`controls are aligned, grouped and never overlap at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: Math.round((width * 9) / 16) });
      await openFilm(page);

      const play = await box(playButton(page));
      const stop = await box(page.getByRole("button", { name: "Stop" }));
      const mute = await box(page.getByRole("button", { name: "Mute" }));
      const time = await box(readout(page));
      const full = await box(page.getByRole("button", { name: "Enter full screen" }));
      const timeline = await box(page.getByRole("slider", { name: "Position" }));

      // The timeline runs gutter to gutter, above the row.
      expect(timeline.x).toBe(GUTTER);
      expect(Math.round(timeline.x + timeline.width)).toBe(width - GUTTER);
      expect(timeline.y + timeline.height).toBeLessThanOrEqual(play.y);

      // The first and last icon, not their hover boxes, meet the ends of the
      // track: an 18 px icon is centred in a 36 px button, 9 px in.
      expect(play.x + 9).toBe(GUTTER);
      expect(Math.round(full.x + full.width - 9)).toBe(width - GUTTER);

      // Groups are 12 px apart; nothing touches.
      expect(stop.x - (play.x + play.width)).toBe(4);
      expect(mute.x - (stop.x + stop.width)).toBe(12);
      const volume = page.getByRole("slider", { name: "Volume" });
      if (width < 720) {
        // Folded into Mute: it takes no room in the row, is not seen and cannot be touched,
        // and leaves no gap behind.
        await expect(volumeRoom(page)).toHaveCSS("opacity", "0");
        await expect(volumeRoom(page)).toHaveCSS("pointer-events", "none");
        await expect(volume).toBeAttached();
        expect(time.x - (mute.x + mute.width)).toBe(12);
      } else {
        const scale = await box(volumeScale(page));
        expect(scale.width).toBe(96);
        expect(scale.x - (mute.x + mute.width)).toBe(4);
        expect(time.x - (scale.x + scale.width)).toBe(12);
      }
      expect(full.x).toBeGreaterThanOrEqual(time.x + time.width + 12);

      // One centre line.
      const centre = play.y + play.height / 2;
      for (const rect of [mute, time, full]) {
        expect(Math.abs(rect.y + rect.height / 2 - centre)).toBeLessThanOrEqual(0.5);
      }

      // The title is centred and clear of the traffic lights.
      const title = await box(page.getByRole("heading", { level: 1 }));
      expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThanOrEqual(0.5);
      expect(title.x).toBeGreaterThanOrEqual(88);
    });
  }

  test("the scrims are no longer than the text needs", async ({ page }) => {
    await openFilm(page);
    expect((await box(page.locator(".bg-scrim-bottom").first())).height).toBe(156);
    const top = await page
      .locator("header")
      .evaluate((header) => Number.parseFloat(getComputedStyle(header, "::before").height));
    expect(top).toBe(96);
  });

  test("the transport glyphs are solid shapes with no rim", async ({ page }) => {
    await openFilm(page);
    for (const button of [playButton(page)]) {
      const shape = button.locator("svg path, svg rect").first();
      await expect(shape).toHaveCSS("stroke", "none");
    }
    await page.keyboard.press("Space");
    const pause = page.getByRole("button", { name: "Pause" }).locator("svg rect").first();
    await expect(pause).toHaveCSS("stroke", "none");
  });

  test("the time readout does not change width as it counts", async ({ page }) => {
    await openFilm(page, { position: 71 });
    const before = await box(readout(page));
    await page.evaluate(() =>
      window.__lumenMock?.open({ source: "/a.mkv", duration: 7305, position: 6888, paused: true }),
    );
    await expect(readout(page)).toContainText("1:54:48");
    expect((await box(readout(page))).width).toBe(before.width);
  });

  test("the time readout switches between total and remaining", async ({ page }) => {
    await openFilm(page);
    const total = page.getByRole("button", { name: "42 minutes 17 seconds of 2 hours 1 minute" });
    await expect(total.locator('[aria-hidden="true"]').first()).toHaveText("0:42:17/2:01:45");

    // The tooltip says what a click will do.
    await total.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Show time remaining");

    await total.click();
    const remaining = page.getByRole("button", {
      name: "42 minutes 17 seconds played, 1 hour 19 minutes remaining",
    });
    // No slash: "−1:19:28" already says it is what is left.
    await expect(remaining.locator('[aria-hidden="true"]').first()).toHaveText("0:42:17−1:19:28");
    const figures = remaining.locator(".tabular");
    const [elapsed, left] = [await box(figures.nth(0)), await box(figures.nth(1))];
    expect(left.x - (elapsed.x + elapsed.width)).toBe(8);
  });

  test("at the end it offers to play again, with its own glyph", async ({ page }) => {
    await openFilm(page, { paused: false, position: TWO_HOURS - 0.3 });
    const again = page.getByRole("button", { name: "Play again" });
    await expect(again).toBeVisible();
    await expect(again).toHaveAttribute("aria-keyshortcuts", "Space");
    await again.click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(await page.evaluate(() => window.__lumenMock?.snapshot().position)).toBeLessThan(5);
  });
});

test.describe("tooltips on the stage", () => {
  test("open above the timeline and never cover the track", async ({ page }) => {
    await openFilm(page);
    const timeline = await box(page.getByRole("slider", { name: "Position" }));
    const bottoms: number[] = [];
    for (const control of [
      playButton(page),
      page.getByRole("button", { name: "Mute" }),
      readout(page),
      page.getByRole("button", { name: "Enter full screen" }),
    ]) {
      await control.hover();
      const tip = tooltipBox(page);
      await expect(tip).toBeVisible();
      const rect = await box(tip);
      // Clear of the whole timeline, not just its 2 px track.
      expect(rect.y + rect.height).toBeLessThanOrEqual(timeline.y);
      bottoms.push(Math.round(rect.y + rect.height));
      await page.mouse.move(600, 200);
      await expect(tip).toBeHidden();
    }
    // All on one line: the one the timeline's own hover timecode uses.
    expect(new Set(bottoms).size).toBe(1);
    expect(timeline.y - (bottoms[0] ?? 0)).toBe(4);
  });

  test("never take a click meant for the seek bar", async ({ page }) => {
    await openFilm(page);
    await playButton(page).hover();
    await expect(tooltipBox(page)).toBeVisible();
    const track = await box(page.getByRole("slider", { name: "Position" }));
    // Straight up from Play onto the track, where the tooltip used to sit.
    await page.mouse.move(track.x + 20, track.y + track.height / 2, { steps: 4 });
    await page.mouse.down();
    await page.mouse.up();
    const seeks = (await calls(page, "playerSeekTo")) as { seconds: number; exact: boolean }[];
    expect(seeks.at(-1)?.exact).toBe(true);
    expect(seeks.at(-1)?.seconds ?? 0).toBeLessThan(200);
    // And moving onto a tooltip closes it: it is a label, not a surface.
    await expect(tooltipBox(page)).toBeHidden();
  });

  test("the volume needle's tooltip names the level, and sits on the same line", async ({
    page,
  }) => {
    await openFilm(page);
    const timeline = await box(page.getByRole("slider", { name: "Position" }));
    await tabTo(page, page.getByRole("slider", { name: "Volume" }));
    const tip = tooltipBox(page);
    await expect(tip).toContainText("Volume 100%");
    // Two keys work it; both are shown.
    await expect(tip.locator("kbd")).toHaveCount(2);
    const rect = await box(tip);
    expect(timeline.y - Math.round(rect.y + rect.height)).toBe(4);
  });
});

test.describe("volume", () => {
  test("a dragged needle lands on every multiple of five, and nowhere else", async ({ page }) => {
    await openFilm(page);
    const scale = await box(volumeScale(page));
    const y = scale.y + scale.height / 2;
    // From about 55% to about 145%, a quarter of a pixel at a time.
    const from = scale.x + scale.width * 0.41;
    const to = scale.x + scale.width * 0.87;
    await page.mouse.move(from, y);
    await page.mouse.down();
    for (let x = from; x <= to; x += 0.25) {
      await page.mouse.move(x, y);
    }
    await page.mouse.up();

    const levels = ((await calls(page, "playerSetVolume")) as { percent: number }[]).map(
      (call) => call.percent,
    );
    expect(levels.every((level) => level % 5 === 0)).toBe(true);
    // Every step between is reachable: none skipped, on either side of normal.
    const reached = new Set(levels);
    for (let level = 60; level <= 140; level += 5) {
      expect(reached.has(level), `${level}%`).toBe(true);
    }
  });

  test("ordinary levels have three quarters of the scale, with the mark at normal", async ({
    page,
  }) => {
    await openFilm(page);
    const scale = await box(volumeScale(page));
    const needle = await box(page.getByRole("slider", { name: "Volume" }));
    // At 100% the needle stands three quarters of the way along.
    expect(Math.abs(needle.x + 1 - (scale.x + scale.width * 0.75))).toBeLessThanOrEqual(1.5);

    await page.evaluate(() => window.__lumenMock?.snapshot());
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    // 80%: the mark at 100% is clear of the needle and showing.
    const mark = volumeScale(page).locator("[data-mark]");
    await expect(mark).toHaveCSS("opacity", "1");
    const tick = await box(mark);
    expect(Math.abs(tick.x - (scale.x + scale.width * 0.75))).toBeLessThanOrEqual(1.5);
  });

  test("the mark steps aside rather than fuse with the needle beside it", async ({ page }) => {
    await openFilm(page);
    const mark = volumeScale(page).locator("[data-mark]");
    // At 100% the needle stands on it; one press either way it is right beside it.
    await expect(mark).toHaveCSS("opacity", "0");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByText("105%")).toBeVisible();
    await expect(mark).toHaveCSS("opacity", "0");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(mark).toHaveCSS("opacity", "0");
  });

  test("its tooltip follows the needle and reads the level while it is dragged", async ({
    page,
  }) => {
    await openFilm(page);
    const scale = await box(volumeScale(page));
    const y = scale.y + scale.height / 2;
    await page.mouse.move(scale.x + scale.width * 0.3, y);
    await page.mouse.down();
    const tip = tooltipBox(page);
    await expect(tip).toContainText("Volume 40%");
    const first = await box(tip);
    await page.mouse.move(scale.x + scale.width * 0.6, y, { steps: 6 });
    await expect(tip).toContainText("Volume 80%");
    const second = await box(tip);
    expect(second.x).toBeGreaterThan(first.x + 20);
    await page.mouse.up();
    await page.mouse.move(600, 200);
    await expect(tip).toBeHidden();
  });

  test("goes to normal on End, never to full boost on one key", async ({ page }) => {
    await openFilm(page);
    await tabTo(page, page.getByRole("slider", { name: "Volume" }));
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    expect(await calls(page, "playerSetVolume")).toEqual([{ percent: 0 }, { percent: 100 }]);
  });

  test("while muted the scale dims, and changing the level turns the sound back on", async ({
    page,
  }) => {
    await openFilm(page);
    const needle = page.getByRole("slider", { name: "Volume" });
    const lit = await needle.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.keyboard.press("m");
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
    await expect(needle).not.toHaveCSS("background-color", lit);
    await expect(needle).toHaveAttribute("aria-valuetext", "100 percent, muted");

    // Nobody raises the volume in order to keep hearing nothing.
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("button", { name: "Mute" })).toBeVisible();
    await expect(page.getByText("105%")).toBeVisible();
    await expect(needle).toHaveCSS("background-color", lit);
  });

  test("in a narrow window the scale opens beside Mute for the pointer and the keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 560, height: 360 });
    await openFilm(page);
    const mute = page.getByRole("button", { name: "Mute" });
    await expect(volumeRoom(page)).toHaveCSS("opacity", "0");
    const before = {
      mute: await box(mute),
      time: await box(readout(page)),
      more: await box(page.getByRole("button", { name: "More" })),
    };

    await mute.hover();
    await expect(volumeRoom(page)).toHaveCSS("opacity", "1");
    // It opens over the readout, which steps aside for it: nothing in the row moves.
    await expect(readout(page).locator("xpath=..")).toHaveCSS("opacity", "0");
    const scale = await box(volumeScale(page));
    expect(scale.width).toBe(96);
    expect(scale.x - (before.mute.x + before.mute.width)).toBe(4);
    expect(Math.abs(scale.y + scale.height / 2 - (before.mute.y + before.mute.height / 2))).toBe(0);
    expect(await box(mute)).toEqual(before.mute);
    expect(await box(readout(page))).toEqual(before.time);
    expect(await box(page.getByRole("button", { name: "More" }))).toEqual(before.more);
    // Clear of the right-hand group, with room to spare.
    expect(before.more.x - (scale.x + scale.width)).toBeGreaterThanOrEqual(12);

    // And it can be used: a press on it sets the level.
    await page.mouse.click(scale.x + scale.width * 0.375, scale.y + scale.height / 2);
    expect((await calls(page, "playerSetVolume")).at(-1)).toEqual({ percent: 50 });

    await page.mouse.move(400, 150);
    await expect(volumeRoom(page)).toHaveCSS("opacity", "0");
    await expect(readout(page).locator("xpath=..")).toHaveCSS("opacity", "1");
    // Folded, it cannot be pressed by accident where the readout is: a click there is the readout's.
    await readout(page).click();
    await expect(page.getByRole("button", { name: /remaining/ })).toBeVisible();
    expect(await calls(page, "playerSetVolume")).toHaveLength(1);
    await page.getByRole("button", { name: /remaining/ }).click();
    await page.mouse.move(400, 150);

    // A click on Mute leaves focus on it, which must not hold the scale open once the pointer has gone.
    await mute.click();
    await page.mouse.move(400, 150);
    await expect(volumeRoom(page)).toHaveCSS("opacity", "0");

    // From the keyboard, focus on the needle opens it too.
    await tabTo(page, page.getByRole("slider", { name: "Volume" }));
    await expect(volumeRoom(page)).toHaveCSS("opacity", "1");
    await expect(readout(page).locator("xpath=..")).toHaveCSS("opacity", "0");
  });
});

test.describe("chrome", () => {
  test("dims after two seconds without movement and returns on movement", async ({ page }) => {
    await openFilm(page, { paused: false });
    const bar = controlBar(page);
    await page.mouse.move(300, 200);
    await page.mouse.move(320, 210);
    await expect(bar).toHaveCSS("opacity", "1");

    await expect(bar).toHaveCSS("opacity", "0", { timeout: 4000 });
    expect(await page.evaluate(() => window.__lumenMock?.chromeVisible)).toBe(false);
    await expect(page.locator(".stage").first()).toHaveCSS("cursor", "none");

    await page.mouse.move(340, 230);
    await expect(bar).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => window.__lumenMock?.chromeVisible)).toBe(true);
  });

  test("a nudge of a pixel or two does not raise it", async ({ page }) => {
    await openFilm(page, { paused: false });
    const bar = controlBar(page);
    await page.mouse.move(300, 200);
    await expect(bar).toHaveCSS("opacity", "0", { timeout: 4000 });
    await page.mouse.move(301, 200);
    await page.mouse.move(302, 201);
    await page.mouse.move(300, 200);
    await page.waitForTimeout(300);
    await expect(bar).toHaveCSS("opacity", "0");
    // Real travel does.
    await page.mouse.move(306, 204);
    await expect(bar).toHaveCSS("opacity", "1");
  });

  test("goes when the pointer has left a button whose icon the click changed", async ({ page }) => {
    // Paused: here a pointer resting on the controls would keep the chrome for as long as it rests.
    await openFilm(page);
    const bar = controlBar(page);
    // The click swaps the icon that was under the pointer for another. The
    // engine must still be told that the pointer then left the controls,
    // or the chrome would wait there for ever.
    await page.getByRole("button", { name: "Mute" }).click();
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
    await page.mouse.move(400, 150, { steps: 6 });
    await expect(bar).toHaveCSS("opacity", "0", { timeout: 4000 });

    // And the same for Play, whose glyph changes too.
    await page.mouse.move(420, 170, { steps: 3 });
    await expect(bar).toHaveCSS("opacity", "1");
    await playButton(page).click();
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(playButton(page)).toBeVisible();
    await page.mouse.move(400, 150, { steps: 6 });
    await expect(bar).toHaveCSS("opacity", "0", { timeout: 4000 });
  });

  test("a pointer left on Play does not pin it for the whole film", async ({ page }) => {
    await openFilm(page);
    const bar = controlBar(page);
    await playButton(page).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    // Resting on the control keeps it a little longer than the picture would...
    await page.waitForTimeout(2300);
    await expect(bar).toHaveCSS("opacity", "1");
    // ...but only three seconds while the film runs.
    await expect(bar).toHaveCSS("opacity", "0", { timeout: 2500 });
  });

  test("a pointer resting on the controls keeps it while paused", async ({ page }) => {
    await openFilm(page);
    await playButton(page).hover();
    await page.waitForTimeout(4200);
    await expect(controlBar(page)).toHaveCSS("opacity", "1");
  });

  test("the title bar, where the traffic lights are, is chrome to rest on too", async ({
    page,
  }) => {
    await openFilm(page);
    // Paused: resting on the title bar keeps the chrome as resting on the controls does.
    await page.mouse.move(40, 30);
    await page.mouse.move(48, 22);
    await page.waitForTimeout(3200);
    await expect(controlBar(page)).toHaveCSS("opacity", "1");
    // Off it, onto the picture, and it goes as usual.
    await page.mouse.move(400, 250);
    await expect(controlBar(page)).toHaveCSS("opacity", "0", { timeout: 4000 });
  });

  test("returns for a keyboard user who tabs into it, and stays", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.mouse.move(300, 200);
    const bar = controlBar(page);
    await expect(bar).toHaveCSS("opacity", "0", { timeout: 4000 });
    await tab(page);
    await expect(bar).toHaveCSS("opacity", "1");
    await page.waitForTimeout(3400);
    await expect(bar).toHaveCSS("opacity", "1");
  });

  test("goes while paused too, so a paused picture can be read", async ({ page }) => {
    await openFilm(page);
    await page.mouse.move(300, 200);
    await page.mouse.move(320, 210);
    await expect(controlBar(page)).toHaveCSS("opacity", "0", { timeout: 4000 });
  });
});

test.describe("keyboard", () => {
  test("Space pauses and plays, with no words on screen", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.keyboard.press("Space");
    await expect(playButton(page)).toBeVisible();
    await expect(osdLabel(page, "Paused")).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(osdLabel(page, "Playing")).toHaveCount(0);
  });

  test("the arrows seek five seconds and step the volume by five", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    expect(await calls(page, "playerSeekBy")).toEqual([{ seconds: 5 }, { seconds: -5 }]);
    await expect(osdLabel(page, "Back 5 s")).toBeVisible();

    await page.keyboard.press("ArrowUp");
    await expect(page.getByText("105%")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await calls(page, "playerSetVolume")).toEqual([
      { percent: 105 },
      { percent: 100 },
      { percent: 95 },
    ]);
  });

  test("J and L move ten seconds, Shift with an arrow a minute, Home to the beginning", async ({
    page,
  }) => {
    await openFilm(page);
    await page.keyboard.press("l");
    await page.keyboard.press("j");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(osdLabel(page, "Forward 1 min")).toBeVisible();
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await calls(page, "playerSeekBy")).toEqual([
      { seconds: 10 },
      { seconds: -10 },
      { seconds: 60 },
      { seconds: -60 },
    ]);
    await page.keyboard.press("Home");
    await expect(osdLabel(page, "Beginning")).toBeVisible();
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 0, exact: true });
  });

  test("says what really happened when there is nothing left to seek", async ({ page }) => {
    await openFilm(page, { position: TWO_HOURS - 2 });
    await page.keyboard.press("ArrowRight");
    await expect(osdLabel(page, "Forward 2 s")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(osdLabel(page, "At the end")).toBeVisible();
  });

  test("M mutes, F toggles full screen, Escape only leaves it", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("m");
    await expect(page.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.__lumenMock?.fullscreen)).toBe(false);
    await page.keyboard.press("f");
    await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Enter full screen" })).toBeVisible();
  });

  test("a button clicked with the pointer does not capture Space", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.getByRole("button", { name: "Mute" }).click();
    await page.keyboard.press("Space");
    // Space paused the film; it did not press Mute a second time.
    await expect(playButton(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
  });

  test("a click on a control takes back what the display was saying about it", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("m");
    await expect(osdLabel(page, "Muted")).toBeVisible();
    await page.getByRole("button", { name: "Unmute" }).click();
    // The sound is on again: "Muted" must not stay on screen.
    await expect(osdLabel(page, "Muted")).toHaveCount(0);
  });
});

test.describe("keyboard focus", () => {
  test("Tab reaches every control in reading order, each with a ring", async ({ page }) => {
    await openFilm(page);
    // The title bar comes first, as it does on the screen.
    const panel = page.getByRole("button", { name: "Show playlist" });
    await tab(page);
    await expect(panel).toBeFocused();
    await expect(panel).toHaveCSS("outline-style", "solid");

    const timeline = page.getByRole("slider", { name: "Position" });
    await tab(page);
    await expect(timeline).toBeFocused();
    // The timeline is as wide as the window: its ring goes on the needle.
    await expect(timeline).toHaveCSS("outline-style", "none");
    await expect(timeline.locator("[data-needle]")).toHaveCSS("outline-style", "solid");
    await expect(timeline.locator("[data-needle]")).toHaveCSS("outline-width", "2px");

    for (const control of [
      playButton(page),
      page.getByRole("button", { name: "Stop" }),
      page.getByRole("button", { name: "Mute" }),
      page.getByRole("slider", { name: "Volume" }),
      readout(page),
      page.getByRole("button", { name: "Show subtitles" }),
      page.getByRole("button", { name: "Subtitle track" }),
      page.getByRole("button", { name: "Cast" }),
      page.getByRole("button", { name: "More" }),
      page.getByRole("button", { name: "Enter full screen" }),
    ]) {
      await tab(page);
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "solid");
      await expect(control).toHaveCSS("outline-width", "2px");
    }
  });

  test("a control reached with Tab keeps its own keys and no others", async ({ page }) => {
    await openFilm(page, { paused: false });
    await tabTo(page, page.getByRole("button", { name: "Mute" }));

    // Space presses the button that has the ring; playback carries on.
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(await calls(page, "playerTogglePaused")).toHaveLength(0);

    // A button has no use for the arrows: they still seek.
    await page.keyboard.press("ArrowRight");
    expect(await calls(page, "playerSeekBy")).toEqual([{ seconds: 5 }]);
  });

  test("the timeline keeps the horizontal arrows; up and down still mean volume", async ({
    page,
  }) => {
    await openFilm(page);
    await tabTo(page, page.getByRole("slider", { name: "Position" }));

    await page.keyboard.press("ArrowRight");
    // The slider's own step: an exact seek, not the global "forward 5 seconds".
    expect(await calls(page, "playerSeekBy")).toHaveLength(0);
    expect(await calls(page, "playerSeekTo")).toEqual([{ seconds: 2542, exact: true }]);
    await page.keyboard.press("Shift+ArrowRight");
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 2602, exact: true });

    await page.keyboard.press("ArrowUp");
    expect(await calls(page, "playerSetVolume")).toEqual([{ percent: 105 }]);
    expect(await calls(page, "playerSeekTo")).toHaveLength(2);

    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("a click never leaves the ring or the keys behind", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.getByRole("button", { name: "Mute" }).click();
    const unmute = page.getByRole("button", { name: "Unmute" });
    await expect(unmute).toHaveCSS("outline-style", "none");
    // Pressing a key afterwards must not bring the ring back.
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("button", { name: "Mute" })).toHaveCSS("outline-style", "none");

    // Scrubbing the timeline, then Tab: the keyboard starts afresh, with a ring.
    const timeline = page.getByRole("slider", { name: "Position" });
    const track = await box(timeline);
    await page.mouse.click(track.x + 200, track.y + track.height / 2);
    await expect(timeline).not.toBeFocused();
    await expect(timeline.locator("[data-needle]")).toHaveCSS("outline-style", "none");
    await tab(page);
    const ringed = await page.evaluate(() => {
      const focused = document.activeElement as HTMLElement;
      const needle = focused.querySelector<HTMLElement>("[data-needle]");
      return getComputedStyle(needle ?? focused).outlineStyle;
    });
    expect(ringed).toBe("solid");
  });

  test("Escape steps out one level at a time, innermost first", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("f");
    await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    const mute = page.getByRole("button", { name: "Mute" });
    await tabTo(page, mute);
    // Exactly one: the tooltip of the button Tab passed on the way has faded.
    await expect(page.getByRole("tooltip")).toHaveCount(1);

    // First the tooltip, with focus where it was.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(mute).toBeFocused();

    // Then the keyboard goes back to the picture, still in full screen: a
    // keyboard user can let the chrome go without leaving it.
    await page.keyboard.press("Escape");
    await expect(mute).not.toBeFocused();
    expect(await page.evaluate(() => window.__lumenMock?.fullscreen)).toBe(true);
    await expect(controlBar(page)).toHaveCSS("opacity", "0", { timeout: 4000 });

    // Then full screen.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Enter full screen" })).toBeVisible();
  });
});

test.describe("timeline", () => {
  test("shows the position as a needle and in words", async ({ page }) => {
    await openFilm(page);
    const timeline = page.getByRole("slider", { name: "Position" });
    await expect(timeline).toHaveAttribute(
      "aria-valuetext",
      "42 minutes 17 seconds of 2 hours 1 minute",
    );
    const track = await box(timeline);
    const needle = await box(timeline.locator("[data-needle]"));
    const expected = track.x + (2537 / TWO_HOURS) * (track.width - 2);
    expect(Math.abs(needle.x - expected)).toBeLessThanOrEqual(1);
  });

  test("is outlined, so it does not lean on the scrim", async ({ page }) => {
    await openFilm(page);
    const timeline = page.getByRole("slider", { name: "Position" });
    await expect(timeline.locator(".bg-stage-track")).toHaveCSS("box-shadow", /0px 0px 0px 1px/);
    await expect(timeline.locator("[data-needle]")).toHaveCSS("box-shadow", /0px 0px 0px 1px/);
  });

  test("a click seeks exactly to that point", async ({ page }) => {
    await openFilm(page);
    const track = await box(page.getByRole("slider", { name: "Position" }));
    await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2);
    const seeks = (await calls(page, "playerSeekTo")) as { seconds: number; exact: boolean }[];
    const final = seeks.at(-1);
    expect(final?.exact).toBe(true);
    expect(Math.abs((final?.seconds ?? 0) - TWO_HOURS / 2)).toBeLessThan(
      TWO_HOURS / track.width + 1,
    );
  });

  test("dragging scrubs by keyframe and lands exactly on release", async ({ page }) => {
    await openFilm(page);
    const track = await box(page.getByRole("slider", { name: "Position" }));
    const y = track.y + track.height / 2;
    await page.mouse.move(track.x + 100, y);
    await page.mouse.down();
    // Pauses longer than the scrub interval, so seeks go out during the drag
    // however fast the engine delivers the moves.
    await page.mouse.move(track.x + 300, y, { steps: 8 });
    await page.waitForTimeout(80);
    await page.mouse.move(track.x + 500, y, { steps: 8 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    const seeks = (await calls(page, "playerSeekTo")) as { seconds: number; exact: boolean }[];
    expect(seeks.length).toBeGreaterThan(2);
    expect(seeks.slice(0, -1).every((seek) => !seek.exact)).toBe(true);
    expect(seeks.at(-1)?.exact).toBe(true);
    expect(Math.abs((seeks.at(-1)?.seconds ?? 0) - (500 / track.width) * TWO_HOURS)).toBeLessThan(
      10,
    );
  });

  test("hovering shows the time and a hairline under the pointer, kept inside the track", async ({
    page,
  }) => {
    await openFilm(page);
    const timeline = page.getByRole("slider", { name: "Position" });
    const track = await box(timeline);
    const y = track.y + track.height / 2;
    const bubble = timeline.locator(".bg-surface-2");

    await page.mouse.move(track.x + 1, y);
    await expect(bubble).toHaveText("0:00:06");
    // At either end the timecode stops at the track's end, to the pixel.
    expect((await box(bubble)).x).toBe(track.x);
    await page.mouse.move(track.x + track.width - 1, y);
    const right = await box(bubble);
    expect(Math.round(right.x + right.width)).toBe(Math.round(track.x + track.width));

    // In the middle it is centred on the pointer, over a hairline that marks the spot.
    await page.mouse.move(track.x + 400, y);
    const middle = await box(bubble);
    expect(Math.abs(middle.x + middle.width / 2 - (track.x + 400))).toBeLessThanOrEqual(1);
    const hairline = await box(timeline.locator(".w-px"));
    expect(Math.abs(hairline.x - (track.x + 400))).toBeLessThanOrEqual(1);
  });

  test("the needle glides between position reports while playing", async ({ page }) => {
    await openFilm(page, { paused: false, position: 3000 });
    const needle = page.getByRole("slider", { name: "Position" }).locator("[data-needle]");
    const first = (await box(needle)).x;
    await page.waitForTimeout(1500);
    const second = (await box(needle)).x;
    expect(second).toBeGreaterThan(first);
  });

  test("works from the keyboard when focused", async ({ page }) => {
    await openFilm(page);
    await tabTo(page, page.getByRole("slider", { name: "Position" }));
    await page.keyboard.press("Home");
    await page.keyboard.press("PageUp");
    const seeks = (await calls(page, "playerSeekTo")) as { seconds: number; exact: boolean }[];
    expect(seeks).toEqual([
      { seconds: 0, exact: true },
      { seconds: 60, exact: true },
    ]);
  });
});

test.describe("on-screen display", () => {
  test("sits below the title's line and is drawn over the chrome, never dimmed by it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await openHome(page);
    await page.evaluate(() =>
      window.__lumenMock?.open({
        source:
          "/Films/The Long Take — Director’s Cut, Restored from the Original Camera Negative (2019) [2160p HDR10 Atmos].mkv",
        duration: 7305,
        paused: true,
      }),
    );
    await page.keyboard.press("ArrowUp");
    const line = osdLabel(page, "Volume").locator("xpath=ancestor::p[1]");
    await expect(line).toBeVisible();

    const title = await box(page.getByRole("heading", { level: 1 }));
    const osd = await box(line);
    // Clear of the title, however long the title is.
    expect(osd.y).toBeGreaterThanOrEqual(title.y + title.height);
    // Inside the gutter on the right.
    expect(Math.round(osd.x + osd.width)).toBe(640 - GUTTER);

    // Nothing is painted over it: the element at its centre is its own text.
    const onTop = await page.evaluate(
      ({ x, y }) => {
        const layer = document.querySelector("[data-osd]") as HTMLElement;
        layer.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(x, y);
        layer.style.pointerEvents = "";
        return hit !== null && layer.contains(hit);
      },
      { x: osd.x + osd.width / 2, y: osd.y + osd.height / 2 },
    );
    expect(onTop).toBe(true);
    // Outlined like a subtitle: a stroke of void beneath the fill, 1 px showing
    // at this size, so it reads over any picture without dimming it.
    await expect(line).toHaveCSS("-webkit-text-stroke-width", "2px");
    // Engines report the shortest form: "stroke" alone already means fill comes after.
    await expect(line).toHaveCSS("paint-order", /^stroke/);
    await expect(line).toHaveCSS("text-shadow", /rgba\(4, 4, 3/);
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);
  });

  test("its outline grows with the type, to a limit", async ({ page }) => {
    await page.setViewportSize({ width: 1728, height: 1080 });
    await openFilm(page);
    await page.keyboard.press("ArrowUp");
    const line = osdLabel(page, "Volume").locator("xpath=ancestor::p[1]");
    await expect(line).toHaveCSS("-webkit-text-stroke-width", "2.5px");
  });

  test("its scale agrees with the control bar's", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByText("80%")).toBeVisible();
    const placeAlong = async (scale: Locator, needle: Locator) => {
      const [track, hand] = [await box(scale), await box(needle)];
      return (hand.x + hand.width / 2 - track.x) / track.width;
    };
    // 80% is six tenths of the way along both, once the needle has glided there.
    await expect
      .poll(() =>
        placeAlong(page.locator("[data-osd] svg"), page.locator('[data-osd] [data-part="needle"]')),
      )
      .toBeCloseTo(0.6, 1);
    await expect
      .poll(() => placeAlong(volumeScale(page), page.getByRole("slider", { name: "Volume" })))
      .toBeCloseTo(0.6, 1);
  });

  test("holding a key updates it in place instead of fading in again", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("ArrowUp");
    const line = osdLabel(page, "Volume").locator("xpath=ancestor::div[1]");
    await expect(line).toHaveCSS("opacity", "1");
    await line.evaluate((element) => element.setAttribute("data-first", ""));

    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press("ArrowUp");
      // Same element, already opaque: nothing restarted.
      await expect(page.locator("[data-first]")).toHaveCSS("opacity", "1");
    }
    await expect(page.locator("[data-first]")).toContainText("135%");
  });

  test("the widest message fits the smallest window without being cut short", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 360 });
    await openFilm(page);
    await page.keyboard.press("ArrowRight");
    const label = osdLabel(page, "Forward 5 s");
    const line = label.locator("xpath=ancestor::p[1]");
    const rect = await box(line);
    expect(rect.x).toBeGreaterThanOrEqual(GUTTER);
    expect(Math.round(rect.x + rect.width)).toBeLessThanOrEqual(560 - GUTTER);
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  });

  test("does not appear for a change made with the button that shows it", async ({ page }) => {
    await openFilm(page);
    await page.getByRole("button", { name: "Mute" }).click();
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
    await expect(osdLabel(page, "Muted")).toHaveCount(0);

    await page.keyboard.press("m");
    await expect(osdLabel(page, "Sound on")).toBeVisible();
  });

  test("fades out, then leaves nothing behind for assistive technology", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("m");
    await expect(osdLabel(page, "Muted")).toBeVisible();
    await expect(page.locator("[data-osd]")).toBeEmpty({ timeout: 3000 });
  });
});

test.describe("when a command fails", () => {
  const REFUSED = { kind: "engine", message: "error running command" };

  async function refuseSeeking(page: Page) {
    await page.evaluate(
      (error) => window.__lumenMock?.refuse("playerSeekBy", error as never),
      REFUSED,
    );
  }

  test("a toast says so at the top right, under the on-screen display's line, and stays", async ({
    page,
  }) => {
    await openFilm(page);
    await refuseSeeking(page);
    await page.keyboard.press("ArrowRight");

    const toast = page.locator("[data-sonner-toast]");
    await expect(toast).toContainText("Lumen could not seek");
    await expect(toast).toContainText(
      "The playback engine reported: error running command. Try again, or open the file again.",
    );
    await settle(page);
    const rect = await box(toast);
    // At the right gutter, 356 px wide.
    expect(Math.round(rect.x + rect.width)).toBe(1120 - GUTTER);
    expect(rect.width).toBe(356);
    // Below the tallest the on-screen display gets (its line, the gap and its scale), with 8 px between.
    const osdSize = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.width = "var(--osd-size)";
      document.body.append(probe);
      const size = probe.getBoundingClientRect().width;
      probe.remove();
      return size;
    });
    expect(Math.abs(rect.y - (44 + 4 + 2.3 * osdSize + 8))).toBeLessThanOrEqual(0.5);
    // Nowhere near the controls, the loupe or the tooltips of the transport row.
    const controls = await box(page.getByRole("group", { name: "Player controls" }));
    expect(controls.y - (rect.y + rect.height)).toBeGreaterThan(160);

    // Part of the interface: its font, and beneath tooltips.
    expect(await textNotInTheInterfaceFont(page)).toEqual([]);
    await expect(page.locator("[data-sonner-toaster]")).toHaveCSS("z-index", "50");

    // A failure is not said on a timer.
    await page.waitForTimeout(5600);
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await expect(toast).toHaveCount(0);
  });

  test("the same failure repeated is one toast, and only the front of a stack shows its words", async ({
    page,
  }) => {
    await openFilm(page);
    await refuseSeeking(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);

    // A different failure stacks behind... in front, rather: the newest leads.
    await page.evaluate(
      (error) => window.__lumenMock?.refuse("playerSetVolume", error as never),
      REFUSED,
    );
    await page.keyboard.press("ArrowUp");
    const toasts = page.locator("[data-sonner-toast]");
    await expect(toasts).toHaveCount(2);
    const behind = page.locator('[data-sonner-toast][data-front="false"]');
    await expect(behind).toHaveCount(1);
    // Its words are hidden while it is a sliver behind the front one.
    await page.mouse.move(600, 150);
    await expect(behind.locator("> [data-content]")).toHaveCSS("opacity", "0");
    await expect(page.locator('[data-sonner-toast][data-front="true"] > [data-content]')).toHaveCSS(
      "opacity",
      "1",
    );
  });
});

test.describe("the picture", () => {
  test("a click pauses, after waiting to see it is not a double-click", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.mouse.click(560, 300);
    expect(await calls(page, "playerTogglePaused")).toHaveLength(0);
    await expect(playButton(page)).toBeVisible();
    expect(await calls(page, "playerTogglePaused")).toHaveLength(1);
  });

  test("a double-click toggles full screen and does not pause", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.mouse.dblclick(560, 300);
    await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    await page.waitForTimeout(400);
    expect(await calls(page, "playerTogglePaused")).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("a slow double-click still goes to full screen, and leaves the film playing", async ({
    page,
  }) => {
    await openFilm(page, { paused: false });
    await page.mouse.click(560, 300);
    // Slower than the grace: the first click has already paused the film.
    await expect(playButton(page)).toBeVisible();
    // The second press of the same double-click. (`click` with a count of two
    // would send a fresh pair of presses, which is a different gesture.)
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });

    await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    // The pause was undone quietly: nothing is left on screen about it.
    await expect(page.locator("[data-osd]")).toBeEmpty();
  });

  test("a click, then later a double-click, are two requests", async ({ page }) => {
    await openFilm(page, { paused: false });
    await page.mouse.click(560, 300);
    await expect(playButton(page)).toBeVisible();
    await page.waitForTimeout(700);
    await page.mouse.dblclick(560, 300);
    await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    await page.waitForTimeout(300);
    // The film stays paused, and goes to full screen.
    await expect(playButton(page)).toBeVisible();
  });

  test("a file held over it is announced in the middle, clear of every control", async ({
    page,
  }) => {
    await openFilm(page);
    const label = page.getByText("Release to play");
    // Present for layout, and out of the way of the timeline and the row.
    const rect = await box(label);
    const controls = await box(page.getByRole("group", { name: "Player controls" }));
    expect(rect.y + rect.height).toBeLessThan(controls.y);
    expect(Math.abs(rect.x + rect.width / 2 - 560)).toBeLessThanOrEqual(1);
  });
});

test.describe("the end of a film", () => {
  test("brings the chrome back and keeps it up", async ({ page }) => {
    await openFilm(page, { paused: false, position: TWO_HOURS - 0.3 });
    await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
    await page.waitForTimeout(2600);
    await expect(controlBar(page)).toHaveCSS("opacity", "1");
  });

  test("Space starts it again from the beginning", async ({ page }) => {
    await openFilm(page, { paused: false, position: TWO_HOURS - 0.3 });
    await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(await page.evaluate(() => window.__lumenMock?.snapshot().position)).toBeLessThan(5);
  });
});

test.describe("the transport row with a playlist", () => {
  for (const width of [560, 720, 1120]) {
    test(`keeps its groups apart and its controls on one line at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: Math.round((width * 9) / 16) });
      await openQueue(page);
      // Faster, twice: the speed joins the row beside the time.
      await page.keyboard.press("]");
      await page.keyboard.press("]");
      const speed = page.getByRole("button", { name: /Playing at 1.5 times/ });
      await expect(speed.locator("[aria-hidden]")).toHaveText("1.5×");
      await page.mouse.move(width / 2, 100);

      const previous = await box(page.getByRole("button", { name: "Previous item" }));
      const play = await box(playButton(page));
      const next = await box(page.getByRole("button", { name: "Next item" }));
      const stop = await box(page.getByRole("button", { name: "Stop" }));
      const mute = await box(page.getByRole("button", { name: "Mute" }));
      const time = await box(page.getByRole("button", { name: /^10 minutes/ }));
      const rate = await box(speed);
      const more = await box(page.getByRole("button", { name: "More" }));
      const full = await box(page.getByRole("button", { name: "Enter full screen" }));

      // Inside a group, 4 px; between groups, 12 px.
      expect(play.x - (previous.x + previous.width)).toBe(4);
      expect(next.x - (play.x + play.width)).toBe(4);
      expect(stop.x - (next.x + next.width)).toBe(4);
      expect(mute.x - (stop.x + stop.width)).toBe(12);
      expect(rate.x - (time.x + time.width)).toBe(4);
      expect(full.x - (more.x + more.width)).toBe(4);
      // The spacer is whatever is left, and is never less than the gap between groups.
      expect(more.x - (rate.x + rate.width)).toBeGreaterThanOrEqual(24);

      // One line, one height for the buttons, and the readouts centred on it.
      for (const control of [previous, play, next, mute, more, full]) {
        expect(control.height).toBe(36);
        expect(control.y).toBe(play.y);
      }
      expect(time.y + time.height / 2).toBe(play.y + 18);
      expect(rate.y + rate.height / 2).toBe(play.y + 18);

      // The first and last icon still meet the ends of the track.
      expect(previous.x + 9).toBe(GUTTER);
      expect(Math.round(full.x + full.width - 9)).toBe(width - GUTTER);
    });
  }

  test("has no Previous and Next for a single film: a control that could never do anything is not shown", async ({
    page,
  }) => {
    await openFilm(page);
    await expect(page.getByRole("button", { name: "Next item" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Previous item" })).toHaveCount(0);
    expect((await box(playButton(page))).x + 9).toBe(GUTTER);
  });

  test("goes to the next item, and says why it cannot go before the first", async ({ page }) => {
    await openQueue(page);
    const previous = page.getByRole("button", { name: "Previous item" });
    await expect(previous).toHaveAttribute("aria-disabled", "true");
    await previous.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/This is the first item/);

    await page.getByRole("button", { name: "Next item" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/S01E02/);
    await expect(previous).not.toHaveAttribute("aria-disabled", "true");
    // The same from the keys, wherever the pointer was last used.
    await page.keyboard.press("n");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/S01E03/);
    await page.keyboard.press("Meta+ArrowLeft");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/S01E02/);
  });

  test("drops the time readout's second figure on the narrowest stage, and keeps it a little wider", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 590, height: 360 });
    await openFilm(page);
    const total = readout(page).getByText("/", { exact: true });
    await expect(readout(page)).toBeVisible();
    await expect(total).toBeHidden();
    const narrow = await box(readout(page));
    await page.setViewportSize({ width: 640, height: 360 });
    await expect(total).toBeVisible();
    // The same control, wider by the figure it got back; what it says aloud never changed.
    expect((await box(readout(page))).width).toBeGreaterThan(narrow.width + 40);
    await expect(readout(page)).toHaveAccessibleName("42 minutes 17 seconds of 2 hours 1 minute");
  });

  test("returns to normal speed from the readout, which then leaves the row", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("[");
    const speed = page.getByRole("button", { name: /Playing at 0.75 times/ });
    await expect(speed).toBeVisible();
    await speed.click();
    await expect(speed).toHaveCount(0);
    expect((await calls(page, "playerSetSpeed")).at(-1)).toEqual({ rate: 1 });
  });
});

test.describe("the More menu", () => {
  test("opens above its button, inside the window, with every row on one grid", async ({
    page,
  }) => {
    await openFilm(page);
    await page.getByRole("button", { name: "More" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await settle(page);
    const menuBox = await box(menu);
    const button = await box(page.getByRole("button", { name: "More" }));
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(button.y - 8 + 0.5);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1120 - 8);
    expect(menuBox.width).toBeGreaterThanOrEqual(180);
    expect(menuBox.width).toBeLessThanOrEqual(320);

    // Every item 28 px tall and as wide as the menu less its padding; names start on one line.
    const items = menu.locator('[role^="menuitem"]');
    const starts = new Set<number>();
    for (const item of await items.all()) {
      const itemBox = await box(item);
      expect(itemBox.height).toBe(28);
      expect(Math.round(itemBox.width)).toBe(Math.round(menuBox.width - 2 - 8));
      starts.add(Math.round((await box(item.locator(".truncate"))).x));
    }
    expect(starts.size).toBe(1);

    // The chrome stays for as long as the menu is open.
    await page.waitForTimeout(2400);
    await expect(controlBar(page)).toHaveCSS("opacity", "1");
  });

  test("opens its submenu to the side, never over itself", async ({ page }) => {
    await openFilm(page);
    await page.getByRole("button", { name: "More" }).click();
    await glide(page, page.getByRole("menuitem", { name: "Speed" }));
    const normal = page.getByRole("menuitemradio", { name: "Normal" });
    await expect(normal).toBeVisible();
    await settle(page);
    const [main, sub] = await Promise.all(
      (await page.getByRole("menu").all()).map((menu) => box(menu)),
    );
    if (!main || !sub) {
      throw new Error("two menus should be open");
    }
    // Beside it, 4 px clear, on whichever side has the room.
    const gap = sub.x < main.x ? main.x - (sub.x + sub.width) : sub.x - (main.x + main.width);
    expect(Math.round(gap)).toBe(4);
    // It is taller than the room beside its item, so it is moved up to stay inside the window.
    expect(sub.y).toBeGreaterThanOrEqual(8);
    expect(sub.y + sub.height).toBeLessThanOrEqual(680 - 8);
    // The shorter one has the room: its first row is level with the item that opened it.
    await glide(page, page.getByRole("menuitem", { name: "Repeat" }));
    const off = page.getByRole("menuitemradio", { name: "Off" });
    await expect(off).toBeVisible();
    await settle(page);
    expect(
      Math.abs((await box(off)).y - (await box(page.getByRole("menuitem", { name: "Repeat" }))).y),
    ).toBeLessThanOrEqual(1);
    await glide(page, page.getByRole("menuitem", { name: "Speed" }));
    await expect(normal).toBeVisible();
    await settle(page);
    await expect(normal).toHaveAttribute("aria-checked", "true");

    // Across the gap between the two, as a hand goes: the submenu waits for it.
    const faster = page.getByRole("menuitemradio", { name: "1.5×" });
    await glide(page, faster);
    await expect(faster).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(2);
    await faster.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await calls(page, "playerSetSpeed")).toEqual([{ rate: 1.5 }]);
    await expect(page.getByRole("button", { name: /Playing at 1.5 times/ })).toBeVisible();
  });

  test("fits in the smallest window, submenu and all", async ({ page }) => {
    // The window can be no smaller than this (DESIGN.md §4).
    await page.setViewportSize({ width: 560, height: 360 });
    await openFilm(page);
    await page.getByRole("button", { name: "More" }).click();
    await glide(page, page.getByRole("menuitem", { name: "Speed" }));
    await expect(page.getByRole("menuitemradio", { name: "Normal" })).toBeVisible();
    await settle(page);
    const menus = await Promise.all((await page.getByRole("menu").all()).map((menu) => box(menu)));
    expect(menus).toHaveLength(2);
    for (const menu of menus) {
      expect(menu.x).toBeGreaterThanOrEqual(8);
      expect(menu.y).toBeGreaterThanOrEqual(8);
      expect(menu.x + menu.width).toBeLessThanOrEqual(560 - 8);
      expect(menu.y + menu.height).toBeLessThanOrEqual(360 - 8);
    }
    // Side by side: neither lies on the other.
    const [main, sub] = menus;
    if (!main || !sub) {
      throw new Error("two menus should be open");
    }
    expect(overlap(main, sub)).toBe(false);
    // Every speed can be reached without scrolling.
    const last = await box(page.getByRole("menuitemradio", { name: "4×" }));
    expect(last.y + last.height).toBeLessThanOrEqual(sub.y + sub.height);
  });

  test("keeps the keyboard while it is open, and gives it back on Escape", async ({ page }) => {
    await openFilm(page, { paused: false });
    await tabTo(page, page.getByRole("button", { name: "More" }));
    await page.keyboard.press("Enter");
    // Opened from the keyboard, it starts on its first item.
    await expect(page.getByRole("menuitem", { name: "Speed" })).toBeFocused();
    // Inside a menu the arrows and Space are the menu's.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Repeat" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemcheckbox", { name: /Shuffle/ })).toBeFocused();
    expect(await calls(page, "playerSetVolume")).toHaveLength(0);
    await settle(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More" })).toBeFocused();
    expect(await calls(page, "playerTogglePaused")).toHaveLength(0);
  });

  test("is finished with once something is chosen: chosen twice in a hurry is chosen once", async ({
    page,
  }) => {
    await openFilm(page);
    const more = page.getByRole("button", { name: "More" });
    const shuffle = page.getByRole("menuitemcheckbox", { name: /Shuffle/ });
    await more.click();
    await expect(shuffle).toBeVisible();
    await settle(page);
    const at = await box(shuffle);
    // The second click of a double-click finds the menu fading out.
    await page.mouse.click(at.x + 30, at.y + at.height / 2, { clickCount: 2 });
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await calls(page, "playlistSetShuffle")).toHaveLength(1);

    // And so does Return pressed twice.
    await tabTo(page, more);
    await page.keyboard.press("Enter");
    // (The menu moves its focus a moment after each key: wait for it.)
    await expect(page.getByRole("menuitem", { name: "Speed" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Repeat" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(shuffle).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await settle(page);
    expect(await calls(page, "playlistSetShuffle")).toHaveLength(2);
  });

  test("leaves the pointer alone while it fades out: nothing in it lights up or takes the keyboard", async ({
    page,
  }) => {
    await openFilm(page);
    await page.getByRole("button", { name: "More" }).click();
    const shuffle = page.getByRole("menuitemcheckbox", { name: /Shuffle/ });
    await expect(shuffle).toBeVisible();
    await settle(page);
    const at = await box(shuffle);
    await page.mouse.move(at.x + 30, at.y + at.height / 2, { steps: 4 });
    await page.evaluate(() => {
      const took: string[] = [];
      Object.assign(window, { took });
      window.addEventListener(
        "focusin",
        (event) => {
          if (event.target instanceof Element && event.target.closest('[role="menu"]')) {
            took.push(event.target.textContent ?? "");
          }
        },
        true,
      );
    });
    await page.mouse.down();
    await page.mouse.up();
    // A hand that moves on at once, up across the rows above.
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(at.x + 30, at.y + at.height / 2 - step * 8);
    }
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { took: string[] }).took)).toEqual([]);
  });

  test("comes back when its button is pressed while it is still fading out", async ({ page }) => {
    await openFilm(page);
    const more = page.getByRole("button", { name: "More" });
    await more.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await settle(page);
    const at = await box(more);
    await page.keyboard.press("Escape");
    // No waiting: the menu is on its way out, and the press must not be lost.
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect(page.getByRole("menu")).toBeVisible();
    await settle(page);
    // A press while it is open closes it, as it always did.
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

test.describe("a key that can do nothing just now", () => {
  test("says why, in the words its control's tooltip uses", async ({ page }) => {
    await openQueue(page);
    // The first item: there is nothing before it.
    await page.keyboard.press("p");
    await expect(osdLabel(page, "This is the first item")).toBeVisible();
    expect(await calls(page, "playlistPrevious")).toHaveLength(0);
    await page.getByRole("button", { name: "Previous item" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText(/This is the first item/);

    await page.keyboard.press("=");
    await expect(osdLabel(page, "Already at normal speed")).toBeVisible();
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("]");
    }
    await page.keyboard.press("]");
    await expect(osdLabel(page, "This is the fastest")).toBeVisible();
    expect((await calls(page, "playerSetSpeed")).at(-1)).toEqual({ rate: 4 });
  });

  test("is not answered on the home screen, which says what to do itself", async ({ page }) => {
    await openHome(page);
    await page.keyboard.press("Space");
    await page.keyboard.press("n");
    await expect(page.locator("[data-osd]")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });

  test("does not answer Escape, which has only run out of things to leave", async ({ page }) => {
    await openFilm(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(page.locator("[data-osd]")).toHaveText("");
  });
});

test.describe("chapters and the loupe", () => {
  async function openWithChapters(page: import("@playwright/test").Page) {
    await page.goto("/#mock-film");
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  }

  test("cuts the track where each chapter starts", async ({ page }) => {
    await openWithChapters(page);
    const timeline = page.getByRole("slider", { name: "Position" });
    const track = await box(timeline);
    const gaps = timeline.locator("[data-chapter-gap]");
    await expect(gaps).toHaveCount(4);
    const starts = [1260, 2400, 4020, 6300];
    for (const [index, gap] of (await gaps.all()).entries()) {
      const cut = await box(gap);
      expect(cut.width).toBe(2);
      const at = (cut.x + 1 - track.x) / track.width;
      expect(Math.abs(at - (starts[index] ?? 0) / TWO_HOURS)).toBeLessThan(0.002);
    }
  });

  test("shows a still, the time and the chapter under the pointer, without changing size as it moves", async ({
    page,
  }) => {
    await openWithChapters(page);
    const track = await box(page.getByRole("slider", { name: "Position" }));
    const y = track.y + track.height / 2;
    await page.mouse.move(600, y - 40);
    await page.mouse.move(600, y, { steps: 3 });
    const loupe = page.locator("[data-loupe]");
    await expect(loupe.locator("img")).toBeVisible();
    await expect(loupe).toHaveText(/1:0\d:\d\d\s*Chapter 3/);
    const first = await box(loupe);
    // A 192 px still at the picture's shape, 4 px inside the loupe on each side.
    const still = await box(loupe.locator("img"));
    expect(still.width).toBe(192);
    expect(still.height).toBe(108);
    expect(first.width).toBe(200 + 2);
    // Centred on the pointer, and wholly above the track.
    expect(Math.abs(first.x + first.width / 2 - 600)).toBeLessThanOrEqual(1);
    expect(first.y + first.height).toBeLessThanOrEqual(track.y);

    await page.mouse.move(820, y, { steps: 4 });
    await expect(loupe).toHaveText(/The Long Take/);
    const second = await box(loupe);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  test("keeps the loupe inside the track at both ends of it", async ({ page }) => {
    await openWithChapters(page);
    const track = await box(page.getByRole("slider", { name: "Position" }));
    const y = track.y + track.height / 2;
    const loupe = page.locator("[data-loupe]");
    await page.mouse.move(GUTTER + 2, y - 30);
    await page.mouse.move(GUTTER + 2, y, { steps: 2 });
    await expect(loupe).toBeVisible();
    expect((await box(loupe)).x).toBeGreaterThanOrEqual(GUTTER - 0.5);
    await page.mouse.move(1120 - GUTTER - 2, y, { steps: 6 });
    await expect(loupe).toHaveText(/Morning/);
    const right = await box(loupe);
    expect(right.x + right.width).toBeLessThanOrEqual(1120 - GUTTER + 0.5);
  });

  test("goes to the next and the previous chapter from the keys, naming each", async ({ page }) => {
    await openWithChapters(page);
    await page.keyboard.press("Shift+n");
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 4020, exact: true });
    await expect(page.locator("[data-osd]")).toHaveText(/The Long Take\s*1:07:00/);
    await page.keyboard.press("Shift+p");
    // Only just begun: back means the one before.
    expect((await calls(page, "playerSeekTo")).at(-1)).toEqual({ seconds: 2400, exact: true });
    await expect(page.locator("[data-osd]")).toHaveText(/Chapter 3\s*0:40:00/);
  });
});
