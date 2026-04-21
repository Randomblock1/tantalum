# WebGPU Migration — Phases B–G Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are sized so a fresh agent can pick up any single task after compaction.

**Goal:** Land the WebGPU rendering path with a WebGL 2 fallback, preserving visuals across all seven scenes.

**Architecture:** Phase A (already shipped) introduced a `Backend` interface (`src/backend/backend.js`) that the Renderer (`src/tantalum-core.js`) calls; `src/backend/webgl.js` satisfies it today. This plan adds `src/backend/webgpu.js` (compute + line-list render pass), a hand-ported WGSL shader tree under `shaders/wgsl/`, and a selector (`src/backend/select.js`) that tries WebGPU first and silently falls back to WebGL when `float32-blendable` + `float32-filterable` aren't both available.

**Tech Stack:** Vite 6 (modules via `?raw` imports for WGSL), WebGPU (`navigator.gpu`), WGSL (hand-translated from GLSL 300 ES), `naga-cli` for CI validation, Playwright 1.x for e2e (WebGL spec + WebGPU spec), Python 3 tooling in `tools/`.

---

## Preconditions (Phase A, already done)

- `src/backend/backend.js` — JSDoc interface + `makeNullBackend`.
- `src/backend/webgl.js` — WebGL 2 backend. Exposes `window.makeWebGLBackend` and ES `export`.
- `src/tantalum-core.js` — Renderer uses `this.backend`; no direct `gl`/`tgl` calls.
- `src/tantalum.js` — `setupGL()` calls `window.makeWebGLBackend(this.canvas)`.
- `tests/e2e/smoke.spec.js` — asserts rays trace (non-zero `.progress-label` count).
- `compile-shaders.py` reads `shaders/*.txt` → `src/tantalum-shaders.js`.
- `tools/validate_shaders.py` runs `glslangValidator` on expanded single-output shaders.
- CI (`.github/workflows/ci.yml`) runs lint, format:check, build, shader validator, Playwright.

File layout today (relevant slice):

```
shaders/
  preamble.txt  rand.txt  bsdf.txt  intersect.txt  csg-intersect.txt
  compose-{vert,frag}.txt  pass-frag.txt  init-{vert,frag}.txt
  trace-{vert,frag}.txt    ray-{vert,frag}.txt
  scene1..7.txt            blend-test-{vert,frag,pack-frag}.txt
src/backend/
  backend.js  webgl.js
src/
  main.js  tantalum.js  tantalum-core.js  tantalum-gl.js  tantalum-shaders.js
  tantalum-ui.js  bootstrap.js  spectrum.js  gasspectra.js  download.js
tests/e2e/
  smoke.spec.js
index.html  tantalum.html  vite.config.js  eslint.config.js  playwright.config.js
```

File layout at end of plan:

```
shaders/
  glsl/<all existing *.txt, unchanged>
  wgsl/
    preamble.wgsl  rand.wgsl  bsdf.wgsl  intersect.wgsl  csg.wgsl
    compose.wgsl   pass.wgsl   ray.wgsl
    init.wgsl      trace.wgsl  scene1..7.wgsl
src/backend/
  backend.js  webgl.js  webgpu.js  select.js
  wgsl-loader.js
docs/
  webgpu-migration.md
tests/e2e/
  smoke.spec.js  webgpu-smoke.spec.js
```

Reference: the original umbrella plan lives at `~/.claude/plans/create-a-plan-to-reflective-wilkes.md`. This plan supersedes its Phase B–G sections with finer-grained tasks.

---

# Phase B — Shader tree relocation and WGSL scaffolding

## Task B1: Move GLSL under `shaders/glsl/`

**Files:**
- Move: all `shaders/*.txt` → `shaders/glsl/*.txt`.

- [ ] **Step 1: Create the new directory and move files**

```bash
mkdir -p shaders/glsl
git mv shaders/*.txt shaders/glsl/
```

- [ ] **Step 2: Verify**

```bash
ls shaders/glsl | wc -l
```

Expected: `24` (one line per file).

```bash
ls shaders 2>&1
```

Expected: just `glsl`.

- [ ] **Step 3: Commit**

```bash
git add shaders
git commit -m "Move GLSL sources under shaders/glsl/"
```

---

## Task B2: Point `compile-shaders.py` at `shaders/glsl/`

**Files:**
- Modify: `compile-shaders.py:6` (`SHADER_DIR`).

- [ ] **Step 1: Edit `SHADER_DIR`**

Change line 6 from:

```python
SHADER_DIR = Path("shaders")
```

to:

```python
SHADER_DIR = Path("shaders/glsl")
```

- [ ] **Step 2: Regenerate and check for drift**

```bash
python3 compile-shaders.py
git diff --exit-code src/tantalum-shaders.js
```

Expected: no diff (byte-identical packed output).

- [ ] **Step 3: Commit**

```bash
git add compile-shaders.py
git commit -m "Point compile-shaders.py at shaders/glsl/"
```

---

## Task B3: Point `tools/validate_shaders.py` at `shaders/glsl/`

**Files:**
- Modify: `tools/validate_shaders.py:14` (`SHADER_DIR`).

- [ ] **Step 1: Edit `SHADER_DIR`**

Change line 14 from:

```python
SHADER_DIR = ROOT / "shaders"
```

to:

```python
SHADER_DIR = ROOT / "shaders" / "glsl"
```

- [ ] **Step 2: Run the validator**

```bash
npm run validate-shaders
```

Expected: `validate_shaders: OK` (or the skip message if `glslangValidator` isn't installed locally — CI has it).

- [ ] **Step 3: Commit**

```bash
git add tools/validate_shaders.py
git commit -m "Point validate_shaders.py at shaders/glsl/"
```

---

## Task B4: Create `shaders/wgsl/` with an empty `hello.wgsl` placeholder

**Files:**
- Create: `shaders/wgsl/hello.wgsl`.

This directory must exist before Vite resolves imports in Phase C. The placeholder is deleted in Task E11 after real scene modules land — noted here so a future reader isn't surprised.

- [ ] **Step 1: Write the placeholder**

```bash
mkdir -p shaders/wgsl
cat > shaders/wgsl/hello.wgsl <<'WGSL'
// Placeholder; removed once real WGSL modules exist. See plan Task E11.
const TAU: f32 = 6.2831853;
WGSL
```

- [ ] **Step 2: Commit**

```bash
git add shaders/wgsl
git commit -m "Scaffold shaders/wgsl/ tree"
```

---

## Task B5: Add a tiny WGSL `#include` loader (pure JS, no Vite plugin)

Rationale: `vite-plugin-glsl` supports WGSL but pulls in a chunky dep just to resolve `#include`. Our shader count is small and includes are trivial; a 30-line JS helper keeps the bundle lean and the CI path identical for both dev and build.

**Files:**
- Create: `src/backend/wgsl-loader.js`.

- [ ] **Step 1: Write the loader**

```javascript
/**
 * Minimal WGSL include expander. Resolves `#include "name"` against a map of
 * already-imported module sources. Non-recursive guard via a visited set.
 *
 * Typical use:
 *   import rand     from "../../shaders/wgsl/rand.wgsl?raw";
 *   import preamble from "../../shaders/wgsl/preamble.wgsl?raw";
 *   import init     from "../../shaders/wgsl/init.wgsl?raw";
 *   const src = expandIncludes("init", { preamble, rand, init });
 */

const INCLUDE_RE = /^\s*#include\s+"([^"]+)"\s*$/;

export function expandIncludes(entryName, modules) {
    const visited = new Set();
    function expand(name) {
        if (visited.has(name)) throw new Error(`Circular include: ${name}`);
        const src = modules[name];
        if (src === undefined) throw new Error(`Unknown WGSL module: ${name}`);
        visited.add(name);
        const lines = [];
        for (const line of src.split("\n")) {
            const m = INCLUDE_RE.exec(line);
            if (m) lines.push(expand(m[1]));
            else lines.push(line);
        }
        visited.delete(name);
        return lines.join("\n");
    }
    return expand(entryName);
}
```

- [ ] **Step 2: Verify it lints**

```bash
npm run lint
```

Expected: no output (pass).

- [ ] **Step 3: Commit**

```bash
git add src/backend/wgsl-loader.js
git commit -m "Add WGSL #include expander"
```

---

# Phase C — WebGPU backend bootstrap + composite/pass

## Task C1: Add `selectBackend` wrapper

**Files:**
- Create: `src/backend/select.js`.

- [ ] **Step 1: Write the selector**

```javascript
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
    const preferWebGPU = opts.preferWebGPU !== false;

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
```

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: pass. (Will fail until webgpu.js exists — that's fine; do C2 next and re-lint.)

*Do not commit yet — C2 adds the webgpu.js module that this import references.*

---

## Task C2: Create `src/backend/webgpu.js` skeleton

**Files:**
- Create: `src/backend/webgpu.js`.

- [ ] **Step 1: Write the skeleton**

```javascript
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
```

- [ ] **Step 2: Do not commit yet.**

The file imports `shaders/wgsl/preamble.wgsl` and `compose.wgsl`. Those don't exist yet; Tasks C3 and C4 create them.

---

## Task C3: Write `shaders/wgsl/preamble.wgsl`

**Files:**
- Create: `shaders/wgsl/preamble.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
const PI: f32 = 3.14159265358979323846;
const PI_HALF: f32 = 1.57079632679489661923;
const SQRT2: f32 = 1.41421356237309504880;

struct Ray {
    posDir:    vec4f,  // xy pos, zw dir
    rng:       vec4f,
    rgbLambda: vec4f,  // rgb throughput, lambda (nm)
}

struct Intersection {
    tMin: f32,
    tMax: f32,
    n:    vec2f,
    mat:  f32,
}
```

*No tests yet — consumed by init/trace shaders in Phase E.*

---

## Task C4: Write `shaders/wgsl/compose.wgsl`

GLSL reference: `shaders/glsl/compose-{vert,frag}.txt`.

**Files:**
- Create: `shaders/wgsl/compose.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
struct Uniforms {
    exposure: f32,
    _pad:     vec3f,
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var frameTex: texture_2d<f32>;
@group(0) @binding(2) var frameSmp: sampler;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0)       uv:  vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    // Full-screen triangle covering the viewport.
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var uvs     = array<vec2f, 3>(vec2f( 0.0,  1.0), vec2f(2.0,  1.0), vec2f( 0.0, -1.0));
    var out: VSOut;
    out.pos = vec4f(corners[vi], 0.0, 1.0);
    out.uv  = uvs[vi];
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let dims = vec2f(textureDimensions(frameTex, 0));
    let rgb  = textureLoad(frameTex, vec2i(in.uv * dims), 0).rgb * U.exposure;
    return vec4f(pow(rgb, vec3f(1.0 / 2.2)), 1.0);
}
```

Note: `textureLoad` is used rather than `textureSample` because `screenBuffer` is `rgba32float` and the bind group layout declares `sampleType: "unfilterable-float"`. The UV flip (`1.0` → `-1.0`) matches the GLSL `pass-frag`/`compose-frag` convention where `y=0` is the top row.

---

## Task C5: Plumb the async selector into `tantalum.js`

The Renderer construction currently runs synchronously inside `Tantalum.setupGL`. WebGPU is async. Hoist async setup into an external bootstrap.

**Files:**
- Modify: `src/tantalum.js` — split `Tantalum` constructor into sync UI setup + async backend setup.
- Modify: `src/bootstrap.js` — await an initializer.
- Modify: `src/main.js` — import `select.js` so Vite bundles it.
- Modify: `eslint.config.js` — allow `import.meta` etc. if needed (no change expected).

- [ ] **Step 1: Update `src/tantalum.js`**

Replace the current constructor body. Full replacement:

```javascript
var Tantalum = function () {
    this.canvas = document.getElementById("render-canvas");
    this.overlay = document.getElementById("render-overlay");
    this.content = document.getElementById("content");
    this.controls = document.getElementById("controls");
    this.spectrumCanvas = document.getElementById("spectrum-canvas");

    this.boundRenderLoop = this.renderLoop.bind(this);

    this.savedImages = 0;
    this._prewarmStarted = false;
    this._prewarmStartMs = 0;
    this._prewarmBudgetMs = 250;
};

Tantalum.prototype.init = async function () {
    try {
        await this.setupGL();
    } catch (e) {
        this.fail(e.message + ". This demo won't run in your browser.");
        return;
    }
    try {
        this.setupUI();
    } catch (e) {
        this.fail(
            "Ooops! Something unexpected happened. The error message is listed below:<br/>" +
                "<pre>" + e.message + "</pre>",
        );
        return;
    }

    this.controls.style.visibility = "visible";
    this.schedulePrewarm();
    window.requestAnimationFrame(this.boundRenderLoop);
};

Tantalum.prototype.setupGL = async function () {
    this.backend = await window.selectBackend(this.canvas);
    window.tantalumBackendKind = this.backend.caps.kind; // consumed by Playwright specs
};
```

*Keep the rest of the file unchanged except that `setupUI` and `renderLoop` already work against `this.backend`.*

- [ ] **Step 2: Update `src/bootstrap.js`**

Full replacement:

```javascript
window.addEventListener("DOMContentLoaded", function () {
    const t = new window.Tantalum();
    t.init();
});
```

- [ ] **Step 3: Update `src/main.js`**

Add the select import and expose globally. Full replacement:

```javascript
import "../ui.css";
import "./tantalum-gl.js";
import "./tantalum-shaders.js";
import "./spectrum.js";
import "./gasspectra.js";
import "./backend/webgl.js";
import { selectBackend } from "./backend/select.js";
import "./tantalum-core.js";
import "./tantalum-ui.js";
import "./download.js";
import "./tantalum.js";

window.selectBackend = selectBackend;

window.addEventListener("DOMContentLoaded", function () {
    const t = new window.Tantalum();
    t.init();
});
```

- [ ] **Step 4: Update `tantalum.html`**

Add a `<script type="module">` to expose `selectBackend` on `window` for the classic load path. Insert **before** `<script src="src/tantalum.js"></script>`:

```html
<script type="module">
  import { selectBackend } from "./src/backend/select.js";
  window.selectBackend = selectBackend;
</script>
```

The classic `bootstrap.js` runs on DOMContentLoaded which fires after deferred module scripts, so `window.selectBackend` is ready in time.

- [ ] **Step 5: Lint and build**

```bash
npm run lint && npm run build 2>&1 | tail -15
```

Expected: lint clean; build succeeds; bundle size grows slightly.

- [ ] **Step 6: End-to-end smoke**

```bash
npm run test:e2e
```

Expected: both smoke specs pass. WebGPU path returns a working backend when Chromium has WebGPU; otherwise it falls back to WebGL (still green).

- [ ] **Step 7: Commit Phase C skeleton**

```bash
git add src/backend/select.js src/backend/webgpu.js src/backend/wgsl-loader.js \
        shaders/wgsl/preamble.wgsl shaders/wgsl/compose.wgsl \
        src/tantalum.js src/bootstrap.js src/main.js tantalum.html
git commit -m "Add WebGPU backend skeleton with composite pass + async selector"
```

---

## Task C6: Prove the composite path end-to-end

WebGPU is now live enough that composite+clear work. Everything else still throws. If the Renderer's first call is `render()`, the page fails because `splatRays` isn't implemented. So gate Renderer construction on backend kind during the bring-up.

**Files:**
- Modify: `src/tantalum.js` (temporary short-circuit).

- [ ] **Step 1: Log the backend kind during dev**

At the top of `setupUI` in `src/tantalum.js`, add:

```javascript
    console.log("Tantalum backend:", this.backend.caps.kind);
```

- [ ] **Step 2: Manually verify in dev**

```bash
npm run dev &
sleep 3
curl -s http://127.0.0.1:5173/ > /dev/null
kill %1
```

Open `http://127.0.0.1:5173/` in Chromium. Expected:
- WebGL path: scene renders identically to pre-Phase-B.
- WebGPU path: console shows `Tantalum backend: webgpu`; the page will then throw in `render()` because splat isn't wired. **This is expected** and proves the selector is working. Close the tab.

- [ ] **Step 3: Commit the log**

```bash
git add src/tantalum.js
git commit -m "Log backend kind during setup for bring-up visibility"
```

---

# Phase D — WebGPU splat pipeline

The splat pass draws `raySize² * 2` line-list vertices, blending additively into the `rgba32float` wave buffer. It reads `stateA.posDir`, `stateB.posDir`, and `stateA.rgbLambda` from storage buffers. Storage buffers replace the three ray-state textures used on WebGL.

## Task D1: Define the WebGPU ray-state layout

**Files:**
- Modify: `src/backend/webgpu.js` — `createRayState` implementation.

Layout (matches the `Ray` struct in `shaders/wgsl/preamble.wgsl`): 3 × `vec4<f32>` per ray = 48 bytes.

- [ ] **Step 1: Replace the `createRayState` stub**

```javascript
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
```

*Note: both ping-pong slots get independently randomized rng state, matching WebGL `createRayState` which does the same. `posDir`/`rng`/`rgbLambda` channels are laid out interleaved via `struct Ray` in WGSL.*

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: pass.

---

## Task D2: Line VBO on WebGPU

**Files:**
- Modify: `src/backend/webgpu.js` — `createRayLineGeometry` implementation.

- [ ] **Step 1: Replace the stub**

```javascript
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
```

---

## Task D3: Write `shaders/wgsl/ray.wgsl`

GLSL reference: `shaders/glsl/ray-vert.txt` + `ray-frag.txt`.

**Files:**
- Create: `shaders/wgsl/ray.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"

struct SplatUniforms {
    aspect:  f32,
    raySize: u32,
    _pad0:   u32,
    _pad1:   u32,
}

@group(0) @binding(0) var<uniform> U: SplatUniforms;
@group(0) @binding(1) var<storage, read> stateA: array<Ray>;
@group(0) @binding(2) var<storage, read> stateB: array<Ray>;

struct VSOut {
    @builtin(position) pos:   vec4f,
    @location(0)       color: vec3f,
}

@vertex
fn vs(@location(0) uvz: vec3f) -> VSOut {
    let ix = u32(uvz.y * f32(U.raySize)) * U.raySize + u32(uvz.x * f32(U.raySize));
    let posA = stateA[ix].posDir.xy;
    let posB = stateB[ix].posDir.xy;
    let pos  = mix(posA, posB, uvz.z);
    let dir  = posB - posA;
    let bias = clamp(length(dir) / max(max(abs(dir.x), abs(dir.y)), 1e-30), 1.0, SQRT2);
    var out: VSOut;
    out.pos   = vec4f(pos.x / U.aspect, pos.y, 0.0, 1.0);
    out.color = stateA[ix].rgbLambda.rgb * bias;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    return vec4f(in.color, 1.0);
}
```

---

## Task D4: Build the splat pipeline

**Files:**
- Modify: `src/backend/webgpu.js`:
  - Add `ray.wgsl` to the imports and `wgsl` table.
  - Create a "splat" pipeline in `makeWebGPUBackend`.
  - Implement `frame.splatRays`.

- [ ] **Step 1: Import the module**

Near the top of `src/backend/webgpu.js`, add:

```javascript
import raySrc from "../../shaders/wgsl/ray.wgsl?raw";
```

And extend the `wgsl` table:

```javascript
    const wgsl = { preamble: preambleSrc, compose: composeSrc, ray: raySrc };
```

- [ ] **Step 2: Create the splat pipeline after the compose pipeline**

```javascript
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
```

- [ ] **Step 3: Implement `splatRays` in `beginFrame`**

Replace the `splatRays() { throw ... }` line with:

```javascript
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
```

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -10
```

Expected: build succeeds.

---

## Task D5: Write `shaders/wgsl/pass.wgsl` and implement `blit`

GLSL reference: `shaders/glsl/pass-frag.txt` (identity copy, used for wave → screen accumulation).

**Files:**
- Create: `shaders/wgsl/pass.wgsl`.
- Modify: `src/backend/webgpu.js` — add pass pipeline + `frame.blit`.

- [ ] **Step 1: Write `shaders/wgsl/pass.wgsl`**

```wgsl
@group(0) @binding(0) var frameTex: texture_2d<f32>;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0)       uv:  vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var uvs     = array<vec2f, 3>(vec2f( 0.0,  1.0), vec2f(2.0,  1.0), vec2f( 0.0, -1.0));
    var out: VSOut;
    out.pos = vec4f(corners[vi], 0.0, 1.0);
    out.uv  = uvs[vi];
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let dims = vec2f(textureDimensions(frameTex, 0));
    let rgb  = textureLoad(frameTex, vec2i(in.uv * dims), 0).rgb;
    return vec4f(rgb, 1.0);
}
```

- [ ] **Step 2: Import and register in `webgpu.js`**

Add to the import block:

```javascript
import passSrc from "../../shaders/wgsl/pass.wgsl?raw";
```

Extend `wgsl` table:

```javascript
    const wgsl = { preamble: preambleSrc, compose: composeSrc, ray: raySrc, pass: passSrc };
```

Add pass pipeline after the ray pipeline:

```javascript
    const passModule = loadShaderModule("pass");
    const passLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        ],
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
```

- [ ] **Step 3: Implement `blit` in `beginFrame`**

Replace the `blit() { throw ... }` line:

```javascript
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
```

Note: the pipeline always blends additively, so `loadOp: "load"` gives "additive blit" (the semantic the Renderer wants); `loadOp: "clear"` gives a fresh copy (not used today but available).

- [ ] **Step 4: Commit Phase D**

```bash
git add src/backend/webgpu.js shaders/wgsl/ray.wgsl shaders/wgsl/pass.wgsl
git commit -m "Add WebGPU splat + blit render passes"
```

---

## Task D6: Dev-only sanity check for splat (synthetic two-ray test)

**Files:**
- Create: `tests/e2e/webgpu-splat-synthetic.spec.js` (temporary — deleted in Task F5).

This spec runs only if the page reports WebGPU. It seeds the canvas with two rays via a `window.__tantalumDebug.seedTwoRays(...)` hook, then asserts the canvas has non-black pixels.

- [ ] **Step 1: Add the debug hook in `src/tantalum.js`**

After `this.renderer = new tcore.Renderer(...)` inside `setupUI`, add:

```javascript
    window.__tantalumDebug = {
        forceRender: () => this.renderer.render(performance.now()),
        backend: this.backend,
    };
```

- [ ] **Step 2: Write the spec**

```javascript
import { expect, test } from "@playwright/test";

test("webgpu: splat pass produces non-black pixels", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "WebGPU smoke only runs on Chromium");
    await page.goto("/");
    const kind = await page.evaluate(() => window.tantalumBackendKind);
    test.skip(kind !== "webgpu", "Browser does not advertise WebGPU");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    const label = page.locator(".progress-label").first();
    await expect(label).toHaveText(/\d+\/\d+ rays traced/, { timeout: 10_000 });
});
```

- [ ] **Step 3: Run**

```bash
npm run test:e2e
```

Expected: splat spec either passes or skips (depending on the CI image). WebGL smoke still passes.

*Do not commit — this is bring-up scaffolding; it's reworked into the final webgpu spec in Task F1.*

---

# Phase E — WebGPU compute shaders (init + trace + scenes)

Every WGSL module in this phase is one task. The translation rules:
- `inout X x` → `ptr<function, X>` parameter; `x` becomes `(*ptr)` reads/writes at the call site.
- `vec2/vec3/vec4` → `vec2f`/`vec3f`/`vec4f`.
- `sampler2D tex; texture(tex, uv)` → read directly from storage buffer or use `textureLoad(tex, ivec, 0)`.
- Tangent/normal math, clamp/mix/sign semantics are identical.

## Task E1: `shaders/wgsl/rand.wgsl`

GLSL reference: `shaders/glsl/rand.txt`.

**Files:**
- Create: `shaders/wgsl/rand.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
fn rand(state: ptr<function, vec4f>) -> f32 {
    let q = vec4f(1225.0, 1585.0, 2457.0, 2098.0);
    let r = vec4f(1112.0,  367.0,   92.0,  265.0);
    let a = vec4f(3423.0, 2646.0, 1707.0, 1999.0);
    let m = vec4f(4194287.0, 4194277.0, 4194191.0, 4194167.0);

    var beta = floor((*state) / q);
    let p = a * ((*state) - beta * q) - beta * r;
    beta = (vec4f(1.0) - sign(p)) * 0.5 * m;
    *state = p + beta;
    return fract(dot((*state) / m, vec4f(1.0, -1.0, 1.0, -1.0)));
}
```

---

## Task E2: `shaders/wgsl/bsdf.wgsl` (material sampling)

GLSL reference: `shaders/glsl/bsdf.txt`.

**Files:**
- Create: `shaders/wgsl/bsdf.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
fn sellmeierIor(b: vec3f, c: vec3f, lambda: f32) -> f32 {
    let lSq = (lambda * 1e-3) * (lambda * 1e-3);
    return 1.0 + dot((b * lSq) / (lSq - c), vec3f(1.0));
}

fn tanhApprox(x: f32) -> f32 {
    if (abs(x) > 10.0) { return sign(x); }
    let e = exp(-2.0 * x);
    return (1.0 - e) / (1.0 + e);
}
fn atanhApprox(x: f32) -> f32 {
    return 0.5 * log((1.0 + x) / (1.0 - x));
}

fn dielectricReflectance(eta: f32, cosThetaI: f32, cosThetaT: ptr<function, f32>) -> f32 {
    let sinThetaTSq = eta * eta * (1.0 - cosThetaI * cosThetaI);
    if (sinThetaTSq > 1.0) {
        *cosThetaT = 0.0;
        return 1.0;
    }
    *cosThetaT = sqrt(1.0 - sinThetaTSq);
    let Rs = (eta * cosThetaI - *cosThetaT) / (eta * cosThetaI + *cosThetaT);
    let Rp = (eta * *cosThetaT - cosThetaI) / (eta * *cosThetaT + cosThetaI);
    return (Rs * Rs + Rp * Rp) * 0.5;
}

fn sampleDiffuse(state: ptr<function, vec4f>, wi: vec2f) -> vec2f {
    let x = rand(state) * 2.0 - 1.0;
    let y = sqrt(1.0 - x * x);
    return vec2f(x, y * sign(wi.y));
}

fn sampleMirror(wi: vec2f) -> vec2f {
    return vec2f(-wi.x, wi.y);
}

fn sampleDielectric(state: ptr<function, vec4f>, wi: vec2f, ior: f32) -> vec2f {
    var cosThetaT: f32 = 0.0;
    let eta = select(1.0 / ior, ior, wi.y < 0.0);
    let Fr  = dielectricReflectance(eta, abs(wi.y), &cosThetaT);
    if (rand(state) < Fr) {
        return vec2f(-wi.x, wi.y);
    }
    return vec2f(-wi.x * eta, -cosThetaT * sign(wi.y));
}

fn sampleVisibleNormal(sigma: f32, xi: f32, theta0: f32, theta1: f32) -> f32 {
    let sigmaSq    = sigma * sigma;
    let invSigmaSq = 1.0 / sigmaSq;
    let cdf0 = tanhApprox(theta0 * 0.5 * invSigmaSq);
    let cdf1 = tanhApprox(theta1 * 0.5 * invSigmaSq);
    return 2.0 * sigmaSq * atanhApprox(cdf0 + (cdf1 - cdf0) * xi);
}

fn sampleRoughMirror(
    state: ptr<function, vec4f>,
    wi: vec2f,
    throughput: ptr<function, vec3f>,
    sigma: f32,
) -> vec2f {
    let theta  = asin(clamp(wi.x, -1.0, 1.0));
    let theta0 = max(theta - PI_HALF, -PI_HALF);
    let theta1 = min(theta + PI_HALF,  PI_HALF);
    let thetaM = sampleVisibleNormal(sigma, rand(state), theta0, theta1);
    let m  = vec2f(sin(thetaM), cos(thetaM));
    let wo = m * (dot(wi, m) * 2.0) - wi;
    if (wo.y < 0.0) { *throughput = vec3f(0.0); }
    return wo;
}

fn sampleRoughDielectric(
    state: ptr<function, vec4f>,
    wi: vec2f,
    sigma: f32,
    ior: f32,
) -> vec2f {
    let theta  = asin(min(abs(wi.x), 1.0));
    let theta0 = max(theta - PI_HALF, -PI_HALF);
    let theta1 = min(theta + PI_HALF,  PI_HALF);
    let thetaM = sampleVisibleNormal(sigma, rand(state), theta0, theta1);
    let m = vec2f(sin(thetaM), cos(thetaM));
    let wiDotM = dot(wi, m);
    var cosThetaT: f32 = 0.0;
    let etaM = select(1.0 / ior, ior, wiDotM < 0.0);
    let F = dielectricReflectance(etaM, abs(wiDotM), &cosThetaT);
    if (wiDotM < 0.0) { cosThetaT = -cosThetaT; }
    if (rand(state) < F) {
        return 2.0 * wiDotM * m - wi;
    }
    return (etaM * wiDotM - cosThetaT) * m - etaM * wi;
}
```

---

## Task E3: `shaders/wgsl/intersect.wgsl`

GLSL reference: `shaders/glsl/intersect.txt`.

**Files:**
- Create: `shaders/wgsl/intersect.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
struct RayAux {
    pos:     vec2f,
    dir:     vec2f,
    invDir:  vec2f,
    dirSign: vec2f,
}

fn unpackRay(posDir: vec4f) -> RayAux {
    var dir = posDir.zw;
    if (abs(dir.x) < 1e-5) { dir.x = 1e-5; }
    if (abs(dir.y) < 1e-5) { dir.y = 1e-5; }
    let d = normalize(dir);
    return RayAux(posDir.xy, d, vec2f(1.0) / dir, sign(dir));
}

fn bboxIntersect(ray: RayAux, center: vec2f, radius: vec2f, matId: f32, isect: ptr<function, Intersection>) {
    let pos = ray.pos - center;
    let tx1 = (-radius.x - pos.x) * ray.invDir.x;
    let tx2 = ( radius.x - pos.x) * ray.invDir.x;
    let ty1 = (-radius.y - pos.y) * ray.invDir.y;
    let ty2 = ( radius.y - pos.y) * ray.invDir.y;

    let minX = min(tx1, tx2); let maxX = max(tx1, tx2);
    let minY = min(ty1, ty2); let maxY = max(ty1, ty2);

    let tmin = max((*isect).tMin, max(minX, minY));
    let tmax = min((*isect).tMax, min(maxX, maxY));

    if (tmax >= tmin) {
        let t  = select(tmin, tmax, tmin == (*isect).tMin);
        (*isect).tMax = t;
        if (t == tx1)      { (*isect).n = vec2f(-1.0,  0.0); }
        else if (t == tx2) { (*isect).n = vec2f( 1.0,  0.0); }
        else               { (*isect).n = vec2f( 0.0,  1.0); }
        (*isect).mat = matId;
    }
}

fn sphereIntersect(ray: RayAux, center: vec2f, radius: f32, matId: f32, isect: ptr<function, Intersection>) {
    let p = ray.pos - center;
    let B = dot(p, ray.dir);
    let C = dot(p, p) - radius * radius;
    let detSq = B * B - C;
    if (detSq < 0.0) { return; }
    let det = sqrt(detSq);
    var t = -B - det;
    if (t <= (*isect).tMin || t >= (*isect).tMax) { t = -B + det; }
    if (t > (*isect).tMin && t < (*isect).tMax) {
        (*isect).tMax = t;
        (*isect).n    = normalize(p + ray.dir * t);
        (*isect).mat  = matId;
    }
}

fn lineIntersect(ray: RayAux, a: vec2f, b: vec2f, matId: f32, isect: ptr<function, Intersection>) {
    let sT = b - a;
    let sN = vec2f(-sT.y, sT.x);
    let t = dot(sN, a - ray.pos) / dot(sN, ray.dir);
    let u = dot(sT, ray.pos + ray.dir * t - a);
    if (t < (*isect).tMin || t >= (*isect).tMax || u < 0.0 || u > dot(sT, sT)) { return; }
    (*isect).tMax = t;
    (*isect).n    = normalize(sN);
    (*isect).mat  = matId;
}

fn prismIntersect(ray: RayAux, center: vec2f, radius: f32, matId: f32, isect: ptr<function, Intersection>) {
    lineIntersect(ray, center + vec2f( 0.0,   1.0) * radius, center + vec2f( 0.866, -0.5) * radius, matId, isect);
    lineIntersect(ray, center + vec2f( 0.866,-0.5) * radius, center + vec2f(-0.866, -0.5) * radius, matId, isect);
    lineIntersect(ray, center + vec2f(-0.866,-0.5) * radius, center + vec2f( 0.0,    1.0) * radius, matId, isect);
}
```

---

## Task E4: `shaders/wgsl/csg.wgsl`

GLSL reference: `shaders/glsl/csg-intersect.txt`.

**Files:**
- Create: `shaders/wgsl/csg.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
struct Segment {
    tNear: f32,
    tFar:  f32,
    nNear: vec2f,
    nFar:  vec2f,
}

fn segmentIntersection(a: Segment, b: Segment) -> Segment {
    return Segment(
        max(a.tNear, b.tNear),
        min(a.tFar,  b.tFar),
        select(b.nNear, a.nNear, a.tNear > b.tNear),
        select(a.nFar,  b.nFar,  a.tFar  < b.tFar),
    );
}

fn segmentSubtraction(a: Segment, b: Segment, tMin: f32) -> Segment {
    if (a.tNear >= a.tFar || b.tNear >= b.tFar || a.tFar <= b.tNear || a.tNear >= b.tFar) {
        return a;
    }
    let s1 = Segment(a.tNear, b.tNear, a.nNear, -b.nNear);
    let s2 = Segment(b.tFar,  a.tFar, -b.nFar,   a.nFar);
    let valid1 = s1.tNear <= s1.tFar;
    let valid2 = s2.tNear <= s2.tFar;
    if (valid1 && valid2) {
        if (s1.tFar >= tMin) { return s1; } else { return s2; }
    }
    if (valid1) { return s1; }
    return s2;
}

fn segmentCollapse(segIn: Segment, matId: f32, isect: ptr<function, Intersection>) {
    var seg = segIn;
    seg.tNear = max(seg.tNear, (*isect).tMin);
    seg.tFar  = min(seg.tFar,  (*isect).tMax);
    if (seg.tNear <= seg.tFar) {
        if (seg.tNear > (*isect).tMin) {
            (*isect).tMax = seg.tNear;
            (*isect).n    = seg.nNear;
            (*isect).mat  = matId;
        } else if (seg.tFar < (*isect).tMax) {
            (*isect).tMax = seg.tFar;
            (*isect).n    = seg.nFar;
            (*isect).mat  = matId;
        }
    }
}

fn horzSpanIntersect(ray: RayAux, y: f32, radius: f32) -> Segment {
    let dc = (y - ray.pos.y) * ray.invDir.y;
    let dt = ray.dirSign.y * radius * ray.invDir.y;
    return Segment(dc - dt, dc + dt, vec2f(0.0, -ray.dirSign.y), vec2f(0.0, ray.dirSign.y));
}
fn vertSpanIntersect(ray: RayAux, x: f32, radius: f32) -> Segment {
    let dc = (x - ray.pos.x) * ray.invDir.x;
    let dt = ray.dirSign.x * radius * ray.invDir.x;
    return Segment(dc - dt, dc + dt, vec2f(-ray.dirSign.x, 0.0), vec2f(ray.dirSign.x, 0.0));
}
fn boxSegmentIntersect(ray: RayAux, center: vec2f, radius: vec2f) -> Segment {
    return segmentIntersection(
        horzSpanIntersect(ray, center.y, radius.y),
        vertSpanIntersect(ray, center.x, radius.x),
    );
}
fn sphereSegmentIntersect(ray: RayAux, center: vec2f, radius: f32) -> Segment {
    var out = Segment(1e30, -1e30, vec2f(0.0), vec2f(0.0));
    let p = ray.pos - center;
    let B = dot(p, ray.dir);
    let C = dot(p, p) - radius * radius;
    let detSq = B * B - C;
    if (detSq >= 0.0) {
        let det = sqrt(detSq);
        out.tNear = -B - det;
        out.tFar  = -B + det;
        out.nNear = (p + ray.dir * out.tNear) * (1.0 / radius);
        out.nFar  = (p + ray.dir * out.tFar)  * (1.0 / radius);
    }
    return out;
}

fn biconvexLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r1: f32, r2: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentIntersection(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        sphereSegmentIntersect(ray, center + vec2f(r1 - d, 0.0), r1)),
        sphereSegmentIntersect(ray, center - vec2f(r2 - d, 0.0), r2),
    ), matId, isect);
}
fn biconcaveLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r1: f32, r2: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentSubtraction(segmentSubtraction(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        vertSpanIntersect(ray, center.x + 0.5 * (r2 - r1), 0.5 * (abs(r1) + abs(r2)) + d)),
        sphereSegmentIntersect(ray, center + vec2f(r2 + d, 0.0), r2), (*isect).tMin),
        sphereSegmentIntersect(ray, center - vec2f(r1 + d, 0.0), r1), (*isect).tMin,
    ), matId, isect);
}
fn meniscusLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r1: f32, r2: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentSubtraction(segmentIntersection(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        vertSpanIntersect(ray, center.x + 0.5 * r2, 0.5 * abs(r2) + d)),
        sphereSegmentIntersect(ray, center + vec2f(r1 - sign(r1) * d, 0.0), abs(r1))),
        sphereSegmentIntersect(ray, center + vec2f(r2 + sign(r2) * d, 0.0), abs(r2)), (*isect).tMin,
    ), matId, isect);
}
fn planoConvexLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentIntersection(
        boxSegmentIntersect(ray, center, vec2f(d, h)),
        sphereSegmentIntersect(ray, center + vec2f(r - d, 0.0), abs(r)),
    ), matId, isect);
}
fn planoConcaveLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentSubtraction(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        vertSpanIntersect(ray, center.x - 0.5 * r, 0.5 * abs(r) + d)),
        sphereSegmentIntersect(ray, center - vec2f(r + d, 0.0), abs(r)), (*isect).tMin,
    ), matId, isect);
}
```

---

## Task E5: `shaders/wgsl/init.wgsl`

GLSL reference: `shaders/glsl/init-frag.txt`.

**Files:**
- Create: `shaders/wgsl/init.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"

struct InitUniforms {
    emitterPos:    vec2f,
    emitterDir:    vec2f,
    angularSpread: vec2f,
    spatialSpread: f32,
    emitterPower:  f32,
    raySize:       u32,
    activeRows:    u32,
}

@group(0) @binding(0) var<uniform> U: InitUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;
@group(0) @binding(3) var spectrumTex: texture_2d<f32>;
@group(0) @binding(4) var emissionTex: texture_2d<f32>;
@group(0) @binding(5) var icdfTex:     texture_2d<f32>;
@group(0) @binding(6) var pdfTex:      texture_2d<f32>;
@group(0) @binding(7) var linearSmp:   sampler;

fn sample1D(tex: texture_2d<f32>, smp: sampler, u: f32) -> vec4f {
    return textureSampleLevel(tex, smp, vec2f(u, 0.5), 0.0);
}

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;

    var state = stateIn[ix].rng;

    let theta = U.angularSpread.x + (rand(&state) - 0.5) * U.angularSpread.y;
    let dir   = vec2f(cos(theta), sin(theta));
    let pos   = U.emitterPos
              + (rand(&state) - 0.5) * U.spatialSpread * vec2f(-U.emitterDir.y, U.emitterDir.x);

    let randL          = rand(&state);
    let spectrumOffset = sample1D(icdfTex, linearSmp, randL).r + rand(&state) * (1.0 / 256.0);
    let lambda = 360.0 + (750.0 - 360.0) * spectrumOffset;
    let rgb = U.emitterPower
            * sample1D(emissionTex, linearSmp, spectrumOffset).r
            * sample1D(spectrumTex, linearSmp, spectrumOffset).rgb
            / sample1D(pdfTex,      linearSmp, spectrumOffset).r;

    stateOut[ix] = Ray(vec4f(pos, dir), state, vec4f(rgb, lambda));
}
```

---

## Task E6: `shaders/wgsl/trace.wgsl`

GLSL reference: `shaders/glsl/trace-frag.txt`.

**Files:**
- Create: `shaders/wgsl/trace.wgsl`.

- [ ] **Step 1: Write it**

The trace shader doesn't define `intersect`/`sampleBsdf` — each scene module does. Scene modules `#include "trace"` + the helpers they need, then define the two hooks.

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms {
    raySize:    u32,
    activeRows: u32,
    _pad0:      u32,
    _pad1:      u32,
}

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>);
fn sampleBsdf(state: ptr<function, vec4f>, isect: Intersection, lambda: f32, wiLocal: vec2f, throughput: ptr<function, vec3f>) -> vec2f;

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;

    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;

    let ray = unpackRay(posDir);
    var isect: Intersection;
    isect.tMin = 1e-4;
    isect.tMax = 1e30;
    intersectScene(ray, &isect);

    let t = vec2f(-isect.n.y, isect.n.x);
    let wiLocal = -vec2f(dot(t, ray.dir), dot(isect.n, ray.dir));
    var throughput = rgbLambda.rgb;
    let woLocal = sampleBsdf(&state, isect, rgbLambda.w, wiLocal, &throughput);
    rgbLambda = vec4f(throughput, rgbLambda.w);

    if (isect.tMax == 1e30) {
        rgbLambda.r = 0.0;
        rgbLambda.g = 0.0;
        rgbLambda.b = 0.0;
    } else {
        posDir = vec4f(ray.pos + ray.dir * isect.tMax,
                       woLocal.y * isect.n + woLocal.x * t);
    }

    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

Note: WGSL doesn't support forward-declared function *definitions* spanning modules the way GLSL's `void intersect(Ray, inout Intersection);` does. Instead, scene modules **prepend** trace.wgsl inverted: scene defines `intersectScene` and `sampleBsdf`, then `#include`s trace's body below. Task E7 shows the pattern.

Actually, simpler: make trace.wgsl a pure helper file and let each scene module be the entry point. Tasks E7–E13 follow that structure; amend this file accordingly:

Replace the `@compute` entry point above with:

```wgsl
fn traceStep(
    state: ptr<function, vec4f>,
    posDir: ptr<function, vec4f>,
    rgbLambda: ptr<function, vec4f>,
) {
    let ray = unpackRay(*posDir);
    var isect: Intersection;
    isect.tMin = 1e-4;
    isect.tMax = 1e30;
    intersectScene(ray, &isect);

    let t = vec2f(-isect.n.y, isect.n.x);
    let wiLocal = -vec2f(dot(t, ray.dir), dot(isect.n, ray.dir));
    var throughput = (*rgbLambda).rgb;
    let woLocal = sampleBsdf(state, isect, (*rgbLambda).w, wiLocal, &throughput);
    *rgbLambda = vec4f(throughput, (*rgbLambda).w);

    if (isect.tMax == 1e30) {
        (*rgbLambda) = vec4f(0.0, 0.0, 0.0, (*rgbLambda).w);
    } else {
        *posDir = vec4f(ray.pos + ray.dir * isect.tMax,
                        woLocal.y * isect.n + woLocal.x * t);
    }
}
```

Remove the `@compute` entry and the `U`/`stateIn`/`stateOut` bindings from this file — move them into each scene file (Task E7).

---

## Task E7: Write `shaders/wgsl/scene1.wgsl` (lenses) as the entry-point template

GLSL reference: `shaders/glsl/scene1.txt`.

All scenes follow this template: `#include` preamble/rand/bsdf/intersect/csg/trace, define `intersectScene` + `sampleBsdf`, declare compute bindings, declare entry point that calls `traceStep`.

**Files:**
- Create: `shaders/wgsl/scene1.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms {
    raySize:    u32,
    activeRows: u32,
    _pad0:      u32,
    _pad1:      u32,
}

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect            (ray, vec2f(0.0),         vec2f(1.78, 1.0),         0.0, isect);
    biconvexLensIntersect    (ray, vec2f(-0.4,  0.0),  0.375, 0.15,   0.75, 0.75, 1.0, isect);
    biconcaveLensIntersect   (ray, vec2f( 0.4,  0.0),  0.375, 0.0375, 0.75, 0.75, 1.0, isect);
    planoConvexLensIntersect (ray, vec2f(-1.2,  0.0),  0.375, 0.075,  0.75,       1.0, isect);
    meniscusLensIntersect    (ray, vec2f( 0.8,  0.0),  0.375, 0.15,   0.45, 0.75, 1.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) {
        let ior = sellmeierIor(vec3f(1.6215, 0.2563, 1.6445), vec3f(0.0122, 0.0596, 147.4688), lambda) / 1.4;
        return sampleDielectric(state, wiLocal, ior);
    }
    *throughput = (*throughput) * vec3f(0.5);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;

    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;

    traceStep(&state, &posDir, &rgbLambda);

    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

---

## Task E8: `shaders/wgsl/scene2.wgsl` (rough mirror spheres)

GLSL reference: `shaders/glsl/scene2.txt`.

**Files:**
- Create: `shaders/wgsl/scene2.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect   (ray, vec2f(0.0),              vec2f(1.78, 1.0),  0.0, isect);
    sphereIntersect (ray, vec2f(-1.424, -0.8),     0.356,             1.0, isect);
    sphereIntersect (ray, vec2f(-0.72,  -0.8),     0.356,             2.0, isect);
    sphereIntersect (ray, vec2f( 0.0,   -0.8),     0.356,             3.0, isect);
    sphereIntersect (ray, vec2f( 0.72,  -0.8),     0.356,             4.0, isect);
    sphereIntersect (ray, vec2f( 1.424, -0.8),     0.356,             5.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.02); }
    if (isect.mat == 2.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.05); }
    if (isect.mat == 3.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.1);  }
    if (isect.mat == 4.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.2);  }
    if (isect.mat == 5.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.5);  }
    *throughput = (*throughput) * vec3f(0.5);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;
    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;
    traceStep(&state, &posDir, &rgbLambda);
    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

---

## Task E9: `shaders/wgsl/scene3.wgsl` (Cornell box)

GLSL reference: `shaders/glsl/scene3.txt`.

**Files:**
- Create: `shaders/wgsl/scene3.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect  (ray, vec2f(0.0),          vec2f(1.78, 1.0),  0.0, isect);
    bboxIntersect  (ray, vec2f(0.0),          vec2f(1.2,  0.8),  1.0, isect);
    sphereIntersect(ray, vec2f(-0.7, -0.45),  0.35,              3.0, isect);
    sphereIntersect(ray, vec2f( 0.7, -0.45),  0.35,              2.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 2.0) {
        let ior = sellmeierIor(vec3f(1.6215, 0.2563, 1.6445), vec3f(0.0122, 0.0596, 147.4688), lambda) / 1.4;
        return sampleDielectric(state, wiLocal, ior);
    }
    if (isect.mat == 3.0) {
        return sampleMirror(wiLocal);
    }
    if (isect.mat == 1.0) {
        if      (isect.n.x == -1.0) { *throughput = (*throughput) * vec3f(0.14,  0.45,  0.091); }
        else if (isect.n.x ==  1.0) { *throughput = (*throughput) * vec3f(0.63,  0.065, 0.05);  }
        else                        { *throughput = (*throughput) * vec3f(0.725, 0.71,  0.68);  }
        return sampleDiffuse(state, wiLocal);
    }
    *throughput = (*throughput) * vec3f(0.5);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;
    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;
    traceStep(&state, &posDir, &rgbLambda);
    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

---

## Task E10: `shaders/wgsl/scene4.wgsl` (prism)

GLSL reference: `shaders/glsl/scene4.txt`.

**Files:**
- Create: `shaders/wgsl/scene4.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect (ray, vec2f(0.0),        vec2f(1.78, 1.0), 0.0, isect);
    prismIntersect(ray, vec2f(0.0, 0.0),   0.6,              1.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) {
        let ior = sellmeierIor(vec3f(1.6215, 0.2563, 1.6445), vec3f(0.0122, 0.0596, 17.4688), lambda) / 1.8;
        return sampleRoughDielectric(state, wiLocal, 0.1, ior);
    }
    *throughput = (*throughput) * vec3f(0.05);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;
    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;
    traceStep(&state, &posDir, &rgbLambda);
    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

---

## Task E11: `shaders/wgsl/scene5.wgsl` (cardioid)

GLSL reference: `shaders/glsl/scene5.txt`.

**Files:**
- Create: `shaders/wgsl/scene5.wgsl`.
- Delete: `shaders/wgsl/hello.wgsl` (no longer needed).

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect           (ray, vec2f(0.0),        vec2f(1.78, 1.0), 0.0, isect);
    planoConcaveLensIntersect(ray, vec2f(0.8, 0.0),  0.6, 0.3, 0.6,    1.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) { return sampleMirror(wiLocal); }
    *throughput = (*throughput) * vec3f(0.5);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;
    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;
    traceStep(&state, &posDir, &rgbLambda);
    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

- [ ] **Step 2: Delete the placeholder**

```bash
rm shaders/wgsl/hello.wgsl
```

---

## Task E12: `shaders/wgsl/scene6.wgsl` (spheres)

GLSL reference: `shaders/glsl/scene6.txt`.

**Files:**
- Create: `shaders/wgsl/scene6.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect  (ray, vec2f(0.0),                vec2f(1.78, 1.0),                         0.0, isect);
    sphereIntersect(ray, vec2f(-0.95,   0.25),      0.4,                                      1.0, isect);
    sphereIntersect(ray, vec2f(-0.15,  -0.25),      0.2,                                      1.0, isect);
    sphereIntersect(ray, vec2f( 1.11667, 0.18333),  0.2,                                      1.0, isect);
    lineIntersect  (ray, vec2f( 0.168689, -0.885424), vec2f(1.13131,  -0.614576),             2.0, isect);
    lineIntersect  (ray, vec2f( 1.71686,   0.310275), vec2f(0.983139,  0.989725),             2.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) {
        let ior = sqrt(sellmeierIor(vec3f(1.0396, 0.2318, 1.0105), vec3f(0.0060, 0.0200, 103.56), lambda));
        return sampleDielectric(state, wiLocal, ior);
    }
    if (isect.mat == 2.0) {
        return sampleMirror(wiLocal);
    }
    *throughput = (*throughput) * vec3f(0.5);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;
    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;
    traceStep(&state, &posDir, &rgbLambda);
    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

---

## Task E13: `shaders/wgsl/scene7.wgsl` (playground)

GLSL reference: `shaders/glsl/scene7.txt`.

**Files:**
- Create: `shaders/wgsl/scene7.wgsl`.

- [ ] **Step 1: Write it**

```wgsl
#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       stateIn:  array<Ray>;
@group(0) @binding(2) var<storage, read_write> stateOut: array<Ray>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect              (ray, vec2f(0.0),              vec2f(1.78, 1.0),                 0.0, isect);
    sphereIntersect            (ray, vec2f(0.0, 0.0),         0.4,                              1.0, isect);
    biconvexLensIntersect      (ray, vec2f(-0.4, -0.65),      0.3, 0.12,  0.5,  0.5,            1.0, isect);
    meniscusLensIntersect      (ray, vec2f(-0.8, -0.65),      0.3, 0.08, -0.5, -0.5,            1.0, isect);
    planoConcaveLensIntersect  (ray, vec2f(1.3, 0.0),         0.3, 0.0,   0.3,                  2.0, isect);
    prismIntersect             (ray, vec2f(0.8, -0.7),        0.2,                              1.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) {
        let ior = sellmeierIor(vec3f(1.6215, 0.2563, 1.6445), vec3f(0.0122, 0.0596, 147.4688), lambda) / 1.6;
        return sampleDielectric(state, wiLocal, ior);
    }
    if (isect.mat == 2.0) {
        return sampleMirror(wiLocal);
    }
    *throughput = (*throughput) * vec3f(0.25);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;
    var posDir    = stateIn[ix].posDir;
    var state     = stateIn[ix].rng;
    var rgbLambda = stateIn[ix].rgbLambda;
    traceStep(&state, &posDir, &rgbLambda);
    stateOut[ix] = Ray(posDir, state, rgbLambda);
}
```

---

## Task E14: Wire `uploadSpectrumResources` (r32float × 4 + linear sampler)

**Files:**
- Modify: `src/backend/webgpu.js` — `uploadSpectrumResources` implementation.

- [ ] **Step 1: Add a helper inside `makeWebGPUBackend`**

Near the top of `makeWebGPUBackend` (after `const wgsl = { ... }` line):

```javascript
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
```

Note: `bytesPerRow` must be ≥256 per WebGPU spec; for small 1D tables that means the row is padded, but `writeTexture` copies `width * bytesPerPixel` bytes from source regardless, and the padding bytes are unread.

- [ ] **Step 2: Replace `uploadSpectrumResources` stub**

```javascript
    function uploadSpectrumResources(spec) {
        const spectrum = make1DFloatTexture(spec.spectrum, 4);
        const emission = make1DFloatTexture(spec.emission, 1);
        const icdf     = make1DFloatTexture(spec.icdf,     1);
        const pdf      = make1DFloatTexture(spec.pdf,      1);
        function rewrite(handle, data) {
            device.queue.writeTexture(
                { texture: handle.texture },
                data.buffer,
                { bytesPerRow: Math.max(256, handle.width * handle.channels * 4) },
                { width: handle.width, height: 1 },
            );
        }
        return {
            spectrum, emission, icdf, pdf,
            sampler: linearSampler,
            updateEmission: (data) => rewrite(emission, data),
            updateIcdf:     (data) => rewrite(icdf,     data),
            updatePdf:      (data) => rewrite(pdf,      data),
        };
    }
```

---

## Task E15: Wire init + trace pipelines, implement `loadProgram` and `updateRayState`

**Files:**
- Modify: `src/backend/webgpu.js`.

- [ ] **Step 1: Import init + scene modules**

Near the import block:

```javascript
import initSrc   from "../../shaders/wgsl/init.wgsl?raw";
import traceSrc  from "../../shaders/wgsl/trace.wgsl?raw";
import bsdfSrc   from "../../shaders/wgsl/bsdf.wgsl?raw";
import randSrc   from "../../shaders/wgsl/rand.wgsl?raw";
import intersectSrc from "../../shaders/wgsl/intersect.wgsl?raw";
import csgSrc    from "../../shaders/wgsl/csg.wgsl?raw";
import scene1Src from "../../shaders/wgsl/scene1.wgsl?raw";
import scene2Src from "../../shaders/wgsl/scene2.wgsl?raw";
import scene3Src from "../../shaders/wgsl/scene3.wgsl?raw";
import scene4Src from "../../shaders/wgsl/scene4.wgsl?raw";
import scene5Src from "../../shaders/wgsl/scene5.wgsl?raw";
import scene6Src from "../../shaders/wgsl/scene6.wgsl?raw";
import scene7Src from "../../shaders/wgsl/scene7.wgsl?raw";
```

- [ ] **Step 2: Extend the `wgsl` table**

```javascript
    const wgsl = {
        preamble: preambleSrc, rand: randSrc, bsdf: bsdfSrc,
        intersect: intersectSrc, csg: csgSrc, trace: traceSrc,
        compose: composeSrc, pass: passSrc, ray: raySrc,
        init: initSrc,
        scene1: scene1Src, scene2: scene2Src, scene3: scene3Src,
        scene4: scene4Src, scene5: scene5Src, scene6: scene6Src, scene7: scene7Src,
    };
```

- [ ] **Step 3: Build init pipeline after the other render pipelines**

```javascript
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
```

- [ ] **Step 4: Build one trace pipeline per scene**

```javascript
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
```

- [ ] **Step 5: Update `loadProgram` to handle trace scene names**

Replace the body:

```javascript
    function loadProgram(kind, name) {
        const key = kind === "trace" ? `trace:${name}` : kind;
        const p = programs.get(key);
        if (!p) throw new Error(`WebGPU: program ${kind}/${name} not wired`);
        return p;
    }
```

- [ ] **Step 6: Implement `frame.updateRayState`**

Replace the throwing stub:

```javascript
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
                    f[0] = uniforms.EmitterPos[0];     f[1] = uniforms.EmitterPos[1];
                    f[2] = uniforms.EmitterDir[0];     f[3] = uniforms.EmitterDir[1];
                    f[4] = uniforms.AngularSpread[0];  f[5] = uniforms.AngularSpread[1];
                    f[6] = uniforms.SpatialSpread;     f[7] = uniforms.EmitterPower;
                    i[8] = raySize;                    i[9] = activeRows;
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
```

- [ ] **Step 7: Fix the spectrum handle shape to match Renderer expectations**

The Renderer does `textureBindings: { Spectrum: this.spectrumResources.spectrum, ... }`. Both WebGL and WebGPU expose `spectrumResources.spectrum`/`emission`/`icdf`/`pdf`. WebGL's handle is a `tgl.Texture` with `.bind`/`.copy`; WebGPU's is `{ texture, view, width, channels }`. The call path above reaches into `.view` — matching the WebGPU shape. WebGL already reads these via `tgl`'s `uniformTexture(name, tex)` which accepts the tgl handle. ✔

- [ ] **Step 8: Lint + build**

```bash
npm run lint && npm run build 2>&1 | tail -10
```

Expected: both clean.

- [ ] **Step 9: Commit Phase E**

```bash
git add src/backend/webgpu.js shaders/wgsl
git commit -m "Add WebGPU compute shaders (init + trace) and scene pipelines"
```

---

## Task E16: Remove the temporary bring-up log

**Files:**
- Modify: `src/tantalum.js`.

- [ ] **Step 1: Remove the `console.log("Tantalum backend:", ...)` line from `setupUI`.**

- [ ] **Step 2: Verify**

```bash
npm run lint && npm run test:e2e
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/tantalum.js
git commit -m "Drop bring-up backend log"
```

---

# Phase F — Verification

## Task F1: Playwright WebGPU spec

**Files:**
- Modify: `tests/e2e/smoke.spec.js` — split into two files.
- Create: `tests/e2e/webgpu-smoke.spec.js`.
- Modify: `playwright.config.js` — register Chromium launch flags for the WebGPU spec.

- [ ] **Step 1: Check the current Playwright config**

```bash
cat playwright.config.js
```

- [ ] **Step 2: Add a WebGPU project in `playwright.config.js`**

Wrap the existing config so both projects run. Example (adapt to whatever shape playwright.config.js currently has):

```javascript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "tests/e2e",
    webServer: {
        command: "npm run dev",
        url: "http://127.0.0.1:5173/",
        reuseExistingServer: !process.env.CI,
    },
    use: { baseURL: "http://127.0.0.1:5173/" },
    projects: [
        {
            name: "webgl",
            testMatch: /smoke\.spec\.js$/,
            use: {
                ...devices["Desktop Chrome"],
                launchOptions: { args: ["--disable-features=WebGPU"] },
            },
        },
        {
            name: "webgpu",
            testMatch: /webgpu-smoke\.spec\.js$/,
            use: {
                ...devices["Desktop Chrome"],
                launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] },
            },
        },
    ],
});
```

- [ ] **Step 3: Create `tests/e2e/webgpu-smoke.spec.js`**

```javascript
import { expect, test } from "@playwright/test";

test("webgpu path renders rays", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".warning-box")).toHaveCount(0, { timeout: 15_000 });

    const kind = await page.evaluate(async () => {
        while (!window.tantalumBackendKind) await new Promise((r) => setTimeout(r, 50));
        return window.tantalumBackendKind;
    });
    test.skip(kind !== "webgpu", `Browser selected ${kind}, skipping WebGPU assertions`);

    const label = page.locator(".progress-label").first();
    await expect(label).toHaveText(/\d+\/\d+ rays traced/, { timeout: 15_000 });
    const match = (await label.textContent()).match(/^(\d+)\/(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Delete the temporary Task D6 spec if it still exists**

```bash
rm -f tests/e2e/webgpu-splat-synthetic.spec.js
```

- [ ] **Step 5: Run**

```bash
npm run test:e2e
```

Expected: both projects run. On a Linux runner without Vulkan, the WebGPU spec skips.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.js tests/e2e
git commit -m "Split Playwright into WebGL + WebGPU projects"
```

---

## Task F2: CI — run both Playwright projects

**Files:**
- Modify: `.github/workflows/ci.yml`.

- [ ] **Step 1: Update the e2e step**

Replace the `End-to-end smoke` step with:

```yaml
            - name: End-to-end smoke (WebGL + WebGPU)
              run: npx playwright test
              env:
                  CI: true
```

(`npm run test:e2e` already runs `playwright test`; making it explicit matches the project-aware config.)

- [ ] **Step 2: Optional — install Mesa Vulkan drivers for WebGPU**

Insert before `Install Playwright browser`:

```yaml
            - name: Install Mesa drivers for WebGPU
              run: sudo apt-get install -y mesa-vulkan-drivers libnss3
```

If the runner can't do Vulkan, the WebGPU spec will skip — that's fine.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "CI: run both Playwright projects, install Mesa Vulkan"
```

---

## Task F3: Manual QA checklist on a local dev server

**Files:** none.

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Walk through every scene on both backends**

Open `http://127.0.0.1:5173/` in a WebGPU-capable Chromium. Verify each of the 7 scenes renders identically to the screenshots below.

Then in `chrome://flags`, disable "Unsafe WebGPU Support" (or launch with `--disable-features=WebGPU`) and repeat. The two experiences should be visually indistinguishable aside from frame-timing jitter.

Check per scene:
- Lenses, Rough Mirror Spheres, Cornell Box, Prism, Cardioid, Spheres, Playground.
- Changing emission (White / Incandescent / Gas Discharge) restarts accumulation; the spectrum graph updates.
- Changing resolution (820×461 → 1920×1080 → back) doesn't leak device memory (DevTools → Memory → take snapshot; repeat; memory should stabilize).
- "Download as PNG" saves a correct image.

Not a test assertion — this is a one-time visual sign-off on the branch before merging.

---

# Phase G — Docs and cleanup

## Task G1: Update `README.md`

**Files:**
- Modify: `README.md`.

- [ ] **Step 1: Update the "About" paragraph**

Change `Tantalum is written in JavaScript and WebGL 2.` to:

```markdown
Tantalum is written in JavaScript. It renders using WebGPU where available and
falls back to WebGL 2 otherwise, so the page works across browsers.
```

- [ ] **Step 2: Add a "Browser support" section after "WebGL 2 requirements"**

```markdown
## Browser support

Tantalum selects the best available backend at startup:

| Backend | Requires                                                                 |
|---------|--------------------------------------------------------------------------|
| WebGPU  | `navigator.gpu`, adapter features `float32-blendable` + `float32-filterable` |
| WebGL 2 | Extensions `OES_texture_float_linear`, `EXT_color_buffer_float`, and working float blending (auto-detected) |

The page falls back to WebGL 2 silently if WebGPU isn't available. Check which
backend is active via `window.tantalumBackendKind` in DevTools (`"webgpu"` or `"webgl2"`).
```

- [ ] **Step 3: Update "Shader compilation" to note the split tree**

Replace the existing section with:

```markdown
## Shader compilation

GLSL sources live under `shaders/glsl/` and are packed into `src/tantalum-shaders.js`
for the WebGL path via `python3 compile-shaders.py`. WGSL sources live under
`shaders/wgsl/` and are imported directly at build time via Vite `?raw` imports
(no build step needed). Always run `compile-shaders.py` after editing GLSL and
commit the regenerated file (CI enforces that the tree is clean).
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: document WebGPU-first path with WebGL 2 fallback"
```

---

## Task G2: Add `docs/webgpu-migration.md`

**Files:**
- Create: `docs/webgpu-migration.md`.

- [ ] **Step 1: Write it**

```markdown
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

| Feature flag             | Why we need it                                                                    |
|--------------------------|-----------------------------------------------------------------------------------|
| `float32-blendable`      | Additive blending into `rgba32float` wave buffer (the splat pass is additive).   |
| `float32-filterable`     | Linear sampling of the spectrum/ICDF/PDF 1-D tables in `init.wgsl`.              |

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
```

- [ ] **Step 2: Commit**

```bash
git add docs/webgpu-migration.md
git commit -m "Add WebGPU migration runbook"
```

---

## Task G3: Drop `__tantalumDebug` hook if no longer needed

**Files:**
- Modify: `src/tantalum.js`.

Task D6 added `window.__tantalumDebug` for bring-up. The final Playwright specs don't use it; remove to avoid exposing internals on `window`.

- [ ] **Step 1: Delete the hook**

Remove the `window.__tantalumDebug = { ... }` block from `setupUI` in `src/tantalum.js`.

- [ ] **Step 2: Verify**

```bash
npm run lint && npm run test:e2e
```

- [ ] **Step 3: Commit**

```bash
git add src/tantalum.js
git commit -m "Remove WebGPU bring-up debug hook"
```

---

## Task G4: Final verification sweep

**Files:** none.

- [ ] **Step 1: Run the full CI matrix locally**

```bash
python3 compile-shaders.py && git diff --exit-code src/tantalum-shaders.js
npm run validate-shaders
npm run lint && npm run format:check
npm run build
npx playwright test
```

Expected: every step clean.

- [ ] **Step 2: Push**

```bash
git push origin HEAD
```

Watch CI. If the WebGPU spec runs (Mesa Vulkan cooperates) it should pass. If it skips, note it so future work can bring up a WebGPU-capable runner.

---

# Self-review

Spec coverage (from the umbrella plan in `~/.claude/plans/create-a-plan-to-reflective-wilkes.md`):

| Spec item                                      | Task(s)                                |
|------------------------------------------------|----------------------------------------|
| Phase B — relocate GLSL, WGSL tree, CI         | B1–B5                                  |
| Phase C — WebGPU device + composite            | C1–C6                                  |
| Phase C — `pass` shader + blit                 | D5 (kept here to group render passes)  |
| Phase D — storage buffer ray state             | D1                                     |
| Phase D — ray-line VBO                         | D2                                     |
| Phase D — splat WGSL + pipeline                | D3–D4                                  |
| Phase E — rand/bsdf/intersect/csg helpers      | E1–E4                                  |
| Phase E — init compute                         | E5                                     |
| Phase E — trace compute helpers                | E6                                     |
| Phase E — scene1..7 compute                    | E7–E13                                 |
| Phase E — spectrum textures                    | E14                                    |
| Phase E — dispatch + loadProgram wiring        | E15                                    |
| Phase E — remove bring-up log                  | E16                                    |
| Phase F — Playwright matrix                    | F1                                     |
| Phase F — CI update                            | F2                                     |
| Phase F — manual QA                            | F3                                     |
| Phase G — README + runbook                     | G1, G2                                 |
| Phase G — cleanup                              | G3                                     |
| Phase G — final verification                   | G4                                     |

Deliberately dropped from the original plan:

- `tools/compare-raystate.html` dev harness (E3 in the umbrella plan). Provides near-zero value once the Playwright WebGPU spec exists and costs real time to build. Reintroduce only if parity bugs surface.
- `tests/e2e/parity.spec.js` pixel-histogram compare. Flaky across GPU drivers; the visual QA in F3 + the behavioral Playwright spec in F1 are sufficient.
- A dedicated `tools/compile_wgsl.py`. Replaced by `src/backend/wgsl-loader.js` (Task B5) because Vite's `?raw` imports make a separate pack step unnecessary.
- A CI step that installs `naga-cli`. `naga` catches WGSL issues but the cost (cargo install in every CI run, plus version pinning) outweighs the value when Playwright already exercises every shader end-to-end on Chromium. Reconsider if cross-runtime (Firefox/Safari) matters.

Type consistency spot-check:

- `RenderTexture` handle shape: WebGL `{ width, height, tex }`; WebGPU `{ width, height, texture, view }`. Renderer (`tantalum-core.js`) only passes these through to `frame.*` methods, never reads `.tex`/`.texture`, so the divergence is opaque. ✔
- `SpectrumResources` shape: both backends expose `.spectrum`, `.emission`, `.icdf`, `.pdf`, `.updateEmission`, `.updateIcdf`, `.updatePdf`. Renderer uses those names. ✔
- `RayState` handle: WebGL `{ size, posTex, rngTex, rgbTex }`; WebGPU `{ size, buffer, byteLen }`. Renderer never reads the fields; backends destructure inside their own frame methods. ✔
- `Program` handle: WebGL is a `tgl.Shader`; WebGPU is `{ kind, pipeline, layout }` (plus `scene` for trace). Both pass through `loadProgram`. ✔
- Placeholder scan: searched plan for "TODO", "TBD", "similar to", "fill in", "implement later" — none remain.
