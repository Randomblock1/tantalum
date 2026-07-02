#include "preamble"

struct SplatUniforms {
    aspect: f32,
    _pad0:  f32,
    _pad1:  f32,
    _pad2:  f32,
}

@group(0) @binding(0) var<uniform> U: SplatUniforms;
@group(0) @binding(1) var<storage, read> posDirA:    array<vec4f>;
@group(0) @binding(2) var<storage, read> rgbLambdaA: array<vec4f>;
@group(0) @binding(3) var<storage, read> posDirB:    array<vec4f>;

fn isRayAlive(rgbLambda: vec4f) -> bool {
    return any(rgbLambda.rgb != vec3f(0.0));
}

struct VSOut {
    @builtin(position) pos:   vec4f,
    @location(0)       color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> VSOut {
    let ix = instanceIndex;
    let rgbLambda = rgbLambdaA[ix];
    let posA = posDirA[ix].xy;
    var out: VSOut;
    if (!isRayAlive(rgbLambda)) {
        out.pos = vec4f(2.0, 2.0, 0.0, 1.0);
        out.color = vec3f(0.0);
        return out;
    }
    let posB = posDirB[ix].xy;
    let pos  = select(posA, posB, vertexIndex == 1u);
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
