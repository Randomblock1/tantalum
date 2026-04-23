/**
 * Backend interface used by the Renderer (src/tantalum-core.js).
 *
 * Two implementations exist: src/backend/webgl.js wraps the existing
 * WebGL 2 / tgl pipeline; src/backend/webgpu.js drives a WebGPU device
 * with compute shaders and storage buffers. The Renderer only talks to
 * this interface — it does not import tgl or GPUDevice directly.
 *
 * Handles (RayState, RenderTexture, Program, Vbo) are opaque from the
 * Renderer's perspective. Each backend creates its own concrete
 * implementations and interprets them in its command methods.
 */

/**
 * @typedef {Object} BackendCaps
 * @property {"webgl2"|"webgpu"} kind
 * @property {boolean} hasFloat32Blend  - Can rgba32float color targets blend additively.
 * @property {boolean} hasLinearFloat   - Can float textures be linearly filtered.
 */

/**
 * @typedef {Object} UpdateRayStateArgs
 * @property {Program} program
 * @property {RayState} stateIn
 * @property {RayState} stateOut
 * @property {Object} uniforms           - Plain JS object; values are scalars, tuples, or SpectrumResources-derived handles.
 * @property {number} raySize            - Width (== height) of the square ray grid.
 * @property {number} activeRows         - Rows to dispatch/scissor (1..raySize).
 */

/**
 * @typedef {Object} SplatRaysArgs
 * @property {RenderTexture} waveBuffer  - rgba32float target.
 * @property {RayState} stateA
 * @property {RayState} stateB
 * @property {Vbo} raysVbo
 * @property {number} raysDrawCount      - Number of vertices to draw (2 per line).
 * @property {number} aspect
 * @property {number} raySize
 */

/**
 * @typedef {Object} BlitArgs
 * @property {RenderTexture} src
 * @property {RenderTexture} dst
 */

/**
 * @typedef {Object} CompositeArgs
 * @property {RenderTexture} screenBuffer
 * @property {number} exposure
 * @property {RenderTexture | undefined} [previewBuffer]
 */

/**
 * @typedef {Object} Frame
 * @property {(args: UpdateRayStateArgs) => void} updateRayState
 * @property {(args: SplatRaysArgs) => void} splatRays
 * @property {(args: BlitArgs) => void} blit
 * @property {(target: RenderTexture) => void} clearTexture
 * @property {(args: CompositeArgs) => void} composite
 * @property {() => void} submit
 */

/**
 * @typedef {Object} Backend
 * @property {BackendCaps} caps
 * @property {HTMLCanvasElement} canvas
 * @property {(size: number) => RayState} createRayState
 * @property {(w: number, h: number, opts?: {format?: "rgba32float"}) => RenderTexture} createRenderTexture
 * @property {() => Vbo} createQuadGeometry
 * @property {(raySize: number) => Vbo} createRayLineGeometry
 * @property {(kind: "init"|"trace"|"splat"|"blit"|"composite", name: string) => Program} loadProgram
 * @property {(spec: {spectrum: Float32Array, emission: Float32Array, icdf: Float32Array, pdf: Float32Array}) => SpectrumResources} uploadSpectrumResources
 * @property {(w: number, h: number) => void} resize    - Called when canvas size changes.
 * @property {() => Frame} beginFrame
 * @property {() => Object | null} [getPerfSnapshot]
 */

/**
 * A sentinel backend that throws on every call. Used in tests to assert
 * the Renderer only talks to its backend via the public methods.
 * @returns {Backend}
 */
export function makeNullBackend() {
    const fail = (method) => () => {
        throw new Error(`NullBackend.${method} called`);
    };
    return {
        caps: { kind: "webgl2", hasFloat32Blend: false, hasLinearFloat: false },
        canvas: /** @type {HTMLCanvasElement} */ (null),
        createRayState: fail("createRayState"),
        createRenderTexture: fail("createRenderTexture"),
        createQuadGeometry: fail("createQuadGeometry"),
        createRayLineGeometry: fail("createRayLineGeometry"),
        loadProgram: fail("loadProgram"),
        uploadSpectrumResources: fail("uploadSpectrumResources"),
        resize: fail("resize"),
        beginFrame: fail("beginFrame"),
        getPerfSnapshot: () => null,
    };
}
