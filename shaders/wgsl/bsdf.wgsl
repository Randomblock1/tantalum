fn sellmeierIor(b: vec3f, c: vec3f, lambda: f32) -> f32 {
    let lSq = (lambda * 1e-3) * (lambda * 1e-3);
    return 1.0 + dot((b * lSq) / (lSq - c), vec3f(1.0));
}

fn tanhApprox(x: f32) -> f32 {
    if (abs(x) > 10.0) { return sign(x); }
    let e = exp(-2.0 * x);
    return (1.0 - e) / (1.0 + e);
}
fn atanhApprox(x: f32) -> f32 {
    return 0.5 * log((1.0 + x) / (1.0 - x));
}

fn dielectricReflectance(eta: f32, cosThetaI: f32, cosThetaT: ptr<function, f32>) -> f32 {
    let sinThetaTSq = eta * eta * (1.0 - cosThetaI * cosThetaI);
    if (sinThetaTSq > 1.0) {
        *cosThetaT = 0.0;
        return 1.0;
    }
    *cosThetaT = sqrt(1.0 - sinThetaTSq);
    let Rs = (eta * cosThetaI - *cosThetaT) / (eta * cosThetaI + *cosThetaT);
    let Rp = (eta * *cosThetaT - cosThetaI) / (eta * *cosThetaT + cosThetaI);
    return (Rs * Rs + Rp * Rp) * 0.5;
}

fn sampleDiffuse(state: ptr<function, vec4f>, wi: vec2f) -> vec2f {
    let x = rand(state) * 2.0 - 1.0;
    let y = sqrt(1.0 - x * x);
    return vec2f(x, y * sign(wi.y));
}

fn sampleMirror(wi: vec2f) -> vec2f {
    return vec2f(-wi.x, wi.y);
}

fn sampleDielectric(state: ptr<function, vec4f>, wi: vec2f, ior: f32) -> vec2f {
    var cosThetaT: f32 = 0.0;
    let eta = select(1.0 / ior, ior, wi.y < 0.0);
    let Fr  = dielectricReflectance(eta, abs(wi.y), &cosThetaT);
    if (rand(state) < Fr) {
        return vec2f(-wi.x, wi.y);
    }
    return vec2f(-wi.x * eta, -cosThetaT * sign(wi.y));
}

fn sampleVisibleNormal(sigma: f32, xi: f32, theta0: f32, theta1: f32) -> f32 {
    let sigmaSq    = sigma * sigma;
    let invSigmaSq = 1.0 / sigmaSq;
    let cdf0 = tanhApprox(theta0 * 0.5 * invSigmaSq);
    let cdf1 = tanhApprox(theta1 * 0.5 * invSigmaSq);
    return 2.0 * sigmaSq * atanhApprox(cdf0 + (cdf1 - cdf0) * xi);
}

fn sampleRoughMirror(
    state: ptr<function, vec4f>,
    wi: vec2f,
    throughput: ptr<function, vec3f>,
    sigma: f32,
) -> vec2f {
    let theta  = asin(clamp(wi.x, -1.0, 1.0));
    let theta0 = max(theta - PI_HALF, -PI_HALF);
    let theta1 = min(theta + PI_HALF,  PI_HALF);
    let thetaM = sampleVisibleNormal(sigma, rand(state), theta0, theta1);
    let m  = vec2f(sin(thetaM), cos(thetaM));
    let wo = m * (dot(wi, m) * 2.0) - wi;
    if (wo.y < 0.0) { *throughput = vec3f(0.0); }
    return wo;
}

fn sampleRoughDielectric(
    state: ptr<function, vec4f>,
    wi: vec2f,
    sigma: f32,
    ior: f32,
) -> vec2f {
    let theta  = asin(min(abs(wi.x), 1.0));
    let theta0 = max(theta - PI_HALF, -PI_HALF);
    let theta1 = min(theta + PI_HALF,  PI_HALF);
    let thetaM = sampleVisibleNormal(sigma, rand(state), theta0, theta1);
    let m = vec2f(sin(thetaM), cos(thetaM));
    let wiDotM = dot(wi, m);
    var cosThetaT: f32 = 0.0;
    let etaM = select(1.0 / ior, ior, wiDotM < 0.0);
    let F = dielectricReflectance(etaM, abs(wiDotM), &cosThetaT);
    if (wiDotM < 0.0) { cosThetaT = -cosThetaT; }
    if (rand(state) < F) {
        return 2.0 * wiDotM * m - wi;
    }
    return (etaM * wiDotM - cosThetaT) * m - etaM * wi;
}
