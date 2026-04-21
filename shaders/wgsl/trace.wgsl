fn traceStep(
    state: ptr<function, vec4f>,
    posDir: ptr<function, vec4f>,
    rgbLambda: ptr<function, vec4f>,
) {
    let ray = unpackRay(*posDir);
    var isect: Intersection;
    isect.tMin = 1e-4;
    isect.tMax = 1e30;
    intersectScene(ray, &isect);

    let t = vec2f(-isect.n.y, isect.n.x);
    let wiLocal = -vec2f(dot(t, ray.dir), dot(isect.n, ray.dir));
    var throughput = (*rgbLambda).rgb;
    let woLocal = sampleBsdf(state, isect, (*rgbLambda).w, wiLocal, &throughput);
    *rgbLambda = vec4f(throughput, (*rgbLambda).w);

    if (isect.tMax == 1e30) {
        (*rgbLambda) = vec4f(0.0, 0.0, 0.0, (*rgbLambda).w);
    } else {
        *posDir = vec4f(ray.pos + ray.dir * isect.tMax,
                        woLocal.y * isect.n + woLocal.x * t);
    }
}
