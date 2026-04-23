import assert from "node:assert/strict";
import test from "node:test";

import { applyLabeledGpuTimings, createPerfSnapshot } from "../../src/backend/webgpu-perf.js";

test("createPerfSnapshot returns the full WebGPU perf schema", () => {
    assert.deepEqual(createPerfSnapshot("webgpu"), {
        backend: "webgpu",
        traceSteps: 0,
        gpuTimingSupported: false,
        gpuMsTotal: null,
        gpuMsInit: null,
        gpuMsTrace: null,
        gpuMsSplat: null,
        gpuMsBlit: null,
        gpuMsComposite: null,
        submits: 0,
        computePasses: 0,
        renderPasses: 0,
        blits: 0,
        composites: 0,
    });
});

test("applyLabeledGpuTimings aggregates repeated labels into stable perf fields", () => {
    const snapshot = createPerfSnapshot("webgpu", { traceSteps: 4, gpuTimingSupported: true });
    const next = applyLabeledGpuTimings(snapshot, [
        { label: "init", ms: 1.5 },
        { label: "trace", ms: 2.0 },
        { label: "trace", ms: 3.0 },
        { label: "splat", ms: 4.5 },
        { label: "blit", ms: 5.0 },
        { label: "composite", ms: 6.0 },
    ]);

    assert.equal(next.gpuTimingSupported, true);
    assert.equal(next.gpuMsInit, 1.5);
    assert.equal(next.gpuMsTrace, 5.0);
    assert.equal(next.gpuMsSplat, 4.5);
    assert.equal(next.gpuMsBlit, 5.0);
    assert.equal(next.gpuMsComposite, 6.0);
    assert.equal(next.gpuMsTotal, 22.0);
});
