export function createManagedTextureHandle({ texture, view, width, height, channels }) {
    let destroyed = false;
    return {
        texture,
        view,
        width,
        height,
        channels,
        destroy() {
            if (destroyed) return false;
            destroyed = true;
            if (texture && typeof texture.destroy == "function") texture.destroy();
            return true;
        },
    };
}
