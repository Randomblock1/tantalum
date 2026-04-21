import { expect, test } from "@playwright/test";

test("page loads and WebGL path does not show failure UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#render-canvas")).toBeVisible();
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });
});

test("renderer traces rays and reports progress", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });
    const label = page.locator(".progress-label").first();
    await expect(label).toHaveText(/\d+\/\d+ rays traced/, { timeout: 15_000 });
    const match = (await label.textContent()).match(/^(\d+)\/(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThan(0);
});
