export function getRayStateLayout(size) {
    const rayCount = size * size;
    const componentByteLength = rayCount * 16;
    return {
        rayCount,
        posDirByteLength: componentByteLength,
        rngByteLength: componentByteLength,
        rgbLambdaByteLength: componentByteLength,
    };
}

export function createProceduralSplatDrawArgs(raysDrawCount) {
    return {
        vertexCount: 2,
        instanceCount: raysDrawCount / 2,
    };
}
