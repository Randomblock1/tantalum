import assert from "node:assert/strict";
import test from "node:test";

import { createBinaryCache, createTernaryCache, createUnaryCache } from "../../src/backend/webgpu-bind-group-cache.js";

test("createUnaryCache memoizes by object identity", () => {
    const seen = [];
    const cache = createUnaryCache((key) => {
        const value = { key };
        seen.push(value);
        return value;
    });

    const a = {};
    const b = {};

    assert.equal(cache(a), cache(a));
    assert.notEqual(cache(a), cache(b));
    assert.equal(seen.length, 2);
});

test("createBinaryCache memoizes by both object identities", () => {
    const cache = createBinaryCache((left, right) => ({ left, right }));
    const a = {};
    const b = {};
    const c = {};

    assert.equal(cache(a, b), cache(a, b));
    assert.notEqual(cache(a, b), cache(a, c));
    assert.notEqual(cache(a, b), cache(c, b));
});

test("createTernaryCache isolates init bindings by spectrum resource identity", () => {
    const cache = createTernaryCache((stateIn, stateOut, spectrum) => ({ stateIn, stateOut, spectrum }));
    const stateIn = {};
    const stateOut = {};
    const spectrumA = {};
    const spectrumB = {};

    assert.equal(cache(stateIn, stateOut, spectrumA), cache(stateIn, stateOut, spectrumA));
    assert.notEqual(cache(stateIn, stateOut, spectrumA), cache(stateIn, stateOut, spectrumB));
});
