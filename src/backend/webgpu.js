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

    const wgsl = { preamble: preambleSrc, compose: composeSrc };

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

    /* Stubs — filled in by later tasks. */
    function createRayState(_size) {
        throw new Error("createRayState: WebGPU path not implemented until Task D2");
    }
    function createRenderTexture(w, h) {
        const tex = device.createTexture({
            size: { width: w, height: h },
            format: "rgba32float",
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.COPY_DST,
        });
        return { width: w, height: h, texture: tex, view: tex.createView() };
    }
    function createQuadGeometry() {
        return { kind: "quad" }; /* Compose pass uses vertex_index, no buffer needed. */
    }
    function createRayLineGeometry(_raySize) {
        throw new Error("createRayLineGeometry: not implemented until Task D3");
    }
    function loadProgram(kind, _name) {
        const p = programs.get(kind);
        if (!p) throw new Error(`WebGPU: program kind '${kind}' not yet wired`);
        return p;
    }
    function uploadSpectrumResources(_spec) {
        throw new Error("uploadSpectrumResources: not implemented until Task E8");
    }
    function resize(w, h) {
        canvas.width = w;
        canvas.height = h;
    }

    function beginFrame() {
        const encoder = device.createCommandEncoder();
        return {
            updateRayState() {
                throw new Error("updateRayState: not implemented until Task E13");
            },
            splatRays() {
                throw new Error("splatRays: not implemented until Task D4");
            },
            blit() {
                throw new Error("blit: not implemented until Task D5");
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
                    size: 16,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(uBuf, 0, new Float32Array([exposure, 0, 0, 0]));
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
