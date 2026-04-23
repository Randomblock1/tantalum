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

test("debug perf snapshot exposes per-frame batching counters", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });

    const snapshot = await page.evaluate(async () => {
        for (let i = 0; i < 100; ++i) {
            const debugApi = window.__tantalumDebug;
            const perf = debugApi && typeof debugApi.getPerfSnapshot === "function" ? debugApi.getPerfSnapshot() : null;
            if (perf && perf.traceSteps > 0 && perf.submits > 0) return perf;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot.backend).toBe("webgl2");
    expect(snapshot.traceSteps).toBeGreaterThan(0);
    expect(snapshot.submits).toBeGreaterThan(0);
    expect(snapshot.renderPasses).toBeGreaterThan(0);
});
