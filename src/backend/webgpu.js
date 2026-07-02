/**
 * WebGPU backend. Implements the Backend interface from ./backend.js using
 * split storage buffers for ray state and compute shaders for init/trace.
 * This module is loaded lazily by ./select.js; consumers should not import
 * it directly unless they've already confirmed navigator.gpu support.
 */

import { expandIncludes } from "./wgsl-loader.js";
import { createBinaryCache, createTernaryCache, createUnaryCache } from "./webgpu-bind-group-cache.js";
import { createManagedTextureHandle } from "./webgpu-managed-resource.js";
import { applyLabeledGpuTimings, createPerfSnapshot } from "./webgpu-perf.js";
import { createProceduralSplatDrawArgs, getRayStateLayout } from "./webgpu-ray-state.js";
import { createUniformRing } from "./webgpu-uniform-ring.js";

import preambleSrc from "../../shaders/wgsl/preamble.wgsl?raw";
import composeSrc from "../../shaders/wgsl/compose.wgsl?raw";
import composePreviewSrc from "../../shaders/wgsl/compose-preview.wgsl?raw";
import raySrc from "../../shaders/wgsl/ray.wgsl?raw";
import passSrc from "../../shaders/wgsl/pass.wgsl?raw";
import initSrc from "../../shaders/wgsl/init.wgsl?raw";
import traceSrc from "../../shaders/wgsl/trace.wgsl?raw";
import bsdfSrc from "../../shaders/wgsl/bsdf.wgsl?raw";
import randSrc from "../../shaders/wgsl/rand.wgsl?raw";
import intersectSrc from "../../shaders/wgsl/intersect.wgsl?raw";
import csgSrc from "../../shaders/wgsl/csg.wgsl?raw";
import scene1Src from "../../shaders/wgsl/scene1.wgsl?raw";
import scene2Src from "../../shaders/wgsl/scene2.wgsl?raw";
import scene3Src from "../../shaders/wgsl/scene3.wgsl?raw";
import scene4Src from "../../shaders/wgsl/scene4.wgsl?raw";
import scene5Src from "../../shaders/wgsl/scene5.wgsl?raw";
import scene6Src from "../../shaders/wgsl/scene6.wgsl?raw";
import scene7Src from "../../shaders/wgsl/scene7.wgsl?raw";

const SCENE_NAMES = ["scene1", "scene2", "scene3", "scene4", "scene5", "scene6", "scene7"];
const TIMESTAMP_QUERY_CAPACITY = 256;
const TIMESTAMP_SLOT_COUNT = 3;
const DEFAULT_GPU_TIMING_SAMPLE_INTERVAL = 30;
const NANOS_PER_MILLISECOND = 1_000_000;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {GPUDevice} device
 * @param {GPUAdapter} adapter
 * @returns {Promise<import("./backend.js").Backend>}
 */
export async function makeWebGPUBackend(canvas, device, adapter) {
    const ctx = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "opaque" });

    const caps = {
        kind: "webgpu",
        hasFloat32Blend: adapter.features.has("float32-blendable"),
        hasLinearFloat: adapter.features.has("float32-filterable"),
    };
    const supportsTimestampQuery = device.features.has("timestamp-query");
    const timingConfig = (() => {
        let mode = "sampled";
        let sampleInterval = DEFAULT_GPU_TIMING_SAMPLE_INTERVAL;
        try {
            const stored = localStorage.getItem("tantalum-webgpu-timing");
            if (stored === "off") mode = "off";
            else if (stored === "detailed") {
                mode = "detailed";
                sampleInterval = 1;
            } else if (stored && /^\d+$/.test(stored)) {
                sampleInterval = Math.max(1, Number(stored));
            }
        } catch {
            /* localStorage can be blocked in sandboxed contexts. */
        }
        return { mode, sampleInterval };
    })();

    const wgsl = {
        preamble: preambleSrc,
        rand: randSrc,
        bsdf: bsdfSrc,
        intersect: intersectSrc,
        csg: csgSrc,
        trace: traceSrc,
        compose: composeSrc,
        composePreview: composePreviewSrc,
        pass: passSrc,
        ray: raySrc,
        init: initSrc,
        scene1: scene1Src,
        scene2: scene2Src,
        scene3: scene3Src,
        scene4: scene4Src,
        scene5: scene5Src,
        scene6: scene6Src,
        scene7: scene7Src,
    };

    const linearSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

    function make1DFloatTexture(data, channels) {
        const textureFormat = channels === 4 ? "rgba32float" : "r32float";
        const width = data.length / channels;
        const texture = device.createTexture({
            size: { width, height: 1 },
            format: textureFormat,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const bytesPerPixel = channels * 4;
        device.queue.writeTexture(
            { texture },
            data.buffer,
            { bytesPerRow: Math.max(256, width * bytesPerPixel) },
            { width, height: 1 },
        );
        return createManagedTextureHandle({
            texture,
            view: texture.createView(),
            width,
            height: 1,
            channels,
        });
    }

    function loadShaderModule(entry) {
        const code = expandIncludes(entry, wgsl);
        return device.createShaderModule({ code, label: entry });
    }

    const programs = new Map();

    const composeModule = loadShaderModule("compose");
    const composePreviewModule = loadShaderModule("composePreview");
    const composeLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
            },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const composePreviewLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
            },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        ],
    });
    const composePipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [composeLayout] }),
        vertex: { module: composeModule, entryPoint: "vs" },
        fragment: { module: composeModule, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
    });
    const composePreviewPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [composePreviewLayout] }),
        vertex: { module: composePreviewModule, entryPoint: "vs" },
        fragment: { module: composePreviewModule, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
    });
    programs.set("composite", { kind: "composite", pipeline: composePipeline, layout: composeLayout });
    programs.set("compositePreview", {
        kind: "compositePreview",
        pipeline: composePreviewPipeline,
        layout: composePreviewLayout,
    });

    const rayModule = loadShaderModule("ray");
    const rayLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
            },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ],
    });
    // The splat pass renders into two different targets depending on the code
    // path: waveBuffer (rgba16float, one-wave accumulator) via splatRays, and
    // screenBuffer (rgba32float) directly via splatRaysToAccumulation. Render
    // pipelines are bound to a target format, so we build one variant per format
    // and select per-call by the destination texture's format.
    function makeSplatPipeline(targetFormat) {
        return device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [rayLayout] }),
            vertex: { module: rayModule, entryPoint: "vs" },
            fragment: {
                module: rayModule,
                entryPoint: "fs",
                targets: [
                    {
                        format: targetFormat,
                        blend: {
                            color: { operation: "add", srcFactor: "one", dstFactor: "one" },
                            alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
                        },
                    },
                ],
            },
            primitive: { topology: "line-list" },
        });
    }
    const splatPipelines = {
        rgba32float: makeSplatPipeline("rgba32float"),
        rgba16float: makeSplatPipeline("rgba16float"),
    };
    programs.set("splat", {
        kind: "splat",
        pipeline: splatPipelines.rgba32float,
        pipelinesByFormat: splatPipelines,
        layout: rayLayout,
    });

    const passModule = loadShaderModule("pass");
    const passLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }],
    });
    const passPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [passLayout] }),
        vertex: { module: passModule, entryPoint: "vs" },
        fragment: {
            module: passModule,
            entryPoint: "fs",
            targets: [
                {
                    format: "rgba32float",
                    blend: {
                        color: { operation: "add", srcFactor: "one", dstFactor: "one" },
                        alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
                    },
                },
            ],
        },
        primitive: { topology: "triangle-list" },
    });
    programs.set("blit", { kind: "blit", pipeline: passPipeline, layout: passLayout });

    const initModule = loadShaderModule("init");
    const initLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 48 },
            },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 9, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        ],
    });
    const initPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [initLayout] }),
        compute: { module: initModule, entryPoint: "cs" },
    });
    programs.set("init", { kind: "init", pipeline: initPipeline, layout: initLayout });

    const traceLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 },
            },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
    });
    for (const scene of SCENE_NAMES) {
        const mod = loadShaderModule(scene);
        const pipe = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout] }),
            compute: { module: mod, entryPoint: "cs" },
        });
        programs.set(`trace:${scene}`, { kind: "trace", pipeline: pipe, layout: traceLayout, scene });
    }

    const uniformRing = createUniformRing(device);
    const initScratch = new ArrayBuffer(48);
    const initScratchF32 = new Float32Array(initScratch);
    const initScratchU32 = new Uint32Array(initScratch);
    const traceScratch = new ArrayBuffer(16);
    const traceScratchU32 = new Uint32Array(traceScratch);
    const splatScratch = new ArrayBuffer(16);
    const splatScratchF32 = new Float32Array(splatScratch);
    const composeScratch = new ArrayBuffer(16);
    const composeScratchF32 = new Float32Array(composeScratch);

    let spectrumHandle = null;
    const getInitBindGroup = createTernaryCache((stateIn, stateOut, spectrum) =>
        device.createBindGroup({
            layout: initLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformRing.buffer, size: 48 } },
                { binding: 1, resource: { buffer: stateIn.rngBuffer } },
                { binding: 2, resource: { buffer: stateOut.posDirBuffer } },
                { binding: 3, resource: { buffer: stateOut.rngBuffer } },
                { binding: 4, resource: { buffer: stateOut.rgbLambdaBuffer } },
                { binding: 5, resource: spectrum.spectrum.view },
                { binding: 6, resource: spectrum.emission.view },
                { binding: 7, resource: spectrum.icdf.view },
                { binding: 8, resource: spectrum.pdf.view },
                { binding: 9, resource: linearSampler },
            ],
        }),
    );
    const getTraceBindGroup = createBinaryCache((stateIn, stateOut) =>
        device.createBindGroup({
            layout: traceLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformRing.buffer, size: 16 } },
                { binding: 1, resource: { buffer: stateIn.posDirBuffer } },
                { binding: 2, resource: { buffer: stateIn.rngBuffer } },
                { binding: 3, resource: { buffer: stateIn.rgbLambdaBuffer } },
                { binding: 4, resource: { buffer: stateOut.posDirBuffer } },
                { binding: 5, resource: { buffer: stateOut.rngBuffer } },
                { binding: 6, resource: { buffer: stateOut.rgbLambdaBuffer } },
            ],
        }),
    );
    const getSplatBindGroup = createBinaryCache((stateA, stateB) =>
        device.createBindGroup({
            layout: rayLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformRing.buffer, size: 16 } },
                { binding: 1, resource: { buffer: stateA.posDirBuffer } },
                { binding: 2, resource: { buffer: stateA.rgbLambdaBuffer } },
                { binding: 3, resource: { buffer: stateB.posDirBuffer } },
            ],
        }),
    );
    const getBlitBindGroup = createUnaryCache((src) =>
        device.createBindGroup({
            layout: passLayout,
            entries: [{ binding: 0, resource: src.view }],
        }),
    );
    const getComposeBindGroup = createUnaryCache((screen) =>
        device.createBindGroup({
            layout: composeLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformRing.buffer, size: 16 } },
                { binding: 1, resource: screen.view },
            ],
        }),
    );
    const getComposePreviewBindGroup = createBinaryCache((screen, preview) =>
        device.createBindGroup({
            layout: composePreviewLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformRing.buffer, size: 16 } },
                { binding: 1, resource: screen.view },
                { binding: 2, resource: preview.view },
            ],
        }),
    );

    function currentSpectrumHandle() {
        if (!spectrumHandle) {
            throw new Error("WebGPU: spectrum resources must be uploaded before init dispatch");
        }
        return spectrumHandle;
    }

    function createStorageBuffer(size, data) {
        const buffer = device.createBuffer({
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        return buffer;
    }

    function createRayState(size) {
        const layout = getRayStateLayout(size);
        const posDirData = new Float32Array(layout.rayCount * 4);
        const rngData = new Float32Array(layout.rayCount * 4);
        const rgbLambdaData = new Float32Array(layout.rayCount * 4);
        for (let i = 0; i < layout.rayCount; ++i) {
            const theta = Math.random() * Math.PI * 2.0;
            posDirData[i * 4 + 0] = 0.0;
            posDirData[i * 4 + 1] = 0.0;
            posDirData[i * 4 + 2] = Math.cos(theta);
            posDirData[i * 4 + 3] = Math.sin(theta);
            for (let t = 0; t < 4; ++t) rngData[i * 4 + t] = Math.random() * 4194167.0;
        }
        return {
            size,
            posDirBuffer: createStorageBuffer(layout.posDirByteLength, posDirData),
            rngBuffer: createStorageBuffer(layout.rngByteLength, rngData),
            rgbLambdaBuffer: createStorageBuffer(layout.rgbLambdaByteLength, rgbLambdaData),
            byteLen: layout.posDirByteLength + layout.rngByteLength + layout.rgbLambdaByteLength,
        };
    }

    function createRenderTexture(w, h, opts) {
        const format = opts && opts.format ? opts.format : "rgba32float";
        const texture = device.createTexture({
            size: { width: w, height: h },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        });
        return createManagedTextureHandle({
            texture,
            view: texture.createView(),
            width: w,
            height: h,
            format,
        });
    }

    // Splat pipelines are bound to their color-target format; pick the variant
    // matching the destination texture (waveBuffer=rgba16float, screen=rgba32float).
    function selectSplatPipeline(program, target) {
        const byFormat = program.pipelinesByFormat;
        if (byFormat && target && target.format && byFormat[target.format]) {
            return byFormat[target.format];
        }
        return program.pipeline;
    }

    function createQuadGeometry() {
        return { kind: "quad" };
    }

    function createRayLineGeometry(raySize) {
        return { kind: "procedural-lines", count: raySize * raySize * 2 };
    }

    function loadProgram(kind, name) {
        const key = kind === "trace" ? `trace:${name}` : kind;
        const program = programs.get(key);
        if (!program) throw new Error(`WebGPU: program ${kind}/${name} not wired`);
        return program;
    }

    function uploadSpectrumResources(spec) {
        if (spectrumHandle && typeof spectrumHandle.destroy == "function") spectrumHandle.destroy();

        const spectrum = make1DFloatTexture(spec.spectrum, 4);
        const emission = make1DFloatTexture(spec.emission, 1);
        const icdf = make1DFloatTexture(spec.icdf, 1);
        const pdf = make1DFloatTexture(spec.pdf, 1);

        function rewrite(handle, data) {
            device.queue.writeTexture(
                { texture: handle.texture },
                data.buffer,
                { bytesPerRow: Math.max(256, handle.width * handle.channels * 4) },
                { width: handle.width, height: 1 },
            );
        }

        const handle = {
            spectrum,
            emission,
            icdf,
            pdf,
            sampler: linearSampler,
            updateEmission: (data) => rewrite(emission, data),
            updateIcdf: (data) => rewrite(icdf, data),
            updatePdf: (data) => rewrite(pdf, data),
            destroy() {
                spectrum.destroy();
                emission.destroy();
                icdf.destroy();
                pdf.destroy();
            },
        };
        spectrumHandle = handle;
        return handle;
    }

    function resize(w, h) {
        canvas.width = w;
        canvas.height = h;
    }

    const timestampTracker = supportsTimestampQuery
        ? {
              querySet: device.createQuerySet({ type: "timestamp", count: TIMESTAMP_QUERY_CAPACITY }),
              slotIndex: 0,
              slots: Array.from({ length: TIMESTAMP_SLOT_COUNT }, () => ({
                  resolveBuffer: device.createBuffer({
                      size: TIMESTAMP_QUERY_CAPACITY * 8,
                      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                  }),
                  readBuffer: device.createBuffer({
                      size: TIMESTAMP_QUERY_CAPACITY * 8,
                      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                  }),
                  busy: false,
              })),
          }
        : null;

    function acquireTimingSlot() {
        if (!timestampTracker) return null;
        for (let i = 0; i < timestampTracker.slots.length; ++i) {
            const slot = timestampTracker.slots[timestampTracker.slotIndex];
            timestampTracker.slotIndex = (timestampTracker.slotIndex + 1) % timestampTracker.slots.length;
            if (!slot.busy) {
                slot.busy = true;
                return slot;
            }
        }
        return null;
    }

    let submittedFrameCount = 0;
    let retainedGpuTiming = null;
    let lastPerfSnapshot = createPerfSnapshot(caps.kind, { gpuTimingSupported: supportsTimestampQuery });

    function shouldSampleGpuTiming() {
        if (!supportsTimestampQuery || timingConfig.mode === "off") return false;
        if (timingConfig.mode === "detailed") return true;
        return submittedFrameCount % timingConfig.sampleInterval === 0;
    }

    function withRetainedGpuTiming(stats) {
        if (!retainedGpuTiming) return stats;
        return {
            ...stats,
            ...retainedGpuTiming,
            gpuTimingAgeFrames: submittedFrameCount - retainedGpuTiming.frameIndex,
        };
    }

    function beginFrame() {
        uniformRing.reset();
        const encoder = device.createCommandEncoder();
        const frameStats = createPerfSnapshot(caps.kind, { gpuTimingSupported: supportsTimestampQuery });
        const frameIndex = submittedFrameCount;
        const detailedTiming = timingConfig.mode === "detailed";
        const timingSlot = shouldSampleGpuTiming() ? acquireTimingSlot() : null;
        let queryCount = 0;
        const timingLabels = [];
        let activeComputePass = null;

        function allocTimestampWrites(label) {
            if (!timingSlot || !label || queryCount + 2 > TIMESTAMP_QUERY_CAPACITY) return undefined;
            const begin = queryCount++;
            const end = queryCount++;
            timingLabels.push({ label, begin, end });
            return {
                querySet: timestampTracker.querySet,
                beginningOfPassWriteIndex: begin,
                endOfPassWriteIndex: end,
            };
        }

        function beginComputePass(label) {
            if (activeComputePass) {
                if (!detailedTiming) {
                    frameStats.coalescedComputePasses += 1;
                    return activeComputePass;
                }
                endComputePass();
            }
            const descriptor = {};
            const timestampWrites = allocTimestampWrites(detailedTiming ? label : "trace");
            if (timestampWrites) descriptor.timestampWrites = timestampWrites;
            frameStats.computePasses += 1;
            activeComputePass = encoder.beginComputePass(descriptor);
            return activeComputePass;
        }

        function endComputePass() {
            if (!activeComputePass) return;
            activeComputePass.end();
            activeComputePass = null;
        }

        function beginRenderPass(label, attachment) {
            endComputePass();
            const descriptor = { colorAttachments: [attachment] };
            const timestampWrites = allocTimestampWrites(label);
            if (timestampWrites) descriptor.timestampWrites = timestampWrites;
            frameStats.renderPasses += 1;
            return encoder.beginRenderPass(descriptor);
        }

        function scheduleTimingReadback(submittedStats) {
            if (!timingSlot) return;
            if (queryCount === 0) {
                timingSlot.busy = false;
                return;
            }
            const labelCopy = timingLabels.map((entry) => ({ ...entry }));
            device.queue.onSubmittedWorkDone().then(async () => {
                let mapped = false;
                try {
                    await timingSlot.readBuffer.mapAsync(GPUMapMode.READ, 0, queryCount * 8);
                    mapped = true;
                    const mappedCopy = timingSlot.readBuffer.getMappedRange(0, queryCount * 8).slice(0);
                    timingSlot.readBuffer.unmap();
                    mapped = false;
                    const values = new BigUint64Array(mappedCopy);
                    const timings = labelCopy.map((entry) => ({
                        label: entry.label,
                        ms: Math.max(0, Number(values[entry.end] - values[entry.begin])) / NANOS_PER_MILLISECOND,
                    }));
                    lastPerfSnapshot = applyLabeledGpuTimings(submittedStats, timings);
                    retainedGpuTiming = {
                        frameIndex,
                        gpuMsTotal: lastPerfSnapshot.gpuMsTotal,
                        gpuMsInit: lastPerfSnapshot.gpuMsInit,
                        gpuMsTrace: lastPerfSnapshot.gpuMsTrace,
                        gpuMsSplat: lastPerfSnapshot.gpuMsSplat,
                        gpuMsBlit: lastPerfSnapshot.gpuMsBlit,
                        gpuMsComposite: lastPerfSnapshot.gpuMsComposite,
                        gpuTimedTraceSteps: lastPerfSnapshot.gpuTimedTraceSteps,
                    };
                } catch {
                    if (mapped) timingSlot.readBuffer.unmap();
                    lastPerfSnapshot = withRetainedGpuTiming(submittedStats);
                } finally {
                    timingSlot.busy = false;
                }
            });
        }

        return {
            updateRayState({ program, stateIn, stateOut, uniforms, raySize, activeRows }) {
                const isInit = program.kind === "init";
                if (isInit) {
                    initScratchF32[0] = uniforms.EmitterPos[0];
                    initScratchF32[1] = uniforms.EmitterPos[1];
                    initScratchF32[2] = uniforms.EmitterDir[0];
                    initScratchF32[3] = uniforms.EmitterDir[1];
                    initScratchF32[4] = uniforms.AngularSpread[0];
                    initScratchF32[5] = uniforms.AngularSpread[1];
                    initScratchF32[6] = uniforms.SpatialSpread;
                    initScratchF32[7] = uniforms.EmitterPower;
                    initScratchU32[8] = raySize;
                    initScratchU32[9] = activeRows;
                    const uniform = uniformRing.write(initScratch);
                    const group = getInitBindGroup(stateIn, stateOut, currentSpectrumHandle());
                    const pass = beginComputePass("init");
                    pass.setPipeline(program.pipeline);
                    pass.setBindGroup(0, group, [uniform.offset]);
                    frameStats.computeDispatches += 1;
                    pass.dispatchWorkgroups(Math.ceil(raySize / 8), Math.ceil(activeRows / 8));
                    return;
                }

                traceScratchU32[0] = raySize;
                traceScratchU32[1] = activeRows;
                traceScratchU32[2] = 0;
                traceScratchU32[3] = 0;
                const uniform = uniformRing.write(traceScratch);
                const group = getTraceBindGroup(stateIn, stateOut);
                const pass = beginComputePass("trace");
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group, [uniform.offset]);
                frameStats.computeDispatches += 1;
                pass.dispatchWorkgroups(Math.ceil(raySize / 8), Math.ceil(activeRows / 8));
            },
            splatRays({ program, waveBuffer, stateA, stateB, raysVbo, raysDrawCount, aspect, clearFirst }) {
                void raysVbo;
                splatScratchF32[0] = aspect;
                const uniform = uniformRing.write(splatScratch);
                const group = getSplatBindGroup(stateA, stateB);
                const drawArgs = createProceduralSplatDrawArgs(raysDrawCount);
                frameStats.traceSteps += 1;
                const pass = beginRenderPass("splat", {
                    view: waveBuffer.view,
                    loadOp: clearFirst ? "clear" : "load",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                });
                pass.setPipeline(selectSplatPipeline(program, waveBuffer));
                pass.setBindGroup(0, group, [uniform.offset]);
                frameStats.drawCalls += 1;
                pass.draw(drawArgs.vertexCount, drawArgs.instanceCount);
                pass.end();
            },
            splatRaysToAccumulation({ program, screenBuffer, stateA, stateB, raysVbo, raysDrawCount, aspect }) {
                void raysVbo;
                splatScratchF32[0] = aspect;
                const uniform = uniformRing.write(splatScratch);
                const group = getSplatBindGroup(stateA, stateB);
                const drawArgs = createProceduralSplatDrawArgs(raysDrawCount);
                frameStats.traceSteps += 1;
                frameStats.directWaveCommits += 1;
                const pass = beginRenderPass("splat", {
                    view: screenBuffer.view,
                    loadOp: "load",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                });
                pass.setPipeline(selectSplatPipeline(program, screenBuffer));
                pass.setBindGroup(0, group, [uniform.offset]);
                frameStats.drawCalls += 1;
                pass.draw(drawArgs.vertexCount, drawArgs.instanceCount);
                pass.end();
            },
            blit({ program, src, dst, additive }) {
                const group = getBlitBindGroup(src);
                frameStats.blits += 1;
                const pass = beginRenderPass("blit", {
                    view: dst.view,
                    loadOp: additive ? "load" : "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                });
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group);
                frameStats.drawCalls += 1;
                pass.draw(3);
                pass.end();
            },
            clearTexture(target) {
                const pass = beginRenderPass(null, {
                    view: target.view,
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                });
                pass.end();
            },
            composite({ program, screenBuffer, exposure, previewBuffer }) {
                composeScratchF32[0] = exposure;
                composeScratchF32[1] = previewBuffer ? 1.0 : 0.0;
                const uniform = uniformRing.write(composeScratch);
                const activeProgram = previewBuffer ? programs.get("compositePreview") : program;
                const group = previewBuffer
                    ? getComposePreviewBindGroup(screenBuffer, previewBuffer)
                    : getComposeBindGroup(screenBuffer);
                frameStats.composites += 1;
                const pass = beginRenderPass("composite", {
                    view: ctx.getCurrentTexture().createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                });
                pass.setPipeline(activeProgram.pipeline);
                pass.setBindGroup(0, group, [uniform.offset]);
                frameStats.drawCalls += 1;
                pass.draw(3);
                pass.end();
            },
            submit() {
                endComputePass();
                frameStats.submits = 1;
                const uniformStats = uniformRing.flush(device.queue);
                frameStats.uniformWrites += uniformStats.uniformWrites;
                frameStats.uniformBytes += uniformStats.uniformBytes;

                if (timingSlot && queryCount > 0) {
                    encoder.resolveQuerySet(timestampTracker.querySet, 0, queryCount, timingSlot.resolveBuffer, 0);
                    encoder.copyBufferToBuffer(timingSlot.resolveBuffer, 0, timingSlot.readBuffer, 0, queryCount * 8);
                }

                const commandBuffer = encoder.finish();
                const submittedStats = { ...frameStats };
                lastPerfSnapshot = withRetainedGpuTiming(submittedStats);
                device.queue.submit([commandBuffer]);
                submittedFrameCount += 1;
                scheduleTimingReadback(submittedStats);
            },
        };
    }

    return {
        caps,
        canvas,
        createRayState,
        createRenderTexture,
        createQuadGeometry,
        createRayLineGeometry,
        loadProgram,
        uploadSpectrumResources,
        resize,
        beginFrame,
        getPerfSnapshot() {
            return { ...lastPerfSnapshot };
        },
    };
}
