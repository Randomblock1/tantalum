# WebGPU Migration Notes

## Architecture

`src/tantalum-core.js` (the Renderer) talks to a single `Backend` interface
(`src/backend/backend.js`). Two implementations live beside it:

- `src/backend/webgl.js` — wraps `src/tantalum-gl.js` (tgl) and the GLSL shaders.
- `src/backend/webgpu.js` — uses a `GPUDevice`, storage-buffer ping-pong ray
  state, compute pipelines (init + per-scene trace), and a line-list render
  pass for the splat accumulation into an `rgba32float` wave buffer.

`src/backend/select.js` picks WebGPU when the adapter exposes both
`float32-blendable` and `float32-filterable`; otherwise it silently falls
back to WebGL 2.

## Feature-gate matrix

| Feature flag         | Why we need it                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| `float32-blendable`  | Additive blending into the `rgba32float` wave buffer (the splat pass is additive). |
| `float32-filterable` | Linear sampling of the spectrum/ICDF/PDF 1-D tables in `init.wgsl`.                |

If either is missing we demote to WebGL 2, which has the equivalent extensions
(`EXT_float_blend`, `OES_texture_float_linear`) and the additional
`EXT_color_buffer_float`.

## Debugging

- `window.tantalumBackendKind` reports `"webgpu"` or `"webgl2"` after setup.
- Force the fallback path by launching Chromium with `--disable-features=WebGPU`.
- For Vulkan-less environments, set `launchOptions.args = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"]` in Playwright; without Vulkan the selector drops to WebGL and the WebGPU spec skips.

## Out of scope (tracked separately)

- Compute-based accumulation for adapters that lack `float32-blendable`.
- `rgba16float` precision toggle.
- `GPUQuerySet`-based perf instrumentation.
