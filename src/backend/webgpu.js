/**
 * WebGPU backend. Implements the Backend interface from ./backend.js using
 * storage buffers for ray state and compute shaders for init/trace.
 * This module is loaded lazily by ./select.js; consumers should not import
 * it directly unless they've already confirmed navigator.gpu support.
 */

import { expandIncludes } from "./wgsl-loader.js";

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
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
        ],
    });
    const composePipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [composeLayout] }),
        vertex: { module: composeModule, entryPoint: "vs" },
        fragment: { module: composeModule, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
    });
    programs.set("composite", { kind: "composite", pipeline: composePipeline, layout: composeLayout });

    const composeSampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });

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

    /* Stubs — filled in by later tasks. */
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
        return {
            spectrum,
            emission,
            icdf,
            pdf,
            sampler: linearSampler,
            updateEmission: (data) => rewrite(emission, data),
            updateIcdf: (data) => rewrite(icdf, data),
            updatePdf: (data) => rewrite(pdf, data),
        };
    }
    function resize(w, h) {
        canvas.width = w;
        canvas.height = h;
    }

    function beginFrame() {
        const encoder = device.createCommandEncoder();
        return {
            updateRayState({ program, stateIn, stateOut, uniforms, textureBindings, raySize, activeRows }) {
                const isInit = program.kind === "init";
                if (isInit) {
                    const uBuf = device.createBuffer({
                        size: 48,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    const u = new ArrayBuffer(48);
                    const f = new Float32Array(u);
                    const i = new Uint32Array(u);
                    f[0] = uniforms.EmitterPos[0];
                    f[1] = uniforms.EmitterPos[1];
                    f[2] = uniforms.EmitterDir[0];
                    f[3] = uniforms.EmitterDir[1];
                    f[4] = uniforms.AngularSpread[0];
                    f[5] = uniforms.AngularSpread[1];
                    f[6] = uniforms.SpatialSpread;
                    f[7] = uniforms.EmitterPower;
                    i[8] = raySize;
                    i[9] = activeRows;
                    device.queue.writeBuffer(uBuf, 0, u);
                    const group = device.createBindGroup({
                        layout: program.layout,
                        entries: [
                            { binding: 0, resource: { buffer: uBuf } },
                            { binding: 1, resource: { buffer: stateIn.buffer } },
                            { binding: 2, resource: { buffer: stateOut.buffer } },
                            { binding: 3, resource: textureBindings.Spectrum.view },
                            { binding: 4, resource: textureBindings.Emission.view },
                            { binding: 5, resource: textureBindings.ICDF.view },
                            { binding: 6, resource: textureBindings.PDF.view },
                            { binding: 7, resource: linearSampler },
                        ],
                    });
                    const pass = encoder.beginComputePass();
                    pass.setPipeline(program.pipeline);
                    pass.setBindGroup(0, group);
                    pass.dispatchWorkgroups(Math.ceil(raySize / 8), Math.ceil(activeRows / 8));
                    pass.end();
                    return;
                }
                /* trace */
                const uBuf = device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(uBuf, 0, new Uint32Array([raySize, activeRows, 0, 0]));
                const group = device.createBindGroup({
                    layout: program.layout,
                    entries: [
                        { binding: 0, resource: { buffer: uBuf } },
                        { binding: 1, resource: { buffer: stateIn.buffer } },
                        { binding: 2, resource: { buffer: stateOut.buffer } },
                    ],
                });
                const pass = encoder.beginComputePass();
                pass.setPipeline(program.pipeline);
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(Math.ceil(raySize / 8), Math.ceil(activeRows / 8));
                pass.end();
            },
            splatRays({ program, waveBuffer, stateA, stateB, raysVbo, raysDrawCount, aspect, clearFirst }) {
                const uBuf = device.createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(uBuf, 0, new Uint32Array([0, stateA.size, 0, 0]));
                /* Stride replaces the float0 slot with `aspect` so two writes don't overlap. */
                device.queue.writeBuffer(uBuf, 0, new Float32Array([aspect]));
                const group = device.createBindGroup({
                    layout: program.layout,
                    entries: [
                        { binding: 0, resource: { buffer: uBuf } },
                        { binding: 1, resource: { buffer: stateA.buffer } },
                        { binding: 2, resource: { buffer: stateB.buffer } },
                    ],
                });
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
                const group = device.createBindGroup({
                    layout: program.layout,
                    entries: [{ binding: 0, resource: src.view }],
                });
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
            composite({ program, screenBuffer, exposure }) {
                const uBuf = device.createBuffer({
                    size: 32,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(uBuf, 0, new Float32Array([exposure, 0, 0, 0, 0, 0, 0, 0]));
                const group = device.createBindGroup({
                    layout: program.layout,
                    entries: [
                        { binding: 0, resource: { buffer: uBuf } },
                        { binding: 1, resource: screenBuffer.view },
                        { binding: 2, resource: composeSampler },
                    ],
                });
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
    };
}
