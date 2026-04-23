const DEFAULT_CAPACITY = 64 * 1024;

function uniformUsageFlags() {
    const usage = globalThis.GPUBufferUsage;
    if (usage) return usage.UNIFORM | usage.COPY_DST;
    return 0;
}

function alignTo(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

function viewBytes(source) {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    throw new Error("UniformRing.write expects an ArrayBuffer or typed array");
}

export function createUniformRing(device, opts = {}) {
    const alignment = opts.alignment || device.limits?.minUniformBufferOffsetAlignment || 256;
    const capacity = opts.capacity || DEFAULT_CAPACITY;
    const buffer = device.createBuffer({
        size: capacity,
        usage: uniformUsageFlags(),
    });
    const scratch = new Uint8Array(capacity);
    let cursor = 0;

    function write(source) {
        const bytes = viewBytes(source);
        const offset = cursor;
        const next = offset + alignTo(bytes.byteLength, alignment);
        if (next > capacity) {
            throw new Error(`UniformRing capacity exceeded: ${next} > ${capacity}`);
        }
        scratch.set(bytes, offset);
        cursor = next;
        return { buffer, offset, size: bytes.byteLength };
    }

    return {
        buffer,
        get usedBytes() {
            return cursor;
        },
        reset() {
            cursor = 0;
        },
        write,
        flush(queue) {
            if (cursor === 0) return { uniformWrites: 0, uniformBytes: 0 };
            queue.writeBuffer(buffer, 0, scratch.buffer, 0, cursor);
            return { uniformWrites: 1, uniformBytes: cursor };
        },
    };
}
