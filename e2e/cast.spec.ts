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
    expect(await calls(page, "castStart")).toEqual([{ device: "cast:living" }]);

    await expect(page.getByRole("status").filter({ hasText: "Playing on" })).toContainText("Living Room TV");
    await expect(page.getByRole("button", { name: "Cast" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Cast" }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /Living Room TV/ })).toBeChecked();
    await page.getByRole("menuitem", { name: "Stop casting" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Playing on" })).toHaveCount(0);
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
