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
