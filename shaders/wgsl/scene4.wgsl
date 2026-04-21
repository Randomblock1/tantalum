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
