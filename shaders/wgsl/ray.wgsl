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

fn isRayAlive(rgbLambda: vec4f) -> bool {
    return any(rgbLambda.rgb != vec3f(0.0));
}

struct VSOut {
    @builtin(position) pos:   vec4f,
    @location(0)       color: vec3f,
}

@vertex
fn vs(@location(0) uvz: vec3f) -> VSOut {
    let ix = u32(uvz.y * f32(U.raySize)) * U.raySize + u32(uvz.x * f32(U.raySize));
    let rgbLambda = stateA[ix].rgbLambda;
    let posA = stateA[ix].posDir.xy;
    var out: VSOut;
    if (!isRayAlive(rgbLambda)) {
        out.pos = vec4f(2.0, 2.0, 0.0, 1.0);
        out.color = vec3f(0.0);
        return out;
    }
    let posB = stateB[ix].posDir.xy;
    let pos  = mix(posA, posB, uvz.z);
    let dir  = posB - posA;
    let bias = clamp(length(dir) / max(max(abs(dir.x), abs(dir.y)), 1e-30), 1.0, SQRT2);
    out.pos   = vec4f(pos.x / U.aspect, pos.y, 0.0, 1.0);
    out.color = rgbLambda.rgb * bias;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    return vec4f(in.color, 1.0);
}
