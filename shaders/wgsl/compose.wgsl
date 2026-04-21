struct Uniforms {
    exposure: f32,
    _pad:     vec3f,
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var frameTex: texture_2d<f32>;
@group(0) @binding(2) var frameSmp: sampler;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0)       uv:  vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    // Full-screen triangle covering the viewport.
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var uvs     = array<vec2f, 3>(vec2f( 0.0,  1.0), vec2f(2.0,  1.0), vec2f( 0.0, -1.0));
    var out: VSOut;
    out.pos = vec4f(corners[vi], 0.0, 1.0);
    out.uv  = uvs[vi];
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let dims = vec2f(textureDimensions(frameTex, 0));
    let rgb  = textureLoad(frameTex, vec2i(in.uv * dims), 0).rgb * U.exposure;
    return vec4f(pow(rgb, vec3f(1.0 / 2.2)), 1.0);
}
