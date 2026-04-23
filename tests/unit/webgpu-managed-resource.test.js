import assert from "node:assert/strict";
import test from "node:test";

import { createManagedTextureHandle } from "../../src/backend/webgpu-managed-resource.js";

test("createManagedTextureHandle destroys the underlying texture exactly once", () => {
    let destroyCalls = 0;
    const handle = createManagedTextureHandle({
        texture: {
            destroy() {
                destroyCalls++;
            },
        },
        view: {},
        width: 64,
        height: 32,
    });

    handle.destroy();
    handle.destroy();

    assert.equal(handle.width, 64);
    assert.equal(handle.height, 32);
    assert.equal(destroyCalls, 1);
});
