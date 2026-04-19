import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "tests/e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: "list",
    use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:5173",
        trace: "on-first-retry",
    },
    webServer: {
        command: "npm run dev",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
