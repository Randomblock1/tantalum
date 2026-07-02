/**
 * Headless WebGPU throughput benchmark.
 *
 * Spawns a vite dev server on a random port, drives the app with Playwright
 * chromium (WebGPU enabled), raises maxSampleCount so the render never
 * finishes, then measures rays traced per second plus averaged GPU pass
 * timings from the detailed perf snapshots.
 *
 * Usage: bun tools/bench.mjs [--seconds 10] [--warmup 3] [--scene 0] [--json]
 */

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

function arg(name, fallback) {
    const ix = process.argv.indexOf(name);
    if (ix === -1 || ix + 1 >= process.argv.length) return fallback;
    return process.argv[ix + 1];
}

const seconds = Number(arg("--seconds", 10));
const warmup = Number(arg("--warmup", 3));
const scene = Number(arg("--scene", 0));
const jsonOnly = process.argv.includes("--json");
const port = 5200 + Math.floor(Math.random() * 700);
const root = new URL("..", import.meta.url).pathname;

function log(...args) {
    if (!jsonOnly) console.error(...args);
}

const vite = spawn("bunx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
});
vite.on("exit", (code) => {
    if (code !== null && code !== 0 && !shuttingDown) {
        console.error(`vite exited with code ${code}`);
        process.exit(1);
    }
});
let shuttingDown = false;

async function waitForServer(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`dev server did not come up at ${url}`);
}

const url = `http://127.0.0.1:${port}/`;
let browser = null;
try {
    await waitForServer(url, 60_000);
    log(`dev server up at ${url}`);

    /* headless:false + --headless=new runs the full chromium binary in new
       headless mode. Playwright's default headless uses chrome-headless-shell,
       which only exposes a SwiftShader (CPU) WebGPU adapter — useless for
       benchmarking. The full binary reaches the real GPU via Vulkan. */
    browser = await chromium.launch({
        headless: false,
        args: ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
    });
    const context = await browser.newContext();
    await context.addInitScript(() => {
        try {
            localStorage.setItem("tantalum-webgpu-timing", "detailed");
        } catch {
            /* ignore */
        }
    });
    const page = await context.newPage();
    await page.goto(url);

    const backend = await page.evaluate(async () => {
        for (let i = 0; i < 300; ++i) {
            if (window.tantalumBackendKind) return window.tantalumBackendKind;
            await new Promise((r) => setTimeout(r, 100));
        }
        return null;
    });
    if (backend !== "webgpu") {
        throw new Error(`expected webgpu backend, got ${backend}`);
    }

    const adapterInfo = await page.evaluate(async () => {
        for (let i = 0; i < 5; ++i) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                const info = adapter.info || {};
                return { vendor: info.vendor || null, architecture: info.architecture || null };
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        return null;
    });
    if (adapterInfo && adapterInfo.architecture === "swiftshader") {
        throw new Error("adapter is SwiftShader (CPU) — refusing to benchmark software rendering");
    }
    log("adapter:", JSON.stringify(adapterInfo));

    if (scene > 0) {
        await page.evaluate((sceneIx) => {
            const group = document.getElementById("scene-selector");
            const buttons = group ? group.querySelectorAll("button") : [];
            if (buttons[sceneIx]) buttons[sceneIx].click();
        }, scene);
    }

    await page.evaluate(() => window.__tantalumDebug.setMaxSampleCount(1e12));
    await page.waitForTimeout(warmup * 1000);
    await page.evaluate(() => window.__tantalumDebug.setMaxSampleCount(1e12));

    const start = await page.evaluate(() => ({
        stats: window.__tantalumDebug.getBenchStats(),
        now: performance.now(),
    }));

    const gpuSamples = [];
    const pollMs = 250;
    const iterations = Math.max(1, Math.round((seconds * 1000) / pollMs));
    for (let i = 0; i < iterations; ++i) {
        await page.waitForTimeout(pollMs);
        const snap = await page.evaluate(() => window.__tantalumDebug.getPerfSnapshot());
        if (snap && snap.gpuMsTotal !== null && snap.gpuMsTotal > 0) gpuSamples.push(snap);
    }

    const end = await page.evaluate(() => ({
        stats: window.__tantalumDebug.getBenchStats(),
        now: performance.now(),
        snap: window.__tantalumDebug.getPerfSnapshot(),
    }));

    const shotPath = arg("--shot", null);
    if (shotPath) await page.locator("canvas").first().screenshot({ path: shotPath });

    const dtSec = (end.now - start.now) / 1000;
    const raysPerSec = (end.stats.raysTraced - start.stats.raysTraced) / dtSec;

    function mean(field) {
        const values = gpuSamples.map((s) => s[field]).filter((v) => typeof v === "number" && Number.isFinite(v));
        if (values.length === 0) return null;
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    const timedSteps = mean("gpuTimedTraceSteps");
    const result = {
        backend,
        adapter: adapterInfo,
        scene,
        seconds: dtSec,
        raysTraced: end.stats.raysTraced - start.stats.raysTraced,
        raysPerSec: Math.round(raysPerSec),
        mraysPerSec: Number((raysPerSec / 1e6).toFixed(2)),
        gpuTimingSupported: end.snap ? end.snap.gpuTimingSupported : false,
        gpuSampleCount: gpuSamples.length,
        gpuMsPerFrame: {
            total: mean("gpuMsTotal"),
            init: mean("gpuMsInit"),
            trace: mean("gpuMsTrace"),
            splat: mean("gpuMsSplat"),
            blit: mean("gpuMsBlit"),
            composite: mean("gpuMsComposite"),
        },
        gpuTimedTraceStepsPerFrame: timedSteps,
    };

    console.log(JSON.stringify(result, null, 2));
} finally {
    shuttingDown = true;
    if (browser) await browser.close();
    vite.kill("SIGTERM");
}
