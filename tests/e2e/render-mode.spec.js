import { expect, test } from "@playwright/test";

test("renderer uses the throughput scheduler by default without a mode toggle", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });

    await expect(page.locator("#render-mode-selector-group")).toHaveCount(0);

    const label = page.locator(".progress-label").first();
    await expect(label).toHaveText(/\d+\/\d+ rays traced/, { timeout: 15_000 });
});

test("default throughput scheduler still supports PNG download", async ({ page }) => {
    await page.addInitScript(() => {
        window.showSaveFilePicker = undefined;
    });

    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });

    await expect(page.locator(".progress-label").first()).toHaveText(/\d+\/\d+ rays traced/, { timeout: 15_000 });

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#save-button").click();
    const download = await downloadPromise;

    await expect(download.suggestedFilename()).toMatch(/Tantalum\.png$/);
});
