export function createUnaryCache(createValue) {
    const cache = new WeakMap();
    return function getOrCreate(first) {
        let value = cache.get(first);
        if (value === undefined) {
            value = createValue(first);
            cache.set(first, value);
        }
        return value;
    };
}

export function createBinaryCache(createValue) {
    const outer = new WeakMap();
    return function getOrCreate(first, second) {
        let inner = outer.get(first);
        if (!inner) {
            inner = new WeakMap();
            outer.set(first, inner);
        }

        let value = inner.get(second);
        if (value === undefined) {
            value = createValue(first, second);
            inner.set(second, value);
        }
        return value;
    };
}

export function createTernaryCache(createValue) {
    const outer = new WeakMap();
    return function getOrCreate(first, second, third) {
        let middle = outer.get(first);
        if (!middle) {
            middle = new WeakMap();
            outer.set(first, middle);
        }

        let inner = middle.get(second);
        if (!inner) {
            inner = new WeakMap();
            middle.set(second, inner);
        }

        let value = inner.get(third);
        if (value === undefined) {
            value = createValue(first, second, third);
            inner.set(third, value);
        }
        return value;
    };
}
