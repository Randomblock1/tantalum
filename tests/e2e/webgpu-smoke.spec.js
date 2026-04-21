import { expect, test } from "@playwright/test";

test("webgpu path renders rays", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });

    const kind = await page.evaluate(async () => {
        while (!window.tantalumBackendKind) await new Promise((r) => setTimeout(r, 50));
        return window.tantalumBackendKind;
    });
    test.skip(kind !== "webgpu", `Browser selected ${kind}, skipping WebGPU assertions`);

    const label = page.locator(".progress-label").first();
    await expect(label).toHaveText(/\d+\/\d+ rays traced/, { timeout: 15_000 });
    const match = (await label.textContent()).match(/^(\d+)\/(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThan(0);
});
