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

Tantalum.prototype.schedulePrewarm = function () {
    if (this._prewarmStarted) return;
    if (!this.renderer) return;
    this._prewarmStarted = true;
    this._prewarmStartMs = performance.now();

    var runSlice = function (deadline) {
        if (!this.renderer || this.renderer.finished()) return;
        if (performance.now() - this._prewarmStartMs > this._prewarmBudgetMs) return;

        if (typeof this.renderer.prewarm === "function") {
            this.renderer.prewarm(deadline);
        } else {
            // Fallback: do a single render step.
            this.renderer.render(performance.now(), true);
        }

        scheduleNext();
    }.bind(this);

    var scheduleNext = function () {
        if (!this.renderer || this.renderer.finished()) return;
        if (performance.now() - this._prewarmStartMs > this._prewarmBudgetMs) return;

        if (window.requestIdleCallback) {
            window.requestIdleCallback(runSlice, { timeout: 50 });
        } else {
            setTimeout(function () {
                runSlice({ timeRemaining: function () { return 0; } });
            }, 0);
        }
    }.bind(this);

    scheduleNext();
};

Tantalum.prototype.setupGL = async function () {
    this.backend = await window.selectBackend(this.canvas);
    window.tantalumBackendKind = this.backend.caps.kind; // consumed by Playwright specs
};

Tantalum.prototype.setupUI = function () {
    console.log("Tantalum backend:", this.backend.caps.kind);

    function map(a, b) {
        return [(a * 0.5) / 1.78 + 0.5, -b * 0.5 + 0.5];
    }

    var config = {
        resolutions: [
            [820, 461],
            [1024, 576],
            [1280, 720],
            [1600, 900],
            [1920, 1080],
            [4096, 2160],
        ],
        scenes: [
            {
                shader: "scene1",
                name: "Lenses",
                posA: [0.5, 0.5],
                posB: [0.5, 0.5],
                spread: tcore.Renderer.SPREAD_POINT,
            },
            {
                shader: "scene6",
                name: "Spheres",
                posA: map(-1.59, 0.65),
                posB: map(0.65, -0.75),
                spread: tcore.Renderer.SPREAD_BEAM,
            },
            {
                shader: "scene7",
                name: "Playground",
                posA: [0.3, 0.52],
                posB: [0.3, 0.52],
                spread: tcore.Renderer.SPREAD_POINT,
            },
            {
                shader: "scene4",
                name: "Prism",
                posA: [0.1, 0.65],
                posB: [0.4, 0.4],
                spread: tcore.Renderer.SPREAD_LASER,
            },
            {
                shader: "scene5",
                name: "Cardioid",
                posA: [0.2, 0.5],
                posB: [0.2, 0.5],
                spread: tcore.Renderer.SPREAD_POINT,
            },
            {
                shader: "scene3",
                name: "Cornell Box",
                posA: [0.5, 0.101],
                posB: [0.5, 0.2],
                spread: tcore.Renderer.SPREAD_AREA,
            },
            {
                shader: "scene2",
                name: "Rough Mirror Spheres",
                posA: [0.25, 0.125],
                posB: [0.5, 0.66],
                spread: tcore.Renderer.SPREAD_LASER,
            },
        ],
    };

    var sceneShaders = [],
        sceneNames = [];
    for (var i = 0; i < config.scenes.length; ++i) {
        sceneShaders.push(config.scenes[i].shader);
        sceneNames.push(config.scenes[i].name);
    }

    this.renderer = new tcore.Renderer(this.backend, this.canvas.width, this.canvas.height, sceneShaders);
    this.spectrumRenderer = new tcore.SpectrumRenderer(this.spectrumCanvas, this.renderer.getEmissionSpectrum());

    /* Let's try and make member variables in JS a little less verbose... */
    var spectrumRenderer = this.spectrumRenderer;
    var renderer = this.renderer;
    var content = this.content;
    var canvas = this.canvas;

    this.progressBar = new tui.ProgressBar("render-progress", true);

    var resolutionLabels = [];
    for (var i = 0; i < config.resolutions.length; ++i)
        resolutionLabels.push(config.resolutions[i][0] + "x" + config.resolutions[i][1]);

    new tui.ButtonGroup("resolution-selector", false, resolutionLabels, function (idx) {
        var width = config.resolutions[idx][0];
        var height = config.resolutions[idx][1];
        content.style.width = width + "px";
        content.style.height = height + "px";
        canvas.width = width;
        canvas.height = height;
        renderer.changeResolution(width, height);
    });
    var spreadSelector = new tui.ButtonGroup(
        "spread-selector",
        true,
        ["Point", "Cone", "Beam", "Laser", "Area"],
        renderer.setSpreadType.bind(renderer),
    );

    function selectScene(idx) {
        renderer.changeScene(idx);
        spreadSelector.select(config.scenes[idx].spread);
        renderer.setNormalizedEmitterPos(config.scenes[idx].posA, config.scenes[idx].posB);
    }
    new tui.ButtonGroup("scene-selector", true, sceneNames, selectScene);

    var mouseListener = new tui.MouseListener(canvas, renderer.setEmitterPos.bind(renderer));

    var temperatureSlider = new tui.Slider("emission-temperature", 1000, 10000, true, function (temperature) {
        this.setLabel("Temperature: " + temperature + "K");
        renderer.setEmitterTemperature(temperature);
        spectrumRenderer.setSpectrum(renderer.getEmissionSpectrum());
    });

    var bounceSlider = new tui.Slider("path-length", 1, 20, true, function (length) {
        this.setLabel(length - 1 + " light bounces");
        renderer.setMaxPathLength(length);
    });
    bounceSlider.setValue(12);

    var sampleSlider = new tui.Slider("sample-count", 400, 700, true, function (exponent100) {
        var sampleCount = Math.floor(Math.pow(10, exponent100 * 0.01));
        this.setLabel(sampleCount + " light paths");
        renderer.setMaxSampleCount(sampleCount);
    });
    sampleSlider.setValue(600);

    var gasOptions = [];
    for (var i = 0; i < GasDischargeLines.length; ++i) gasOptions.push(GasDischargeLines[i].name);
    var gasGrid = new tui.ButtonGrid("gas-selection", 4, gasOptions, function (gasId) {
        renderer.setEmitterGas(gasId);
        spectrumRenderer.setSpectrum(renderer.getEmissionSpectrum());
    });

    temperatureSlider.show(false);
    gasGrid.show(false);

    new tui.ButtonGroup("emission-selector", false, ["White", "Incandescent", "Gas Discharge"], function (type) {
        renderer.setEmissionSpectrumType(type);
        spectrumRenderer.setSmooth(type != tcore.Renderer.SPECTRUM_GAS_DISCHARGE);
        spectrumRenderer.setSpectrum(renderer.getEmissionSpectrum());
        temperatureSlider.show(type == tcore.Renderer.SPECTRUM_INCANDESCENT);
        gasGrid.show(type == tcore.Renderer.SPECTRUM_GAS_DISCHARGE);
    });

    this.saveImageData = false;
    document.getElementById("save-button").addEventListener(
        "click",
        function () {
            this.saveImageData = true;
        }.bind(this),
    );

    selectScene(0);

    this.overlay.className = "render-help";
    this.overlay.offsetHeight; /* Flush CSS changes */
    this.overlay.className += " render-help-transition";
    this.overlay.textContent = "Click and drag!";
    this.overlay.addEventListener("mousedown", function (event) {
        this.parentNode.removeChild(this);
        mouseListener.mouseDown(event);
    });
};

Tantalum.prototype.fail = function (message) {
    var sorryP = document.createElement("p");
    sorryP.appendChild(document.createTextNode("Sorry! :("));
    sorryP.style.fontSize = "50px";

    var failureP = document.createElement("p");
    failureP.className = "warning-box";
    failureP.innerHTML = message;

    var errorImg = document.createElement("img");
    errorImg.title = errorImg.alt = "The Element of Failure";
    errorImg.src = "derp.gif";

    var failureDiv = document.createElement("div");
    failureDiv.className = "center";
    failureDiv.appendChild(sorryP);
    failureDiv.appendChild(errorImg);
    failureDiv.appendChild(failureP);

    document.getElementById("content").appendChild(failureDiv);
    this.overlay.style.display = this.canvas.style.display = "none";
};

Tantalum.prototype.renderLoop = function (timestamp) {
    window.requestAnimationFrame(this.boundRenderLoop);

    if (!this.renderer.finished()) this.renderer.render(timestamp);

    if (this.saveImageData) {
        /* Ensure we redraw the image before we grab it. This is a strange one:
           To save power the renderer stops doing anything after it finished
           tracing rays, and the canvas keeps displaying the correct image
           (as you would expect). However, when we get the canvas as a blob,
           the results are garbage unless we rendered to it in that frame.
           There's most likely some browser/ANGLE meddling happening here, but
           in interest of my mental health I'm not going to dig deeper into this */
        if (this.renderer.finished()) this.renderer.composite();

        var fileName = "Tantalum";
        if (this.savedImages > 0) fileName += this.savedImages + 1;
        fileName += ".png";

        this.canvas.toBlob(function (blob) {
            window.saveTantalumPng(blob, fileName);
        }, "image/png");

        this.savedImages++;
        this.saveImageData = false;
    }

    this.progressBar.setProgress(this.renderer.progress());
    this.progressBar.setLabel(
        Math.min(this.renderer.totalRaysTraced(), this.renderer.maxRayCount()) +
            "/" +
            this.renderer.maxRayCount() +
            " rays traced; Progress: " +
            this.progressBar.getProgressPercentage() +
            "%",
    );
};

window.Tantalum = Tantalum;
