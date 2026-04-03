import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    noExternal: ["zod", "ioredis", "undici"],
    external: ["openclaw", /^openclaw\//],
});
