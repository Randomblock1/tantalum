const GPU_TIMING_FIELDS = {
    init: "gpuMsInit",
    trace: "gpuMsTrace",
    splat: "gpuMsSplat",
    blit: "gpuMsBlit",
    composite: "gpuMsComposite",
};

export function createPerfSnapshot(backend, overrides = {}) {
    return {
        backend,
        traceSteps: 0,
        gpuTimingSupported: false,
        gpuMsTotal: null,
        gpuMsInit: null,
        gpuMsTrace: null,
        gpuMsSplat: null,
        gpuMsBlit: null,
        gpuMsComposite: null,
        gpuTimedTraceSteps: null,
        gpuTimingAgeFrames: null,
        submits: 0,
        computePasses: 0,
        computeDispatches: 0,
        coalescedComputePasses: 0,
        renderPasses: 0,
        drawCalls: 0,
        blits: 0,
        composites: 0,
        directWaveCommits: 0,
        uniformWrites: 0,
        uniformBytes: 0,
        ...overrides,
    };
}

export function applyLabeledGpuTimings(snapshot, timings) {
    const next = {
        ...snapshot,
        gpuMsTotal: 0,
        gpuMsInit: 0,
        gpuMsTrace: 0,
        gpuMsSplat: 0,
        gpuMsBlit: 0,
        gpuMsComposite: 0,
        gpuTimedTraceSteps: snapshot.traceSteps,
        gpuTimingAgeFrames: 0,
    };

    for (const sample of timings) {
        const field = GPU_TIMING_FIELDS[sample.label];
        if (!field || !Number.isFinite(sample.ms)) continue;
        next[field] += sample.ms;
        next.gpuMsTotal += sample.ms;
    }

    return next;
}
