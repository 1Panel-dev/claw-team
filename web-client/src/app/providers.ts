/**
 * 这个文件负责统一注册前端基础 Provider。
 *
 * 之所以单独抽出来，是为了让 main.ts 保持干净，
 * 也方便后面追加国际化、错误边界、埋点等全局能力。
 */
import type { App } from "vue";
import { router } from "@/router";
import { pinia } from "@/stores/pinia";

export function registerProviders(app: App<Element>): void {
    app.use(pinia);
    app.use(router);
}
