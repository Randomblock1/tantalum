/**
 * Backend selection: prefer WebGPU, silently fall back to WebGL 2.
 *
 * Required WebGPU features (both or fall back):
 *   - float32-blendable  (additive blending into rgba32float wave buffer)
 *   - float32-filterable (linear sampling of spectrum table)
 *
 * WebGL path throws its own precise errors if the platform lacks
 * OES_texture_float_linear / EXT_color_buffer_float; the selector
 * re-throws those so the page's fail UI has something meaningful.
 */

import { makeWebGPUBackend } from "./webgpu.js";

const REQUIRED_FEATURES = ["float32-blendable", "float32-filterable"];

export async function selectBackend(canvas, opts = {}) {
    let preferWebGPU = opts.preferWebGPU !== false;
    try {
        if (localStorage.getItem("tantalum-backend") === "webgl") preferWebGPU = false;
    } catch {
        /* localStorage blocked (private mode, sandboxed iframe) — fall back to default. */
    }

    if (preferWebGPU && "gpu" in navigator) {
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
            if (adapter && REQUIRED_FEATURES.every((f) => adapter.features.has(f))) {
                const device = await adapter.requestDevice({ requiredFeatures: REQUIRED_FEATURES });
                return await makeWebGPUBackend(canvas, device, adapter);
            }
        } catch (e) {
            console.warn("WebGPU unavailable, falling back to WebGL 2:", e);
        }
    }

    if (!window.makeWebGLBackend) throw new Error("WebGL backend not loaded");
    return window.makeWebGLBackend(canvas);
}
