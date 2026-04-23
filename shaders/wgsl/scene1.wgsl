#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms {
    raySize:    u32,
    activeRows: u32,
    _pad0:      u32,
    _pad1:      u32,
}

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       posDirIn:      array<vec4f>;
@group(0) @binding(2) var<storage, read>       rngIn:         array<vec4f>;
@group(0) @binding(3) var<storage, read>       rgbLambdaIn:   array<vec4f>;
@group(0) @binding(4) var<storage, read_write> posDirOut:     array<vec4f>;
@group(0) @binding(5) var<storage, read_write> rngOut:        array<vec4f>;
@group(0) @binding(6) var<storage, read_write> rgbLambdaOut:  array<vec4f>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect            (ray, vec2f(0.0),         vec2f(1.78, 1.0),         0.0, isect);
    biconvexLensIntersect    (ray, vec2f(-0.4,  0.0),  0.375, 0.15,   0.75, 0.75, 1.0, isect);
    biconcaveLensIntersect   (ray, vec2f( 0.4,  0.0),  0.375, 0.0375, 0.75, 0.75, 1.0, isect);
    planoConvexLensIntersect (ray, vec2f(-1.2,  0.0),  0.375, 0.075,  0.75,       1.0, isect);
    meniscusLensIntersect    (ray, vec2f( 0.8,  0.0),  0.375, 0.15,   0.45, 0.75, 1.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) {
        let ior = sellmeierIor(vec3f(1.6215, 0.2563, 1.6445), vec3f(0.0122, 0.0596, 147.4688), lambda) / 1.4;
        return sampleDielectric(state, wiLocal, ior);
    }
    *throughput = (*throughput) * vec3f(0.5);
    return sampleDiffuse(state, wiLocal);
}

#include "trace"

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= U.raySize || gid.y >= U.activeRows) { return; }
    let ix = gid.y * U.raySize + gid.x;

    var posDir    = posDirIn[ix];
    var state     = rngIn[ix];
    var rgbLambda = rgbLambdaIn[ix];

    traceStep(&state, &posDir, &rgbLambda);

    posDirOut[ix] = posDir;
    rngOut[ix] = state;
    rgbLambdaOut[ix] = rgbLambda;
}
