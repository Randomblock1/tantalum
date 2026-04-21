fn rand(state: ptr<function, vec4f>) -> f32 {
    let q = vec4f(1225.0, 1585.0, 2457.0, 2098.0);
    let r = vec4f(1112.0,  367.0,   92.0,  265.0);
    let a = vec4f(3423.0, 2646.0, 1707.0, 1999.0);
    let m = vec4f(4194287.0, 4194277.0, 4194191.0, 4194167.0);

    var beta = floor((*state) / q);
    let p = a * ((*state) - beta * q) - beta * r;
    beta = (vec4f(1.0) - sign(p)) * 0.5 * m;
    *state = p + beta;
    return fract(dot((*state) / m, vec4f(1.0, -1.0, 1.0, -1.0)));
}
