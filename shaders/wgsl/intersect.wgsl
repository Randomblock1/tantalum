struct RayAux {
    pos:     vec2f,
    dir:     vec2f,
    invDir:  vec2f,
    dirSign: vec2f,
}

fn unpackRay(posDir: vec4f) -> RayAux {
    var dir = posDir.zw;
    if (abs(dir.x) < 1e-5) { dir.x = 1e-5; }
    if (abs(dir.y) < 1e-5) { dir.y = 1e-5; }
    let d = normalize(dir);
    return RayAux(posDir.xy, d, vec2f(1.0) / dir, sign(dir));
}

fn bboxIntersect(ray: RayAux, center: vec2f, radius: vec2f, matId: f32, isect: ptr<function, Intersection>) {
    let pos = ray.pos - center;
    let tx1 = (-radius.x - pos.x) * ray.invDir.x;
    let tx2 = ( radius.x - pos.x) * ray.invDir.x;
    let ty1 = (-radius.y - pos.y) * ray.invDir.y;
    let ty2 = ( radius.y - pos.y) * ray.invDir.y;

    let minX = min(tx1, tx2); let maxX = max(tx1, tx2);
    let minY = min(ty1, ty2); let maxY = max(ty1, ty2);

    let tmin = max((*isect).tMin, max(minX, minY));
    let tmax = min((*isect).tMax, min(maxX, maxY));

    if (tmax >= tmin) {
        let t  = select(tmin, tmax, tmin == (*isect).tMin);
        (*isect).tMax = t;
        if (t == tx1)      { (*isect).n = vec2f(-1.0,  0.0); }
        else if (t == tx2) { (*isect).n = vec2f( 1.0,  0.0); }
        else               { (*isect).n = vec2f( 0.0,  1.0); }
        (*isect).mat = matId;
    }
}

fn sphereIntersect(ray: RayAux, center: vec2f, radius: f32, matId: f32, isect: ptr<function, Intersection>) {
    let p = ray.pos - center;
    let B = dot(p, ray.dir);
    let C = dot(p, p) - radius * radius;
    let detSq = B * B - C;
    if (detSq < 0.0) { return; }
    let det = sqrt(detSq);
    var t = -B - det;
    if (t <= (*isect).tMin || t >= (*isect).tMax) { t = -B + det; }
    if (t > (*isect).tMin && t < (*isect).tMax) {
        (*isect).tMax = t;
        (*isect).n    = normalize(p + ray.dir * t);
        (*isect).mat  = matId;
    }
}

fn lineIntersect(ray: RayAux, a: vec2f, b: vec2f, matId: f32, isect: ptr<function, Intersection>) {
    let sT = b - a;
    let sN = vec2f(-sT.y, sT.x);
    let t = dot(sN, a - ray.pos) / dot(sN, ray.dir);
    let u = dot(sT, ray.pos + ray.dir * t - a);
    if (t < (*isect).tMin || t >= (*isect).tMax || u < 0.0 || u > dot(sT, sT)) { return; }
    (*isect).tMax = t;
    (*isect).n    = normalize(sN);
    (*isect).mat  = matId;
}

fn prismIntersect(ray: RayAux, center: vec2f, radius: f32, matId: f32, isect: ptr<function, Intersection>) {
    lineIntersect(ray, center + vec2f( 0.0,   1.0) * radius, center + vec2f( 0.866, -0.5) * radius, matId, isect);
    lineIntersect(ray, center + vec2f( 0.866,-0.5) * radius, center + vec2f(-0.866, -0.5) * radius, matId, isect);
    lineIntersect(ray, center + vec2f(-0.866,-0.5) * radius, center + vec2f( 0.0,    1.0) * radius, matId, isect);
}
