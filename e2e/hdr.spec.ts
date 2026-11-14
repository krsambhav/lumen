import { expect } from "@playwright/test";
import { openFilm, test } from "./support";

test.describe("the stage chrome over an HDR picture", () => {
  test("outlines its letters and icons while the picture is HDR, and only then", async ({
    page,
  }) => {
    await openFilm(page);
    await page.mouse.move(300, 300);
    const title = page.getByRole("heading", { level: 1 });
    await expect(title).toBeVisible();
    const stroke = () =>
      title.evaluate((element) => getComputedStyle(element).webkitTextStrokeWidth);
    const icon = page.getByRole("button", { name: /^(Play|Pause)$/ }).locator("svg");
    const filter = () => icon.evaluate((element) => getComputedStyle(element).filter);

    expect(await stroke()).toBe("0px");
    expect(await filter()).toBe("none");

    await page.evaluate(() => window.__lumenMock?.setHdr(true));
    await expect.poll(stroke).not.toBe("0px");
    expect(await filter()).toContain("drop-shadow");

    await page.evaluate(() => window.__lumenMock?.setHdr(false));
    await expect.poll(stroke).toBe("0px");
  });
});
