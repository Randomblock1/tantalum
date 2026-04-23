import assert from "node:assert/strict";
import test from "node:test";

import { createProceduralSplatDrawArgs, getRayStateLayout } from "../../src/backend/webgpu-ray-state.js";

test("getRayStateLayout describes the split WebGPU ray-state buffers", () => {
    assert.deepEqual(getRayStateLayout(8), {
        rayCount: 64,
        posDirByteLength: 64 * 16,
        rngByteLength: 64 * 16,
        rgbLambdaByteLength: 64 * 16,
    });
});

test("createProceduralSplatDrawArgs converts legacy draw counts into instanced line draws", () => {
    assert.deepEqual(createProceduralSplatDrawArgs(8 * 4 * 2), {
        vertexCount: 2,
        instanceCount: 32,
    });
});
