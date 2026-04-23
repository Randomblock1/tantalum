import assert from "node:assert/strict";
import test from "node:test";

import { createUniformRing } from "../../src/backend/webgpu-uniform-ring.js";

function createFakeDevice(alignment = 256) {
    const buffers = [];
    return {
        buffers,
        limits: { minUniformBufferOffsetAlignment: alignment },
        createBuffer(descriptor) {
            const buffer = { descriptor, id: buffers.length + 1 };
            buffers.push(buffer);
            return buffer;
        },
    };
}

function createFakeQueue() {
    const writes = [];
    return {
        writes,
        writeBuffer(buffer, offset, source, sourceOffset, size) {
            writes.push({ buffer, offset, source, sourceOffset, size });
        },
    };
}

test("createUniformRing aligns allocations to the device uniform offset alignment", () => {
    const ring = createUniformRing(createFakeDevice(256), { capacity: 1024 });

    const first = ring.write(new Float32Array([1, 2, 3, 4]));
    const second = ring.write(new Uint32Array([5, 6, 7, 8]));

    assert.equal(first.offset, 0);
    assert.equal(first.size, 16);
    assert.equal(second.offset, 256);
    assert.equal(second.size, 16);
    assert.equal(ring.usedBytes, 512);
});

test("createUniformRing flushes packed frame uniforms with one queue write", () => {
    const device = createFakeDevice(256);
    const queue = createFakeQueue();
    const ring = createUniformRing(device, { capacity: 1024 });

    ring.write(new Float32Array([1, 2, 3, 4]));
    ring.write(new Uint32Array([5, 6, 7, 8]));

    const stats = ring.flush(queue);

    assert.equal(queue.writes.length, 1);
    assert.equal(queue.writes[0].buffer, ring.buffer);
    assert.equal(queue.writes[0].offset, 0);
    assert.equal(queue.writes[0].sourceOffset, 0);
    assert.equal(queue.writes[0].size, 512);
    assert.deepEqual(stats, { uniformWrites: 1, uniformBytes: 512 });
});

test("createUniformRing resets allocations between frames", () => {
    const queue = createFakeQueue();
    const ring = createUniformRing(createFakeDevice(128), { capacity: 512 });

    assert.equal(ring.write(new Float32Array([1, 2, 3, 4])).offset, 0);
    ring.flush(queue);
    ring.reset();

    assert.equal(ring.write(new Float32Array([5, 6, 7, 8])).offset, 0);
    assert.equal(ring.usedBytes, 128);
});

test("createUniformRing rejects frames that exceed its fixed capacity", () => {
    const ring = createUniformRing(createFakeDevice(256), { capacity: 256 });

    ring.write(new Float32Array([1, 2, 3, 4]));

    assert.throws(() => ring.write(new Float32Array([5, 6, 7, 8])), /capacity exceeded/);
});
