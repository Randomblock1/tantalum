/**
 * WebGPU backend. Implements the Backend interface from ./backend.js using
 * storage buffers for ray state and compute shaders for init/trace.
 * This module is loaded lazily by ./select.js; consumers should not import
 * it directly unless they've already confirmed navigator.gpu support.
 */

import { expandIncludes } from "./wgsl-loader.js";
import { createBinaryCache, createTernaryCache, createUnaryCache } from "./webgpu-bind-group-cache.js";

/* Shader sources — populated as phases C–E land real modules. */
import preambleSrc from "../../shaders/wgsl/preamble.wgsl?raw";
import composeSrc from "../../shaders/wgsl/compose.wgsl?raw";
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

    const wgsl = {
        preamble: preambleSrc,
        rand: randSrc,
        bsdf: bsdfSrc,
        intersect: intersectSrc,
        csg: csgSrc,
        trace: traceSrc,
        compose: composeSrc,
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
        const format = channels === 4 ? "rgba32float" : "r32float";
        const width = data.length / channels;
        const tex = device.createTexture({
            size: { width, height: 1 },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const bytesPerPixel = channels * 4;
        device.queue.writeTexture(
            { texture: tex },
            data.buffer,
            { bytesPerRow: Math.max(256, width * bytesPerPixel) },
            { width, height: 1 },
        );
        return { texture: tex, view: tex.createView(), width, channels };
    }

    function loadShaderModule(entry) {
        const code = expandIncludes(entry, wgsl);
        return device.createShaderModule({ code, label: entry });
    }

    /* Programs exposed to the Renderer are opaque handles. Each carries
       its kind so the frame methods can pick the right pipeline. */
    const programs = new Map();

    const composeModule = loadShaderModule("compose");
    const composeLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
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
    programs.set("composite", { kind: "composite", pipeline: composePipeline, layout: composeLayout });

    const rayModule = loadShaderModule("ray");
    const rayLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            {
                binding: 1,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "read-only-storage" },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "read-only-storage" },
            },
        ],
    });
    const rayPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [rayLayout] }),
        vertex: {
            module: rayModule,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: 12,
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
                },
            ],
        },
        fragment: {
            module: rayModule,
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
        primitive: { topology: "line-list" },
    });
    programs.set("splat", { kind: "splat", pipeline: rayPipeline, layout: rayLayout });

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
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
            { binding: 7, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        ],
    });
    const initPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [initLayout] }),
        compute: { module: initModule, entryPoint: "cs" },
    });
    programs.set("init", { kind: "init", pipeline: initPipeline, layout: initLayout });

    const traceLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
    });
    for (const scene of ["scene1", "scene2", "scene3", "scene4", "scene5", "scene6", "scene7"]) {
        const mod = loadShaderModule(scene);
        const pipe = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout] }),
            compute: { module: mod, entryPoint: "cs" },
        });
        programs.set(`trace:${scene}`, { kind: "trace", pipeline: pipe, layout: traceLayout, scene });
    }

    /* Persistent uniform buffers — one per pass, reused every frame. */
    const initUBuf = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const traceUBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const splatUBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const composeUBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    /* Scratch ArrayBuffers for packing uniforms without per-frame allocation. */
    const initScratch = new ArrayBuffer(48);
    const initScratchF32 = new Float32Array(initScratch);
    const initScratchU32 = new Uint32Array(initScratch);
    const traceScratch = new ArrayBuffer(16);
    const traceScratchU32 = new Uint32Array(traceScratch);
    const splatScratch = new ArrayBuffer(16);
    const splatScratchF32 = new Float32Array(splatScratch);
    const splatScratchU32 = new Uint32Array(splatScratch);
    const composeScratch = new ArrayBuffer(16);
    const composeScratchF32 = new Float32Array(composeScratch);

    /* Bind group caches keyed by object identity so replaced textures/buffers
       can fall out of the cache naturally after resizes or resource rebuilds. */
    let spectrumHandle = null;
    const getInitBindGroup = createTernaryCache((stateIn, stateOut, spectrum) =>
        device.createBindGroup({
            layout: initLayout,
            entries: [
                { binding: 0, resource: { buffer: initUBuf } },
                { binding: 1, resource: { buffer: stateIn.buffer } },
                { binding: 2, resource: { buffer: stateOut.buffer } },
                { binding: 3, resource: spectrum.spectrum.view },
                { binding: 4, resource: spectrum.emission.view },
                { binding: 5, resource: spectrum.icdf.view },
                { binding: 6, resource: spectrum.pdf.view },
                { binding: 7, resource: linearSampler },
            ],
        }),
    );
    const getTraceBindGroup = createBinaryCache((stateIn, stateOut) =>
        device.createBindGroup({
            layout: traceLayout,
            entries: [
                { binding: 0, resource: { buffer: traceUBuf } },
                { binding: 1, resource: { buffer: stateIn.buffer } },
                { binding: 2, resource: { buffer: stateOut.buffer } },
            ],
        }),
    );
    const getSplatBindGroup = createBinaryCache((stateA, stateB) =>
        device.createBindGroup({
            layout: rayLayout,
            entries: [
                { binding: 0, resource: { buffer: splatUBuf } },
                { binding: 1, resource: { buffer: stateA.buffer } },
                { binding: 2, resource: { buffer: stateB.buffer } },
            ],
        }),
    );
    const getBlitBindGroup = createUnaryCache((src) =>
        device.createBindGroup({
            layout: passLayout,
            entries: [{ binding: 0, resource: src.view }],
        }),
    );
    const getComposeBindGroup = createBinaryCache((screen, preview) =>
        device.createBindGroup({
            layout: composeLayout,
            entries: [
                { binding: 0, resource: { buffer: composeUBuf } },
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

    function createRayState(size) {
        const rayCount = size * size;
        const byteLen = rayCount * 48;
        /* Initialize pos=(0,0), dir=(cos θ, sin θ), rng ∈ [0, 4194167), rgb=0 */
        const init = new Float32Array(rayCount * 12);
        for (let i = 0; i < rayCount; ++i) {
            const base = i * 12;
            const theta = Math.random() * Math.PI * 2.0;
            init[base + 0] = 0.0;
            init[base + 1] = 0.0;
            init[base + 2] = Math.cos(theta);
            init[base + 3] = Math.sin(theta);
            for (let t = 0; t < 4; ++t) init[base + 4 + t] = Math.random() * 4194167.0;
            for (let t = 0; t < 4; ++t) init[base + 8 + t] = 0.0;
        }
        const make = () => {
            const b = device.createBuffer({
                size: byteLen,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                mappedAtCreation: true,
            });
            new Float32Array(b.getMappedRange()).set(init);
            b.unmap();
            return b;
        };
        return { size, posDir: null, buffer: make(), byteLen };
    }
    function createRenderTexture(w, h) {
        const tex = device.createTexture({
            size: { width: w, height: h },
            format: "rgba32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        });
        return { width: w, height: h, texture: tex, view: tex.createView() };
    }
    function createQuadGeometry() {
        return { kind: "quad" }; /* Compose pass uses vertex_index, no buffer needed. */
    }
    function createRayLineGeometry(raySize) {
        const count = raySize * raySize;
        const data = new Float32Array(count * 2 * 3);
        for (let i = 0; i < count; ++i) {
            const u = ((i % raySize) + 0.5) / raySize;
            const v = (Math.floor(i / raySize) + 0.5) / raySize;
            data[i * 6 + 0] = data[i * 6 + 3] = u;
            data[i * 6 + 1] = data[i * 6 + 4] = v;
            data[i * 6 + 2] = 0.0;
            data[i * 6 + 5] = 1.0;
        }
        const buf = device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(buf.getMappedRange()).set(data);
        buf.unmap();
        return { buffer: buf, stride: 12, count: count * 2 };
    }
    function loadProgram(kind, name) {
        const key = kind === "trace" ? `trace:${name}` : kind;
        const p = programs.get(key);
        if (!p) throw new Error(`WebGPU: program ${kind}/${name} not wired`);
        return p;
    }
    function uploadSpectrumResources(spec) {
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
        };
        spectrumHandle = handle;
        return handle;
    }
    function resize(w, h) {
        canvas.width = w;
        canvas.height = h;
    }

    let lastPerfSnapshot = {
        backend: caps.kind,
        submits: 0,
        computePasses: 0,
        renderPasses: 0,
        blits: 0,
        composites: 0,
    };

    function beginFrame() {
        const encoder = device.createCommandEncoder();
        const frameStats = {
            backend: caps.kind,
            submits: 0,
            computePasses: 0,
            renderPasses: 0,
            blits: 0,
            composites: 0,
        };
        let computePass = null;

        function endComputePass() {
            if (!computePass) return;
            computePass.end();
            computePass = null;
        }

        function getComputePass() {
            if (!computePass) {
                computePass = encoder.beginComputePass();
                frameStats.computePasses += 1;
            }
            return computePass;
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
                    device.queue.writeBuffer(initUBuf, 0, initScratch);
                    const group = getInitBindGroup(stateIn, stateOut, currentSpectrumHandle());
                    const pass = getComputePass();
                    pass.setPipeline(program.pipeline);
                    pass.setBindGroup(0, group);
                    pass.dispatchWorkgroups(Math.ceil(raySize / 8), Math.ceil(activeRows / 8));
                    return;
                }
                /* trace */
                traceScratchU32[0] = raySize;
                traceScratchU32[1] = activeRows;
                traceScratchU32[2] = 0;
                traceScratchU32[3] = 0;
                device.queue.writeBuffer(traceUBuf, 0, traceScratch);
                const group = getTraceBindGroup(stateIn, stateOut);
                const pass = getComputePass();
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(Math.ceil(raySize / 8), Math.ceil(activeRows / 8));
            },
            splatRays({ program, waveBuffer, stateA, stateB, raysVbo, raysDrawCount, aspect, clearFirst }) {
                endComputePass();
                splatScratchF32[0] = aspect;
                splatScratchU32[1] = stateA.size;
                splatScratchU32[2] = 0;
                splatScratchU32[3] = 0;
                device.queue.writeBuffer(splatUBuf, 0, splatScratch);
                const group = getSplatBindGroup(stateA, stateB);
                frameStats.renderPasses += 1;
                const pass = encoder.beginRenderPass({
                    colorAttachments: [
                        {
                            view: waveBuffer.view,
                            loadOp: clearFirst ? "clear" : "load",
                            storeOp: "store",
                            clearValue: { r: 0, g: 0, b: 0, a: 1 },
                        },
                    ],
                });
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group);
                pass.setVertexBuffer(0, raysVbo.buffer);
                pass.draw(raysDrawCount, 1);
                pass.end();
            },
            blit({ program, src, dst, additive }) {
                endComputePass();
                const group = getBlitBindGroup(src);
                frameStats.renderPasses += 1;
                frameStats.blits += 1;
                const pass = encoder.beginRenderPass({
                    colorAttachments: [
                        {
                            view: dst.view,
                            loadOp: additive ? "load" : "clear",
                            storeOp: "store",
                            clearValue: { r: 0, g: 0, b: 0, a: 1 },
                        },
                    ],
                });
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group);
                pass.draw(3);
                pass.end();
            },
            clearTexture(target) {
                endComputePass();
                frameStats.renderPasses += 1;
                const pass = encoder.beginRenderPass({
                    colorAttachments: [
                        {
                            view: target.view,
                            loadOp: "clear",
                            storeOp: "store",
                            clearValue: { r: 0, g: 0, b: 0, a: 1 },
                        },
                    ],
                });
                pass.end();
            },
            composite({ program, screenBuffer, exposure, previewBuffer }) {
                endComputePass();
                composeScratchF32[0] = exposure;
                composeScratchF32[1] = previewBuffer ? 1.0 : 0.0;
                device.queue.writeBuffer(composeUBuf, 0, composeScratch);
                const group = getComposeBindGroup(screenBuffer, previewBuffer || screenBuffer);
                frameStats.renderPasses += 1;
                frameStats.composites += 1;
                const pass = encoder.beginRenderPass({
                    colorAttachments: [
                        {
                            view: ctx.getCurrentTexture().createView(),
                            loadOp: "clear",
                            storeOp: "store",
                            clearValue: { r: 0, g: 0, b: 0, a: 1 },
                        },
                    ],
                });
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group);
                pass.draw(3);
                pass.end();
            },
            submit() {
                endComputePass();
                frameStats.submits = 1;
                lastPerfSnapshot = frameStats;
                device.queue.submit([encoder.finish()]);
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
