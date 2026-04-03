import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const devProxyTarget = env.VITE_DEV_API_PROXY_TARGET || "http://127.0.0.1:18080";

    return {
    plugins: [
        vue(),
        AutoImport({
            resolvers: [ElementPlusResolver({ importStyle: "css", directives: true })],
        }),
        Components({
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
        proxy: {
            "/api": {
                target: devProxyTarget,
                changeOrigin: true,
            },
            "/ws": {
                target: devProxyTarget,
                changeOrigin: true,
                ws: true,
            },
        },
    },
    };
});
