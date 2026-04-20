/**
 * Minimal WGSL include expander. Resolves `#include "name"` against a map of
 * already-imported module sources. Non-recursive guard via a visited set.
 *
 * Typical use:
 *   import rand     from "../../shaders/wgsl/rand.wgsl?raw";
 *   import preamble from "../../shaders/wgsl/preamble.wgsl?raw";
 *   import init     from "../../shaders/wgsl/init.wgsl?raw";
 *   const src = expandIncludes("init", { preamble, rand, init });
 */

const INCLUDE_RE = /^\s*#include\s+"([^"]+)"\s*$/;

export function expandIncludes(entryName, modules) {
    const visited = new Set();
    function expand(name) {
        if (visited.has(name)) throw new Error(`Circular include: ${name}`);
        const src = modules[name];
        if (src === undefined) throw new Error(`Unknown WGSL module: ${name}`);
        visited.add(name);
        const lines = [];
        for (const line of src.split("\n")) {
            const m = INCLUDE_RE.exec(line);
            if (m) lines.push(expand(m[1]));
            else lines.push(line);
        }
        visited.delete(name);
        return lines.join("\n");
    }
    return expand(entryName);
}
