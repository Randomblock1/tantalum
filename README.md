Tantalum Sample Render

# The Tantalum Renderer

## About

Tantalum is a physically based 2D renderer written out of personal interest. The idea of this project was to build a light transport simulation using the same mathematical tools used in academic and movie production renderers, but in a simplified 2D setting. The 2D setting allows for faster render times and a more accessible way of understanding and interacting with light, even for people with no prior knowledge or interest in rendering.

Tantalum is written in JavaScript and WebGL 2.

## Running locally

**Recommended:** use the Vite dev server (live reload, correct asset paths for the production layout):

```bash
npm ci
npm run dev
```

Then open the URL shown in the terminal (by default `http://127.0.0.1:5173/`).

**Without Node:** from the repository root, use any static HTTP server (module scripts and assets expect normal HTTP, not `file://`), for example:

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/tantalum.html` for the classic script bundle, or `http://127.0.0.1:8000/` for the Vite `index.html` entry if you have run `npm run build` and serve `dist/`.

## Shader compilation

GLSL sources live under `[shaders/](shaders/)`. Packing them into `[src/tantalum-shaders.js](src/tantalum-shaders.js)` requires **Python 3**:

```bash
python3 compile-shaders.py
```

Always run this after editing shader files, and commit the regenerated `tantalum-shaders.js` (CI enforces that the tree is clean after regeneration).

## WebGL 2 requirements

The renderer targets **WebGL 2** and relies on these extensions (the app checks for them and shows a clear error if something is missing):

- `OES_texture_float_linear`
- `EXT_color_buffer_float` (required for float render targets)
- `EXT_float_blend` (preferred; otherwise a small blending self-test decides whether float render targets work)

## Production build

```bash
npm run build
```

Static output is written to `dist/` (suitable for GitHub Pages or any static host).

## Development scripts

- `**npm run dev**` — Vite dev server.
- `**npm run build**` — production bundle to `dist/`.
- `**npm run lint**` — ESLint.
- `**npm run format**` — Prettier (write).
- `**npm run format:check**` — Prettier (check).
- `**npm run validate-shaders**` — expand `#include` and run `glslangValidator` on single-output shaders (see `[tools/validate_shaders.py](tools/validate_shaders.py)`).
- `**npm run test:e2e**` — Playwright smoke test (starts Vite and loads the app).

## License

To give developers as much freedom as is reasonable, Tantalum is distributed under the [libpng/zlib](http://opensource.org/licenses/Zlib) license. This allows you to modify, redistribute and sell all or parts of the code without attribution.

See `[LICENSE.txt](LICENSE.txt)` for the full text.
