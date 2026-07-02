(function (exports) {
    var LAMBDA_MIN = 360.0;
    var LAMBDA_MAX = 750.0;
    var TRACE_STEPS_PER_FRAME = 8;
    var WEBGPU_TARGET_FRAME_MS = 12.0;
    var WEBGPU_MAX_TRACE_STEPS = 32;
    var PRESENT_EVERY_TRACE_STEPS = 4;

    var Renderer = function (backend, width, height, scenes) {
        this.backend = backend;

        this.maxSampleCount = 100000;
        this.spreadType = Renderer.SPREAD_POINT;
        this.emissionSpectrumType = Renderer.SPECTRUM_WHITE;
        this.emitterTemperature = 5000.0;
        this.emitterGas = 0;
        this.currentScene = 0;
        this.needsReset = true;

        this.compositeProgram = backend.loadProgram("composite", "compose-frag");
        this.passProgram = backend.loadProgram("blit", "pass-frag");
        this.initProgram = backend.loadProgram("init", "init-frag");
        this.rayProgram = backend.loadProgram("splat", "ray-frag");
        this.tracePrograms = [];
        for (var i = 0; i < scenes.length; ++i) this.tracePrograms.push(backend.loadProgram("trace", scenes[i]));

        this.maxPathLength = 12;

        this.spectrumTable = window.wavelengthToRgbTable();

        this.emissionSpectrum = new Float32Array(Renderer.SPECTRUM_SAMPLES);
        this.pdf = new Float32Array(Renderer.SPECTRUM_SAMPLES);
        this.cdf = new Float32Array(Renderer.SPECTRUM_SAMPLES + 1);
        this.icdf = new Float32Array(Renderer.ICDF_SAMPLES);

        this.spectrumResources = backend.uploadSpectrumResources({
            spectrum: this.spectrumTable,
            emission: new Float32Array(Renderer.SPECTRUM_SAMPLES),
            icdf: new Float32Array(Renderer.ICDF_SAMPLES),
            pdf: new Float32Array(Renderer.SPECTRUM_SAMPLES),
        });

        this.raySize = 512;
        this.resetActiveBlock();
        this.rayCount = this.raySize * this.raySize;
        this.currentState = 0;
        this.unpresentedTraceSteps = 0;
        this.rayStates = [backend.createRayState(this.raySize), backend.createRayState(this.raySize)];

        this.rayVbo = backend.createRayLineGeometry(this.raySize);

        this.changeResolution(width, height);
        this.setEmitterPos([width / 2, height / 2], [width / 2, height / 2]);
        this.computeEmissionSpectrum();
    };

    Renderer.SPECTRUM_WHITE = 0;
    Renderer.SPECTRUM_INCANDESCENT = 1;
    Renderer.SPECTRUM_GAS_DISCHARGE = 2;

    Renderer.SPECTRUM_SAMPLES = 256;
    Renderer.ICDF_SAMPLES = 1024;

    Renderer.SPREAD_POINT = 0;
    Renderer.SPREAD_CONE = 1;
    Renderer.SPREAD_BEAM = 2;
    Renderer.SPREAD_LASER = 3;
    Renderer.SPREAD_AREA = 4;

    Renderer.prototype.resetActiveBlock = function () {
        this.activeBlock = this.raySize;
    };

    Renderer.prototype.setEmissionSpectrumType = function (type) {
        this.emissionSpectrumType = type;
        this.computeEmissionSpectrum();
    };

    Renderer.prototype.setEmitterTemperature = function (temperature) {
        this.emitterTemperature = temperature;
        if (this.emissionSpectrumType == Renderer.SPECTRUM_INCANDESCENT) this.computeEmissionSpectrum();
    };

    Renderer.prototype.setEmitterGas = function (gasId) {
        this.emitterGas = gasId;
        if (this.emissionSpectrumType == Renderer.SPECTRUM_GAS_DISCHARGE) this.computeEmissionSpectrum();
    };

    Renderer.prototype.computeEmissionSpectrum = function () {
        switch (this.emissionSpectrumType) {
            case Renderer.SPECTRUM_WHITE:
                for (var i = 0; i < Renderer.SPECTRUM_SAMPLES; ++i) this.emissionSpectrum[i] = 1.0;
                break;
            case Renderer.SPECTRUM_INCANDESCENT:
                var h = 6.62607004e-34;
                var c = 299792458.0;
                var kB = 1.3806488e-23;
                var T = this.emitterTemperature;

                for (var i = 0; i < Renderer.SPECTRUM_SAMPLES; ++i) {
                    var l = (LAMBDA_MIN + ((LAMBDA_MAX - LAMBDA_MIN) * (i + 0.5)) / Renderer.SPECTRUM_SAMPLES) * 1e-9;
                    var power =
                        (1e-12 * (2.0 * h * c * c)) / (l * l * l * l * l * (Math.exp((h * c) / (l * kB * T)) - 1.0));

                    this.emissionSpectrum[i] = power;
                }
                break;
            case Renderer.SPECTRUM_GAS_DISCHARGE:
                var wavelengths = window.GasDischargeLines[this.emitterGas].wavelengths;
                var strengths = window.GasDischargeLines[this.emitterGas].strengths;

                for (var i = 0; i < Renderer.SPECTRUM_SAMPLES; ++i) this.emissionSpectrum[i] = 0.0;

                for (var i = 0; i < wavelengths.length; ++i) {
                    var idx = Math.floor(
                        ((wavelengths[i] - LAMBDA_MIN) / (LAMBDA_MAX - LAMBDA_MIN)) * Renderer.SPECTRUM_SAMPLES,
                    );
                    if (idx < 0 || idx >= Renderer.SPECTRUM_SAMPLES) continue;

                    this.emissionSpectrum[idx] += strengths[i];
                }
        }

        this.computeSpectrumIcdf();

        this.spectrumResources.updateEmission(this.emissionSpectrum);
        this.reset();
    };

    Renderer.prototype.computeSpectrumIcdf = function () {
        var sum = 0.0;
        for (var i = 0; i < Renderer.SPECTRUM_SAMPLES; ++i) sum += this.emissionSpectrum[i];

        /* Mix in 10% of a uniform sample distribution to stay on the safe side.
           Especially gas emission spectra with lots of emission lines
           tend to have small peaks that fall through the cracks otherwise */
        var safetyPadding = 0.1;
        var normalization = Renderer.SPECTRUM_SAMPLES / sum;

        /* Precompute cdf and pdf (unnormalized for now) */
        this.cdf[0] = 0.0;
        for (var i = 0; i < Renderer.SPECTRUM_SAMPLES; ++i) {
            this.emissionSpectrum[i] *= normalization;

            /* Also take into account the observer response when distributing samples.
               Otherwise tends to prioritize peaks just barely outside the visible spectrum */
            var observerResponse =
                (1.0 / 3.0) *
                (Math.abs(this.spectrumTable[i * 4]) +
                    Math.abs(this.spectrumTable[i * 4 + 1]) +
                    Math.abs(this.spectrumTable[i * 4 + 2]));

            this.pdf[i] = (observerResponse * (this.emissionSpectrum[i] + safetyPadding)) / (1.0 + safetyPadding);
            this.cdf[i + 1] = this.pdf[i] + this.cdf[i];
        }

        /* All done! Time to normalize */
        var cdfSum = this.cdf[Renderer.SPECTRUM_SAMPLES];
        for (var i = 0; i < Renderer.SPECTRUM_SAMPLES; ++i) {
            this.pdf[i] *= Renderer.SPECTRUM_SAMPLES / cdfSum;
            this.cdf[i + 1] /= cdfSum;
        }
        /* Make sure we don't fall into any floating point pits */
        this.cdf[Renderer.SPECTRUM_SAMPLES] = 1.0;

        /* Precompute an inverted mapping of the cdf. This is biased!
           Unfortunately we can't really afford to do runtime bisection
           on the GPU, so this will have to do. For our purposes a small
           amount of bias is tolerable anyway. */
        var cdfIdx = 0;
        for (var i = 0; i < Renderer.ICDF_SAMPLES; ++i) {
            var target = Math.min((i + 1) / Renderer.ICDF_SAMPLES, 1.0);
            while (this.cdf[cdfIdx] < target) cdfIdx++;
            this.icdf[i] = (cdfIdx - 1.0) / Renderer.SPECTRUM_SAMPLES;
        }

        this.spectrumResources.updateIcdf(this.icdf);
        this.spectrumResources.updatePdf(this.pdf);
    };

    Renderer.prototype.getEmissionSpectrum = function () {
        return this.emissionSpectrum;
    };

    Renderer.prototype.setMaxPathLength = function (length) {
        this.maxPathLength = length;
        this.reset();
    };

    Renderer.prototype.setMaxSampleCount = function (count) {
        this.maxSampleCount = count;
    };

    Renderer.prototype.traceStepsPerFrame = function () {
        if (this.backend.caps.kind == "webgpu" && typeof this.backend.getPerfSnapshot == "function") {
            var perf = this.backend.getPerfSnapshot();
            var timedTraceSteps = perf && perf.gpuTimedTraceSteps ? perf.gpuTimedTraceSteps : perf && perf.traceSteps;
            if (perf && timedTraceSteps > 0 && perf.gpuMsTotal > 0) {
                return Math.max(
                    1,
                    Math.min(
                        WEBGPU_MAX_TRACE_STEPS,
                        Math.round((timedTraceSteps * WEBGPU_TARGET_FRAME_MS) / perf.gpuMsTotal),
                    ),
                );
            }
        }
        return TRACE_STEPS_PER_FRAME;
    };

    Renderer.prototype.shouldPresentFrame = function (stepsSincePresent, forcePresent) {
        return forcePresent || this.finished() || stepsSincePresent >= PRESENT_EVERY_TRACE_STEPS;
    };

    Renderer.prototype.shouldPrewarm = function () {
        return false;
    };

    Renderer.prototype.changeResolution = function (width, height) {
        if (this.width && this.height) {
            this.emitterPos[0] = ((this.emitterPos[0] + 0.5) * width) / this.width - 0.5;
            this.emitterPos[1] = ((this.emitterPos[1] + 0.5) * height) / this.height - 0.5;
        }

        var sameSize = this.width == width && this.height == height && this.screenBuffer && this.waveBuffer;

        this.width = width;
        this.height = height;
        this.aspect = this.width / this.height;

        if (!sameSize) {
            if (this.screenBuffer && typeof this.screenBuffer.destroy == "function") this.screenBuffer.destroy();
            if (this.waveBuffer && typeof this.waveBuffer.destroy == "function") this.waveBuffer.destroy();
            this.screenBuffer = this.backend.createRenderTexture(this.width, this.height);
            // waveBuffer only accumulates a single wave (12 additive splats) before
            // being blitted into the rgba32float screenBuffer and cleared, so fp16
            // range/precision is sufficient and halves splat blend/fill bandwidth.
            this.waveBuffer = this.backend.createRenderTexture(this.width, this.height, { format: "rgba16float" });
        }

        this.resetActiveBlock();
        this.reset();
    };

    Renderer.prototype.changeScene = function (idx) {
        this.resetActiveBlock();
        this.currentScene = idx;
        this.reset();
    };

    Renderer.prototype.reset = function () {
        if (!this.needsReset) return;
        this.needsReset = false;
        this.wavesTraced = 0;
        this.raysTraced = 0;
        this.samplesTraced = 0;
        this.pathLength = 0;
        this.unpresentedTraceSteps = 0;
        this.elapsedTimes = [];

        var frame = this.backend.beginFrame();
        frame.clearTexture(this.screenBuffer);
        frame.submit();

        if (typeof this.onReset === "function") this.onReset();
    };

    Renderer.prototype.setSpreadType = function (type) {
        this.resetActiveBlock();
        this.spreadType = type;
        this.computeSpread();
        this.reset();
    };

    Renderer.prototype.setNormalizedEmitterPos = function (posA, posB) {
        this.setEmitterPos(
            [posA[0] * this.width, posA[1] * this.height],
            [posB[0] * this.width, posB[1] * this.height],
        );
    };

    Renderer.prototype.setEmitterPos = function (posA, posB) {
        this.emitterPos = this.spreadType == Renderer.SPREAD_POINT ? posB : posA;
        this.emitterAngle =
            this.spreadType == Renderer.SPREAD_POINT ? 0.0 : Math.atan2(posB[1] - posA[1], posB[0] - posA[0]);
        this.computeSpread();
        this.reset();
    };

    Renderer.prototype.computeSpread = function () {
        switch (this.spreadType) {
            case Renderer.SPREAD_POINT:
                this.emitterPower = 0.1;
                this.spatialSpread = 0.0;
                this.angularSpread = [0.0, Math.PI * 2.0];
                break;
            case Renderer.SPREAD_CONE:
                this.emitterPower = 0.03;
                this.spatialSpread = 0.0;
                this.angularSpread = [this.emitterAngle, Math.PI * 0.3];
                break;
            case Renderer.SPREAD_BEAM:
                this.emitterPower = 0.03;
                this.spatialSpread = 0.4;
                this.angularSpread = [this.emitterAngle, 0.0];
                break;
            case Renderer.SPREAD_LASER:
                this.emitterPower = 0.05;
                this.spatialSpread = 0.0;
                this.angularSpread = [this.emitterAngle, 0.0];
                break;
            case Renderer.SPREAD_AREA:
                this.emitterPower = 0.1;
                this.spatialSpread = 0.4;
                this.angularSpread = [this.emitterAngle, Math.PI];
                break;
        }
    };

    Renderer.prototype.totalRaysTraced = function () {
        return this.raysTraced;
    };

    Renderer.prototype.maxRayCount = function () {
        return this.maxPathLength * this.maxSampleCount;
    };

    Renderer.prototype.totalSamplesTraced = function () {
        return this.samplesTraced;
    };

    Renderer.prototype.progress = function () {
        return Math.min(this.totalRaysTraced() / this.maxRayCount(), 1.0);
    };

    Renderer.prototype.finished = function () {
        return this.totalSamplesTraced() >= this.maxSampleCount;
    };

    Renderer.prototype.composite = function () {
        this.present();
    };

    Renderer.prototype.previewBuffer = function () {
        return this.wavesTraced == 0 && this.pathLength > 0 ? this.waveBuffer : undefined;
    };

    Renderer.prototype.encodePresent = function (frame) {
        frame.composite({
            program: this.compositeProgram,
            screenBuffer: this.screenBuffer,
            exposure: this.width / Math.max(this.samplesTraced, this.raySize * this.activeBlock),
            previewBuffer: this.previewBuffer(),
        });
    };

    Renderer.prototype.present = function () {
        var frame = this.backend.beginFrame();
        this.encodePresent(frame);
        this.unpresentedTraceSteps = 0;
        frame.submit();
    };

    Renderer.prototype.prewarm = function (deadline) {
        /* Keep prewarm bounded and cooperative with the browser */
        var maxSteps = 8;
        var steps = 0;
        var hasBudget = function () {
            return deadline && typeof deadline.timeRemaining === "function" ? deadline.timeRemaining() > 2 : steps == 0;
        };
        while (steps < maxSteps && hasBudget() && !this.finished()) {
            steps++;
        }
        if (steps > 0) this.renderBatch(performance.now(), { maxSteps: steps, forcePresent: true });
    };

    Renderer.prototype.encodeTraceStep = function (frame, timestamp, opts) {
        opts = opts || {};
        if (timestamp === undefined || timestamp === null) timestamp = performance.now();
        this.needsReset = true;

        var current = this.currentState;
        var next = 1 - current;

        if (this.pathLength == 0) {
            frame.updateRayState({
                program: this.initProgram,
                stateIn: this.rayStates[current],
                stateOut: this.rayStates[next],
                textureBindings: {
                    Spectrum: this.spectrumResources.spectrum,
                    Emission: this.spectrumResources.emission,
                    ICDF: this.spectrumResources.icdf,
                    PDF: this.spectrumResources.pdf,
                },
                uniforms: {
                    EmitterPos: [
                        ((this.emitterPos[0] / this.width) * 2.0 - 1.0) * this.aspect,
                        1.0 - (this.emitterPos[1] / this.height) * 2.0,
                    ],
                    EmitterDir: [Math.cos(this.angularSpread[0]), -Math.sin(this.angularSpread[0])],
                    EmitterPower: this.emitterPower,
                    SpatialSpread: this.spatialSpread,
                    AngularSpread: [-this.angularSpread[0], this.angularSpread[1]],
                },
                raySize: this.raySize,
                activeRows: this.activeBlock,
            });

            current = 1 - current;
            next = 1 - next;
        }

        frame.updateRayState({
            program: this.tracePrograms[this.currentScene],
            stateIn: this.rayStates[current],
            stateOut: this.rayStates[next],
            raySize: this.raySize,
            activeRows: this.activeBlock,
        });

        var splatArgs = {
            program: this.rayProgram,
            waveBuffer: this.waveBuffer,
            screenBuffer: this.screenBuffer,
            stateA: this.rayStates[current],
            stateB: this.rayStates[next],
            raysVbo: this.rayVbo,
            raysDrawCount: this.raySize * this.activeBlock * 2,
            aspect: this.aspect,
            clearFirst: opts.directAccumulation ? false : this.pathLength == 0 || this.wavesTraced == 0,
        };

        if (opts.directAccumulation) frame.splatRaysToAccumulation(splatArgs);
        else frame.splatRays(splatArgs);

        this.raysTraced += this.raySize * this.activeBlock;
        this.pathLength += 1;

        if (this.pathLength == this.maxPathLength) {
            if (opts.directAccumulation) {
                this.samplesTraced += this.raySize * this.activeBlock;
                this.wavesTraced += 1;
                this.pathLength = 0;
                this.currentState = next;
                return;
            }

            frame.blit({
                program: this.passProgram,
                src: this.waveBuffer,
                dst: this.screenBuffer,
                additive: true,
            });

            this.samplesTraced += this.raySize * this.activeBlock;
            this.wavesTraced += 1;
            this.pathLength = 0;
        }

        this.currentState = next;
    };

    Renderer.prototype.traceStep = function (timestamp) {
        var frame = this.backend.beginFrame();
        this.encodeTraceStep(frame, timestamp);
        this.unpresentedTraceSteps += 1;
        frame.submit();
    };

    Renderer.prototype.renderBatch = function (timestamp, opts) {
        opts = opts || {};

        var maxSteps = opts.maxSteps === undefined ? this.traceStepsPerFrame() : opts.maxSteps;
        var forcePresent = opts.forcePresent === true;
        var allowPresentWithoutTrace = opts.allowPresentWithoutTrace === true;
        var steps = 0;
        var frame = null;
        var directWaveActive = false;

        while (steps < maxSteps && !this.finished()) {
            if (!frame) frame = this.backend.beginFrame();
            if (this.pathLength == 0) {
                directWaveActive =
                    typeof frame.splatRaysToAccumulation == "function" &&
                    this.backend.caps.kind == "webgpu" &&
                    this.wavesTraced > 0 &&
                    maxSteps - steps >= this.maxPathLength;
            }
            this.encodeTraceStep(frame, steps == 0 ? timestamp : performance.now(), {
                directAccumulation: directWaveActive,
            });
            this.unpresentedTraceSteps += 1;
            steps++;
        }

        var shouldPresent = false;
        if (steps > 0) {
            shouldPresent = this.shouldPresentFrame(this.unpresentedTraceSteps, forcePresent);
        } else if (forcePresent && allowPresentWithoutTrace) {
            shouldPresent = true;
        }

        if (shouldPresent) {
            if (!frame) frame = this.backend.beginFrame();
            this.encodePresent(frame);
            this.unpresentedTraceSteps = 0;
        }

        if (frame) frame.submit();

        return {
            traceSteps: steps,
            presented: shouldPresent,
            pendingPresent: this.unpresentedTraceSteps,
        };
    };

    Renderer.prototype.render = function (timestamp, _isPrewarm) {
        this.renderBatch(timestamp, { maxSteps: 1, forcePresent: true, allowPresentWithoutTrace: true });
    };

    var SpectrumRenderer = function (canvas, spectrum) {
        this.canvas = canvas;
        this.context = this.canvas.getContext("2d");
        this.spectrum = spectrum;
        this.smooth = true;

        this.spectrumFill = new Image();
        this.spectrumFill.src = "Spectrum.png";
        this.spectrumFill.addEventListener("load", this.loadPattern.bind(this));
        if (this.spectrumFill.complete) this.loadPattern();
    };

    SpectrumRenderer.prototype.setSpectrum = function (spectrum) {
        this.spectrum = spectrum;
        this.draw();
    };

    SpectrumRenderer.prototype.loadPattern = function () {
        this.pattern = this.context.createPattern(this.spectrumFill, "repeat-y");
        this.draw();
    };

    SpectrumRenderer.prototype.setColor = function (r, g, b) {
        this.context.strokeStyle = "rgb(" + r + "," + g + "," + b + ")";
    };

    SpectrumRenderer.prototype.drawLine = function (p) {
        this.context.moveTo(p[0], p[1]);
        for (var i = 2; i < p.length; i += 2) this.context.lineTo(p[i], p[i + 1]);
    };

    SpectrumRenderer.prototype.setSmooth = function (smooth) {
        this.smooth = smooth;
    };

    SpectrumRenderer.prototype.draw = function () {
        var ctx = this.context;

        var w = this.canvas.width;
        var h = this.canvas.height;
        var marginX = 10;
        var marginY = 20;

        ctx.clearRect(0, 0, w, h);

        var graphW = w - 2 * marginX;
        var graphH = h - 2 * marginY;
        var graphX = 0 * 0.5 + marginX;
        var graphY = 0 * 0.5 + h - marginY;

        var axisX0 = 360;
        var axisX1 = 750;
        var axisY0 = 0.0;
        var axisY1 = 1.0;
        var xTicks = 50.0;
        var yTicks = 0.2;
        var tickSize = 10;

        var mapX = function (x) {
            return graphX + Math.floor((graphW * (x - axisX0)) / (axisX1 - axisX0));
        };
        var mapY = function (y) {
            return graphY - Math.floor((graphH * (y - axisY0)) / (axisY1 - axisY0));
        };

        ctx.beginPath();
        this.setColor(128, 128, 128);
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 2]);
        for (var gx = axisX0 - 10 + xTicks; gx <= axisX1; gx += xTicks)
            this.drawLine([mapX(gx), graphY, mapX(gx), graphY - graphH]);
        for (var gy = axisY0 + yTicks; gy <= axisY1; gy += yTicks)
            this.drawLine([graphX, mapY(gy), graphX + graphW, mapY(gy)]);
        ctx.stroke();
        ctx.setLineDash([]);

        var max = 0.0;
        for (var i = 0; i < this.spectrum.length; ++i) max = Math.max(this.spectrum[i], max);
        max *= 1.1;

        var grapher = this;
        var drawGraph = function () {
            var spectrum = grapher.spectrum;
            var path = new Path2D();
            path.moveTo(0, h);
            for (var gx = axisX0; gx <= axisX1; gx += grapher.smooth ? 15 : 1) {
                var x = mapX(gx);
                var sx = (spectrum.length * (gx - LAMBDA_MIN)) / (LAMBDA_MAX - LAMBDA_MIN);
                var y = mapY(spectrum[Math.max(Math.min(Math.floor(sx), spectrum.length - 1), 0)] / max);
                if (gx == axisX0) path.moveTo(x, y);
                else path.lineTo(x, y);
            }
            return path;
        };

        var filled = drawGraph();
        filled.lineTo(graphX + graphW, graphY);
        filled.lineTo(graphX, graphY);
        ctx.fillStyle = this.pattern;
        ctx.fill(filled);
        ctx.fillStyle = "black";

        var outline = drawGraph();
        this.setColor(0, 0, 0);
        ctx.lineWidth = 2;
        ctx.stroke(outline);

        ctx.beginPath();
        this.setColor(128, 128, 128);
        ctx.lineWidth = 2;
        this.drawLine([
            graphX + graphW,
            graphY - tickSize,
            graphX + graphW,
            graphY,
            graphX,
            graphY,
            graphX,
            graphY - graphH,
            graphX + tickSize,
            graphY - graphH,
        ]);
        ctx.stroke();

        ctx.beginPath();
        ctx.lineWidth = 2;
        for (var gx = axisX0 - 10 + xTicks; gx < axisX1; gx += xTicks)
            this.drawLine([mapX(gx), graphY, mapX(gx), graphY - tickSize]);
        for (var gy = axisY0 + yTicks; gy < axisY1; gy += yTicks)
            this.drawLine([graphX, mapY(gy), graphX + tickSize, mapY(gy)]);
        ctx.stroke();

        ctx.font = "15px serif";
        ctx.textAlign = "center";
        for (var gx = axisX0 - 10 + xTicks; gx < axisX1; gx += xTicks) ctx.fillText(gx, mapX(gx), graphY + 15);
        ctx.fillText("λ", graphX + graphW, graphY + 16);
    };

    exports.Renderer = Renderer;
    exports.SpectrumRenderer = SpectrumRenderer;
})((window.tcore = window.tcore || {}));
