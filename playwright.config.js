import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "tests/e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:5173",
        trace: "on-first-retry",
    },
    webServer: {
        command: "npm run dev",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
    projects: [
        {
            name: "webgl",
            testMatch: /(?:smoke|override-controls)\.spec\.js$/,
            use: {
                ...devices["Desktop Chrome"],
                launchOptions: { args: ["--disable-features=WebGPU"] },
            },
        },
        {
            name: "webgpu",
            testMatch: /webgpu-smoke\.spec\.js$/,
            use: {
                ...devices["Desktop Chrome"],
                launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] },
            },
        },
    ],
});
