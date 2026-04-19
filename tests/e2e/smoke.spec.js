import { expect, test } from "@playwright/test";

test("page loads and WebGL path does not show failure UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#render-canvas")).toBeVisible();
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });
});
