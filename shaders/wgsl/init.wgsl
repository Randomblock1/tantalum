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
