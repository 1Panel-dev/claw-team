import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

export default defineConfig({
    plugins: [
        vue(),
        AutoImport({
            dts: false,
            resolvers: [ElementPlusResolver({ importStyle: "css", directives: true })],
        }),
        Components({
            dts: false,
            resolvers: [ElementPlusResolver({ importStyle: "css", directives: true })],
        }),
    ],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes("node_modules")) {
                        return;
                    }
                    if (id.includes("element-plus")) {
                        return "vendor-element-plus";
                    }
                    if (id.includes("vue-router") || id.includes("pinia") || id.includes("/vue/")) {
                        return "vendor-vue-core";
                    }
                    if (id.includes("axios")) {
                        return "vendor-http";
                    }
                    return "vendor-misc";
                },
            },
        },
    },
    server: {
        host: "0.0.0.0",
        port: 5173,
    },
});
