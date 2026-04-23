/**
 * WebGL 2 backend. Wraps src/tantalum-gl.js (tgl) so the Renderer can
 * drive rendering through the backend.js interface. Behavior is
 * identical to the pre-refactor path: 3 rgba32float textures per ray
 * state, MRT fragment passes for init/trace, additive-blended line draw
 * for splat, quad passes for blit / composite.
 */

const tgl = window.tgl;
const Shaders = window.Shaders;

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {import("./backend.js").Backend}
 */
export function makeWebGLBackend(canvas) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("Could not initialise WebGL 2");

    const floatLinExt = gl.getExtension("OES_texture_float_linear");
    const colorBufFloatExt = gl.getExtension("EXT_color_buffer_float");
    const floatBlendExt = gl.getExtension("EXT_float_blend");

    if (!floatLinExt) throw new Error("Your platform does not support linear filtering for float textures");
    if (!colorBufFloatExt) throw new Error("Your platform does not support float render targets");

    tgl.init(gl);

    if (!floatBlendExt) colorBufferFloatTest(gl);

    const fbo = new tgl.RenderTarget();

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.blendFunc(gl.ONE, gl.ONE);

    const caps = { kind: "webgl2", hasFloat32Blend: true, hasLinearFloat: true };
    let lastPerfSnapshot = {
        backend: caps.kind,
        traceSteps: 0,
        gpuTimingSupported: false,
        gpuMsTotal: null,
        gpuMsInit: null,
        gpuMsTrace: null,
        gpuMsSplat: null,
        gpuMsBlit: null,
        gpuMsComposite: null,
        gpuTimedTraceSteps: null,
        gpuTimingAgeFrames: null,
        submits: 0,
        computePasses: 0,
        computeDispatches: 0,
        coalescedComputePasses: 0,
        renderPasses: 0,
        drawCalls: 0,
        blits: 0,
        composites: 0,
        directWaveCommits: 0,
        uniformWrites: 0,
        uniformBytes: 0,
    };

    function createTexture(w, h, channels, isFloat, isLinear, data) {
        return new tgl.Texture(w, h, channels, isFloat, isLinear, true, data);
    }

    function createRayState(size) {
        const posData = new Float32Array(size * size * 4);
        const rngData = new Float32Array(size * size * 4);
        const rgbData = new Float32Array(size * size * 4);
        for (let i = 0; i < size * size; ++i) {
            const theta = Math.random() * Math.PI * 2.0;
            posData[i * 4 + 0] = 0.0;
            posData[i * 4 + 1] = 0.0;
            posData[i * 4 + 2] = Math.cos(theta);
            posData[i * 4 + 3] = Math.sin(theta);
            for (let t = 0; t < 4; ++t) rngData[i * 4 + t] = Math.random() * 4194167.0;
            for (let t = 0; t < 4; ++t) rgbData[i * 4 + t] = 0.0;
        }
        return {
            size,
            posTex: createTexture(size, size, 4, true, false, posData),
            rngTex: createTexture(size, size, 4, true, false, rngData),
            rgbTex: createTexture(size, size, 4, true, false, rgbData),
        };
    }

    function createRenderTexture(w, h) {
        return { width: w, height: h, tex: createTexture(w, h, 4, true, false, null) };
    }

    function createQuadGeometry() {
        const vbo = new tgl.VertexBuffer();
        vbo.addAttribute("Position", 3, gl.FLOAT, false);
        vbo.addAttribute("TexCoord", 2, gl.FLOAT, false);
        vbo.init(4);
        vbo.copy(
            new Float32Array([
                1.0, 1.0, 0.0, 1.0, 1.0, -1.0, 1.0, 0.0, 0.0, 1.0, -1.0, -1.0, 0.0, 0.0, 0.0, 1.0, -1.0, 0.0, 1.0, 0.0,
            ]),
        );
        return { vbo, mode: gl.TRIANGLE_FAN, count: 4 };
    }

    function createRayLineGeometry(raySize) {
        const count = raySize * raySize;
        const vbo = new tgl.VertexBuffer();
        vbo.addAttribute("TexCoord", 3, gl.FLOAT, false);
        vbo.init(count * 2);
        const data = new Float32Array(count * 2 * 3);
        for (let i = 0; i < count; ++i) {
            const u = ((i % raySize) + 0.5) / raySize;
            const v = (Math.floor(i / raySize) + 0.5) / raySize;
            data[i * 6 + 0] = data[i * 6 + 3] = u;
            data[i * 6 + 1] = data[i * 6 + 4] = v;
            data[i * 6 + 2] = 0.0;
            data[i * 6 + 5] = 1.0;
        }
        vbo.copy(data);
        return { vbo, mode: gl.LINES };
    }

    const PROGRAM_SOURCES = {
        init: { vert: "init-vert", frag: "init-frag" },
        splat: { vert: "ray-vert", frag: "ray-frag" },
        blit: { vert: "compose-vert", frag: "pass-frag" },
        composite: { vert: "compose-vert", frag: "compose-frag" },
    };

    function loadProgram(kind, name) {
        const sources = kind === "trace" ? { vert: "trace-vert", frag: name } : PROGRAM_SOURCES[kind];
        if (!sources) throw new Error(`Unknown program kind: ${kind}`);
        return new tgl.Shader(Shaders, sources.vert, sources.frag);
    }

    function uploadSpectrumResources({ spectrum, emission, icdf, pdf }) {
        const spectrumTex = createTexture(spectrum.length / 4, 1, 4, true, true, spectrum);
        const emissionTex = createTexture(emission.length, 1, 1, true, false, emission);
        const icdfTex = createTexture(icdf.length, 1, 1, true, false, icdf);
        const pdfTex = createTexture(pdf.length, 1, 1, true, false, pdf);
        return {
            spectrum: spectrumTex,
            emission: emissionTex,
            icdf: icdfTex,
            pdf: pdfTex,
            updateEmission: (data) => {
                emissionTex.bind(0);
                emissionTex.copy(data);
            },
            updateIcdf: (data) => {
                icdfTex.bind(0);
                icdfTex.copy(data);
            },
            updatePdf: (data) => {
                pdfTex.bind(0);
                pdfTex.copy(data);
            },
        };
    }

    function resize(w, h) {
        canvas.width = w;
        canvas.height = h;
    }

    function setUniform(program, name, value) {
        if (Array.isArray(value)) {
            if (value.length === 2) program.uniform2F(name, value[0], value[1]);
            else throw new Error(`Unsupported uniform arity ${value.length} for ${name}`);
        } else if (typeof value === "number") {
            program.uniformF(name, value);
        } else {
            throw new Error(`Unsupported uniform type for ${name}`);
        }
    }

    function drawQuad(geometry, program) {
        geometry.vbo.bind();
        geometry.vbo.draw(program, geometry.mode, geometry.count);
    }

    function beginFrame() {
        const frameStats = {
            backend: caps.kind,
            traceSteps: 0,
            gpuTimingSupported: false,
            gpuMsTotal: null,
            gpuMsInit: null,
            gpuMsTrace: null,
            gpuMsSplat: null,
            gpuMsBlit: null,
            gpuMsComposite: null,
            gpuTimedTraceSteps: null,
            gpuTimingAgeFrames: null,
            submits: 0,
            computePasses: 0,
            computeDispatches: 0,
            coalescedComputePasses: 0,
            renderPasses: 0,
            drawCalls: 0,
            blits: 0,
            composites: 0,
            directWaveCommits: 0,
            uniformWrites: 0,
            uniformBytes: 0,
        };

        return {
            updateRayState({ program, stateIn, stateOut, uniforms, textureBindings, raySize, activeRows }) {
                frameStats.renderPasses += 1;
                fbo.bind();
                gl.viewport(0, 0, raySize, raySize);
                gl.scissor(0, 0, raySize, activeRows);
                gl.enable(gl.SCISSOR_TEST);
                fbo.drawBuffers(3);
                fbo.attachTexture(stateOut.posTex, 0);
                fbo.attachTexture(stateOut.rngTex, 1);
                fbo.attachTexture(stateOut.rgbTex, 2);

                program.bind();

                let unit = 0;
                stateIn.posTex.bind(unit++);
                stateIn.rngTex.bind(unit++);
                stateIn.rgbTex.bind(unit++);
                program.uniformTexture("PosData", stateIn.posTex);
                program.uniformTexture("RngData", stateIn.rngTex);
                program.uniformTexture("RgbData", stateIn.rgbTex);

                if (textureBindings) {
                    for (const [name, tex] of Object.entries(textureBindings)) {
                        tex.bind(unit++);
                        program.uniformTexture(name, tex);
                    }
                }
                if (uniforms) {
                    for (const [name, value] of Object.entries(uniforms)) setUniform(program, name, value);
                }

                drawQuad(frameState.quadVbo, program);
                frameStats.drawCalls += 1;

                fbo.detachTexture(0);
                fbo.detachTexture(1);
                fbo.detachTexture(2);
                gl.disable(gl.SCISSOR_TEST);
            },
            splatRays({ program, waveBuffer, stateA, stateB, raysVbo, raysDrawCount, aspect, clearFirst }) {
                frameStats.traceSteps += 1;
                frameStats.renderPasses += 1;
                fbo.bind();
                fbo.drawBuffers(1);
                fbo.attachTexture(waveBuffer.tex, 0);
                gl.viewport(0, 0, waveBuffer.width, waveBuffer.height);
                if (clearFirst) gl.clear(gl.COLOR_BUFFER_BIT);
                gl.enable(gl.BLEND);

                program.bind();
                stateA.posTex.bind(0);
                stateB.posTex.bind(1);
                stateA.rgbTex.bind(2);
                program.uniformTexture("PosDataA", stateA.posTex);
                program.uniformTexture("PosDataB", stateB.posTex);
                program.uniformTexture("RgbData", stateA.rgbTex);
                program.uniformF("Aspect", aspect);
                raysVbo.vbo.bind();
                frameStats.drawCalls += 1;
                raysVbo.vbo.draw(program, raysVbo.mode, raysDrawCount);

                gl.disable(gl.BLEND);
            },
            blit({ program, src, dst, additive }) {
                frameStats.renderPasses += 1;
                frameStats.blits += 1;
                fbo.bind();
                fbo.drawBuffers(1);
                fbo.attachTexture(dst.tex, 0);
                gl.viewport(0, 0, dst.width, dst.height);

                if (additive) gl.enable(gl.BLEND);
                program.bind();
                src.tex.bind(0);
                program.uniformTexture("Frame", src.tex);
                frameStats.drawCalls += 1;
                drawQuad(frameState.quadVbo, program);
                if (additive) gl.disable(gl.BLEND);
            },
            clearTexture(target) {
                frameStats.renderPasses += 1;
                fbo.bind();
                fbo.drawBuffers(1);
                fbo.attachTexture(target.tex, 0);
                gl.viewport(0, 0, target.width, target.height);
                gl.clear(gl.COLOR_BUFFER_BIT);
            },
            composite({ program, screenBuffer, exposure, previewBuffer }) {
                frameStats.renderPasses += 1;
                frameStats.composites += 1;
                fbo.unbind();
                gl.viewport(0, 0, canvas.width, canvas.height);
                program.bind();
                screenBuffer.tex.bind(0);
                (previewBuffer ? previewBuffer.tex : screenBuffer.tex).bind(1);
                program.uniformTexture("Frame", screenBuffer.tex);
                program.uniformTexture("PreviewFrame", previewBuffer ? previewBuffer.tex : screenBuffer.tex);
                program.uniformF("Exposure", exposure);
                program.uniformF("PreviewMix", previewBuffer ? 1.0 : 0.0);
                frameStats.drawCalls += 1;
                drawQuad(frameState.quadVbo, program);
            },
            submit() {
                frameStats.submits = 1;
                lastPerfSnapshot = frameStats;
            },
        };
    }

    /* Shared across frames; stored here so frame methods can reach it without closing over the constructor scope directly. */
    const frameState = {
        quadVbo: createQuadGeometry(),
    };

    return {
        caps,
        canvas,
        createRayState,
        createRenderTexture,
        createQuadGeometry: () => frameState.quadVbo,
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

window.makeWebGLBackend = makeWebGLBackend;

/**
 * The WEBGL_color_buffer_float extension is often not advertised by ANGLE even
 * when the underlying driver supports float blending. To detect whether we
 * actually have working additive blending to a float render target we run a
 * tiny two-draw blend-and-read back test. Mirrors the logic from
 * src/tantalum.js prior to the backend refactor.
 */
function colorBufferFloatTest(gl) {
    const shader = new tgl.Shader(Shaders, "blend-test-vert", "blend-test-frag");
    const packShader = new tgl.Shader(Shaders, "blend-test-vert", "blend-test-pack-frag");
    const target = new tgl.Texture(1, 1, 4, true, false, false, new Float32Array([-6.0, 10.0, 30.0, 2.0]));
    const testFbo = new tgl.RenderTarget();
    const vbo = new tgl.VertexBuffer();
    vbo.bind();
    vbo.addAttribute("Position", 3, gl.FLOAT, false);
    vbo.init(4);
    vbo.copy(new Float32Array([1.0, 1.0, 0.0, -1.0, 1.0, 0.0, -1.0, -1.0, 0.0, 1.0, -1.0, 0.0]));

    gl.viewport(0, 0, 1, 1);
    testFbo.bind();
    testFbo.drawBuffers(1);
    testFbo.attachTexture(target, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    shader.bind();
    vbo.draw(shader, gl.TRIANGLE_FAN);
    vbo.draw(shader, gl.TRIANGLE_FAN);
    testFbo.unbind();
    gl.disable(gl.BLEND);

    packShader.bind();
    target.bind(0);
    packShader.uniformTexture("Tex", target);
    vbo.draw(packShader, gl.TRIANGLE_FAN);

    const pixels = new Uint8Array([0, 0, 0, 0]);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (pixels[0] != 8 || pixels[1] != 128 || pixels[2] != 16 || pixels[3] != 4) {
        console.log(
            "Floating point blending test failed. Result was " + pixels + " but should have been " + [8, 128, 16, 4],
        );
        throw new Error("Your platform does not support floating point attachments");
    }
}
