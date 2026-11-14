import { expect } from "@playwright/test";
import { box, calls, test } from "./support";

test.describe("casting", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto("/#mock-film");
    await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
  });

  test("lists the devices found, casts to one and stops", async ({ page }) => {
    await page.getByRole("button", { name: "Cast" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemcheckbox", { name: /Living Room TV/ })).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox", { name: /Bedroom/ })).toBeVisible();
    await menu.getByRole("menuitemcheckbox", { name: /Living Room TV/ }).click();
    expect(await calls(page, "castStart")).toEqual([
      { device: "cast:living", anchor: expect.objectContaining({ width: 36, height: 36 }) },
    ]);

    await expect(page.getByRole("status").filter({ hasText: "Playing on" })).toContainText(
      "Living Room TV",
    );
    await expect(page.getByRole("button", { name: "Cast" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByRole("button", { name: "Cast" }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /Living Room TV/ })).toBeChecked();
    await page.getByRole("menuitem", { name: "Stop casting" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Playing on" })).toHaveCount(0);
  });

  test("lists AirPlay devices under their own label, with the system's picker last", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Cast" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemcheckbox", { name: /Den/ })).toBeVisible();
    // A speaker has no picture: not offered for a film.
    await expect(menu.getByRole("menuitemcheckbox", { name: /Kitchen/ })).toHaveCount(0);
    const names = await menu.locator("[role=menuitem], [role=menuitemcheckbox], .label").allTextContents();
    const shown = names.map((name) => name.replace(/\s+/g, " ").trim());
    // Chromecasts under their label, then AirPlay devices under theirs, then the system's picker.
    expect(shown[0]).toBe("Chromecast");
    expect(shown.indexOf("AirPlay")).toBe(3);
    expect(shown[4]).toMatch(/^Den/);
    expect(shown.at(-1)).toBe("Other AirPlay devices…");
    await menu.getByRole("menuitemcheckbox", { name: /Den/ }).click();
    expect((await calls(page, "castStart"))[0]).toMatchObject({ device: "airplay:den" });
    await expect(page.getByRole("status").filter({ hasText: "Playing on" })).toContainText("Den");
  });

  test("sits between the subtitles and More, 12 px from each", async ({ page }) => {
    const cast = await box(page.getByRole("button", { name: "Cast" }));
    const more = await box(page.getByRole("button", { name: "More" }));
    const tracks = await box(page.getByRole("button", { name: "Subtitle track" }));
    expect(cast.x - (tracks.x + tracks.width)).toBe(12);
    expect(more.x - (cast.x + cast.width)).toBe(12);
    expect(cast.y).toBe(more.y);
  });

  test("leaves the row for More on a narrow stage", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 394 });
    await expect(page.getByRole("button", { name: "Cast" })).toBeHidden();
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: "Cast", exact: true })).toBeVisible();
  });
});
