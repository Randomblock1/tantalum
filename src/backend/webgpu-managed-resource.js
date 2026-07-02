export function createManagedTextureHandle({ texture, view, width, height, channels, format }) {
    let destroyed = false;
    return {
        texture,
        view,
        width,
        height,
        channels,
        format,
        destroy() {
            if (destroyed) return false;
            destroyed = true;
            if (texture && typeof texture.destroy == "function") texture.destroy();
            return true;
        },
    };
}
