#include "preamble"
#include "rand"
#include "bsdf"
#include "intersect"
#include "csg"

struct TraceUniforms { raySize: u32, activeRows: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<uniform> U: TraceUniforms;
@group(0) @binding(1) var<storage, read>       posDirIn:      array<vec4f>;
@group(0) @binding(2) var<storage, read>       rngIn:         array<vec4f>;
@group(0) @binding(3) var<storage, read>       rgbLambdaIn:   array<vec4f>;
@group(0) @binding(4) var<storage, read_write> posDirOut:     array<vec4f>;
@group(0) @binding(5) var<storage, read_write> rngOut:        array<vec4f>;
@group(0) @binding(6) var<storage, read_write> rgbLambdaOut:  array<vec4f>;

fn intersectScene(ray: RayAux, isect: ptr<function, Intersection>) {
    bboxIntersect   (ray, vec2f(0.0),              vec2f(1.78, 1.0),  0.0, isect);
    sphereIntersect (ray, vec2f(-1.424, -0.8),     0.356,             1.0, isect);
    sphereIntersect (ray, vec2f(-0.72,  -0.8),     0.356,             2.0, isect);
    sphereIntersect (ray, vec2f( 0.0,   -0.8),     0.356,             3.0, isect);
    sphereIntersect (ray, vec2f( 0.72,  -0.8),     0.356,             4.0, isect);
    sphereIntersect (ray, vec2f( 1.424, -0.8),     0.356,             5.0, isect);
}

fn sampleBsdf(
    state: ptr<function, vec4f>,
    isect: Intersection,
    lambda: f32,
    wiLocal: vec2f,
    throughput: ptr<function, vec3f>,
) -> vec2f {
    if (isect.mat == 1.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.02); }
    if (isect.mat == 2.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.05); }
    if (isect.mat == 3.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.1);  }
    if (isect.mat == 4.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.2);  }
    if (isect.mat == 5.0) { return sampleRoughMirror(state, wiLocal, throughput, 0.5);  }
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
