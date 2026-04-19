import { defineConfig } from "vite";

export default defineConfig({
    root: ".",
    publicDir: "public",
    server: {
        port: 5173,
        strictPort: true,
        host: "127.0.0.1",
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
