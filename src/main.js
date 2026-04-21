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
