import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

function loadRenderer() {
    const source = fs.readFileSync(new URL("../../src/tantalum-core.js", import.meta.url), "utf8");
    const context = vm.createContext({
        console,
        Float32Array,
        Uint32Array,
        ArrayBuffer,
        Math,
        performance: { now: () => 1234 },
        window: {
            tcore: {},
            wavelengthToRgbTable() {
                return new Float32Array(256 * 4).fill(1);
            },
            GasDischargeLines: [{ name: "Stub", wavelengths: [], strengths: [] }],
        },
    });
    context.window.window = context.window;
    vm.runInContext(source, context, { filename: "src/tantalum-core.js" });
    return context.window.tcore.Renderer;
}

function createBackendRecorder(kind = "webgpu") {
    const counters = {
        beginFrame: 0,
        submit: 0,
        updateRayState: 0,
        splatRays: 0,
        blit: 0,
        clearTexture: 0,
        composite: 0,
        compositeArgs: [],
        createRenderTexture: 0,
    };

    let perfSnapshot = {
        backend: kind,
        traceSteps: 0,
        gpuTimingSupported: kind === "webgpu",
        gpuMsTotal: null,
        gpuMsInit: null,
        gpuMsTrace: null,
        gpuMsSplat: null,
        gpuMsBlit: null,
        gpuMsComposite: null,
        submits: 0,
        renderPasses: 0,
        computePasses: 0,
        blits: 0,
        composites: 0,
    };

    const backend = {
        caps: { kind, hasFloat32Blend: true, hasLinearFloat: true },
        canvas: {},
        createRayState(size) {
            return { size, buffer: {}, view: {} };
        },
        createRenderTexture(width, height) {
            counters.createRenderTexture++;
            return { width, height, view: {}, tex: {} };
        },
        createQuadGeometry() {
            return {};
        },
        createRayLineGeometry(raySize) {
            return { buffer: {}, count: raySize * raySize * 2 };
        },
        loadProgram(programKind, name) {
            return { kind: programKind, name, pipeline: {}, layout: {} };
        },
        uploadSpectrumResources() {
            return {
                spectrum: { view: {} },
                emission: { view: {} },
                icdf: { view: {} },
                pdf: { view: {} },
                updateEmission() {},
                updateIcdf() {},
                updatePdf() {},
            };
        },
        resize() {},
        getPerfSnapshot() {
            return perfSnapshot;
        },
        beginFrame() {
            counters.beginFrame++;
            return {
                updateRayState() {
                    counters.updateRayState++;
                },
                splatRays() {
                    counters.splatRays++;
                },
                blit() {
                    counters.blit++;
                },
                clearTexture() {
                    counters.clearTexture++;
                },
                composite(args) {
                    counters.composite++;
                    counters.compositeArgs.push(args);
                },
                submit() {
                    counters.submit++;
                },
            };
        },
    };

    return {
        backend,
        counters,
        setPerfSnapshot(next) {
            perfSnapshot = { ...perfSnapshot, ...next };
        },
    };
}

function resetCounters(counters) {
    counters.beginFrame = 0;
    counters.submit = 0;
    counters.updateRayState = 0;
    counters.splatRays = 0;
    counters.blit = 0;
    counters.clearTexture = 0;
    counters.composite = 0;
    counters.compositeArgs = [];
}

test("Renderer.renderBatch batches multiple trace steps into one backend frame", () => {
    const Renderer = loadRenderer();
    const { backend, counters } = createBackendRecorder();
    const renderer = new Renderer(backend, 64, 64, ["scene1"]);

    resetCounters(counters);

    const result = renderer.renderBatch(10, { maxSteps: 4 });

    assert.equal(result.traceSteps, 4);
    assert.equal(result.presented, true);
    assert.equal(counters.beginFrame, 1);
    assert.equal(counters.submit, 1);
    assert.equal(counters.composite, 1);
});

test("Renderer.renderBatch previews the first wave without blitting into the accumulation buffer", () => {
    const Renderer = loadRenderer();
    const { backend, counters } = createBackendRecorder();
    const renderer = new Renderer(backend, 64, 64, ["scene1"]);

    resetCounters(counters);

    const result = renderer.renderBatch(10, { maxSteps: 1, forcePresent: true });

    assert.equal(result.traceSteps, 1);
    assert.equal(result.presented, true);
    assert.equal(counters.blit, 0);
    assert.equal(counters.composite, 1);
    assert.equal(counters.compositeArgs[0].previewBuffer, renderer.waveBuffer);
});

test("Renderer.renderBatch commits completed waves and composites without a preview buffer", () => {
    const Renderer = loadRenderer();
    const { backend, counters } = createBackendRecorder();
    const renderer = new Renderer(backend, 64, 64, ["scene1"]);

    renderer.setMaxPathLength(2);
    resetCounters(counters);

    const result = renderer.renderBatch(10, { maxSteps: 2, forcePresent: true });

    assert.equal(result.traceSteps, 2);
    assert.equal(result.presented, true);
    assert.equal(renderer.pathLength, 0);
    assert.equal(renderer.wavesTraced, 1);
    assert.equal(counters.blit, 1);
    assert.equal(counters.composite, 1);
    assert.equal(counters.compositeArgs[0].previewBuffer, undefined);
});

test("Renderer.traceStepsPerFrame scales WebGPU work to a GPU-time budget", () => {
    const Renderer = loadRenderer();
    const { backend, setPerfSnapshot } = createBackendRecorder("webgpu");
    const renderer = new Renderer(backend, 64, 64, ["scene1"]);

    assert.equal(renderer.traceStepsPerFrame(), 8);

    setPerfSnapshot({ traceSteps: 4, gpuMsTotal: 6 });
    assert.equal(renderer.traceStepsPerFrame(), 8);

    setPerfSnapshot({ traceSteps: 8, gpuMsTotal: 24 });
    assert.equal(renderer.traceStepsPerFrame(), 4);
});

test("Renderer.traceStepsPerFrame keeps the fixed schedule on WebGL", () => {
    const Renderer = loadRenderer();
    const { backend, setPerfSnapshot } = createBackendRecorder("webgl2");
    const renderer = new Renderer(backend, 64, 64, ["scene1"]);

    setPerfSnapshot({ traceSteps: 16, gpuMsTotal: 2 });
    assert.equal(renderer.traceStepsPerFrame(), 8);
});

test("Renderer.changeResolution reuses existing render textures for identical sizes", () => {
    const Renderer = loadRenderer();
    const { backend, counters } = createBackendRecorder();
    const renderer = new Renderer(backend, 64, 64, ["scene1"]);

    assert.equal(counters.createRenderTexture, 2);

    renderer.changeResolution(64, 64);

    assert.equal(counters.createRenderTexture, 2);
});
