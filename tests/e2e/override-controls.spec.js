import { expect, test } from "@playwright/test";

test("override toggle swaps controls and applies custom values", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });

    const toggle = page.locator("#override-controls");
    await expect(toggle).toBeVisible();

    await toggle.check();

    await expect(page.locator("#resolution-selector-group")).toBeHidden();
    await expect(page.locator("#path-length-slider")).toBeHidden();
    await expect(page.locator("#sample-count-slider")).toBeHidden();
    await expect(page.locator("#resolution-override")).toBeVisible();
    await expect(page.locator("#path-length-override")).toBeVisible();
    await expect(page.locator("#sample-count-override")).toBeVisible();

    await expect(page.locator("#resolution-width")).toHaveValue("820");
    await expect(page.locator("#resolution-height")).toHaveValue("461");
    await expect(page.locator("#path-length-input")).toHaveValue("12");
    await expect(page.locator("#sample-count-input")).toHaveValue("1000000");

    await page.locator("#resolution-width").fill("640");
    await page.locator("#resolution-height").fill("360");

    await expect(page.locator("#render-canvas")).toHaveAttribute("width", "640");
    await expect(page.locator("#render-canvas")).toHaveAttribute("height", "360");
});
