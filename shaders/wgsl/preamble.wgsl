const PI: f32 = 3.14159265358979323846;
const PI_HALF: f32 = 1.57079632679489661923;
const SQRT2: f32 = 1.41421356237309504880;

struct Ray {
    posDir:    vec4f,  // xy pos, zw dir
    rng:       vec4f,
    rgbLambda: vec4f,  // rgb throughput, lambda (nm)
}

struct Intersection {
    tMin: f32,
    tMax: f32,
    n:    vec2f,
    mat:  f32,
}
