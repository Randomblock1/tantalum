struct Segment {
    tNear: f32,
    tFar:  f32,
    nNear: vec2f,
    nFar:  vec2f,
}

fn segmentIntersection(a: Segment, b: Segment) -> Segment {
    return Segment(
        max(a.tNear, b.tNear),
        min(a.tFar,  b.tFar),
        select(b.nNear, a.nNear, a.tNear > b.tNear),
        select(a.nFar,  b.nFar,  a.tFar  < b.tFar),
    );
}

fn segmentSubtraction(a: Segment, b: Segment, tMin: f32) -> Segment {
    if (a.tNear >= a.tFar || b.tNear >= b.tFar || a.tFar <= b.tNear || a.tNear >= b.tFar) {
        return a;
    }
    let s1 = Segment(a.tNear, b.tNear, a.nNear, -b.nNear);
    let s2 = Segment(b.tFar,  a.tFar, -b.nFar,   a.nFar);
    let valid1 = s1.tNear <= s1.tFar;
    let valid2 = s2.tNear <= s2.tFar;
    if (valid1 && valid2) {
        if (s1.tFar >= tMin) { return s1; } else { return s2; }
    }
    if (valid1) { return s1; }
    return s2;
}

fn segmentCollapse(segIn: Segment, matId: f32, isect: ptr<function, Intersection>) {
    var seg = segIn;
    seg.tNear = max(seg.tNear, (*isect).tMin);
    seg.tFar  = min(seg.tFar,  (*isect).tMax);
    if (seg.tNear <= seg.tFar) {
        if (seg.tNear > (*isect).tMin) {
            (*isect).tMax = seg.tNear;
            (*isect).n    = seg.nNear;
            (*isect).mat  = matId;
        } else if (seg.tFar < (*isect).tMax) {
            (*isect).tMax = seg.tFar;
            (*isect).n    = seg.nFar;
            (*isect).mat  = matId;
        }
    }
}

fn horzSpanIntersect(ray: RayAux, y: f32, radius: f32) -> Segment {
    let dc = (y - ray.pos.y) * ray.invDir.y;
    let dt = ray.dirSign.y * radius * ray.invDir.y;
    return Segment(dc - dt, dc + dt, vec2f(0.0, -ray.dirSign.y), vec2f(0.0, ray.dirSign.y));
}
fn vertSpanIntersect(ray: RayAux, x: f32, radius: f32) -> Segment {
    let dc = (x - ray.pos.x) * ray.invDir.x;
    let dt = ray.dirSign.x * radius * ray.invDir.x;
    return Segment(dc - dt, dc + dt, vec2f(-ray.dirSign.x, 0.0), vec2f(ray.dirSign.x, 0.0));
}
fn boxSegmentIntersect(ray: RayAux, center: vec2f, radius: vec2f) -> Segment {
    return segmentIntersection(
        horzSpanIntersect(ray, center.y, radius.y),
        vertSpanIntersect(ray, center.x, radius.x),
    );
}
fn sphereSegmentIntersect(ray: RayAux, center: vec2f, radius: f32) -> Segment {
    var out = Segment(1e30, -1e30, vec2f(0.0), vec2f(0.0));
    let p = ray.pos - center;
    let B = dot(p, ray.dir);
    let C = dot(p, p) - radius * radius;
    let detSq = B * B - C;
    if (detSq >= 0.0) {
        let det = sqrt(detSq);
        out.tNear = -B - det;
        out.tFar  = -B + det;
        out.nNear = (p + ray.dir * out.tNear) * (1.0 / radius);
        out.nFar  = (p + ray.dir * out.tFar)  * (1.0 / radius);
    }
    return out;
}

fn biconvexLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r1: f32, r2: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentIntersection(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        sphereSegmentIntersect(ray, center + vec2f(r1 - d, 0.0), r1)),
        sphereSegmentIntersect(ray, center - vec2f(r2 - d, 0.0), r2),
    ), matId, isect);
}
fn biconcaveLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r1: f32, r2: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentSubtraction(segmentSubtraction(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        vertSpanIntersect(ray, center.x + 0.5 * (r2 - r1), 0.5 * (abs(r1) + abs(r2)) + d)),
        sphereSegmentIntersect(ray, center + vec2f(r2 + d, 0.0), r2), (*isect).tMin),
        sphereSegmentIntersect(ray, center - vec2f(r1 + d, 0.0), r1), (*isect).tMin,
    ), matId, isect);
}
fn meniscusLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r1: f32, r2: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentSubtraction(segmentIntersection(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        vertSpanIntersect(ray, center.x + 0.5 * r2, 0.5 * abs(r2) + d)),
        sphereSegmentIntersect(ray, center + vec2f(r1 - sign(r1) * d, 0.0), abs(r1))),
        sphereSegmentIntersect(ray, center + vec2f(r2 + sign(r2) * d, 0.0), abs(r2)), (*isect).tMin,
    ), matId, isect);
}
fn planoConvexLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentIntersection(
        boxSegmentIntersect(ray, center, vec2f(d, h)),
        sphereSegmentIntersect(ray, center + vec2f(r - d, 0.0), abs(r)),
    ), matId, isect);
}
fn planoConcaveLensIntersect(ray: RayAux, center: vec2f, h: f32, d: f32, r: f32, matId: f32, isect: ptr<function, Intersection>) {
    segmentCollapse(segmentSubtraction(segmentIntersection(
        horzSpanIntersect(ray, center.y, h),
        vertSpanIntersect(ray, center.x - 0.5 * r, 0.5 * abs(r) + d)),
        sphereSegmentIntersect(ray, center - vec2f(r + d, 0.0), abs(r)), (*isect).tMin,
    ), matId, isect);
}
