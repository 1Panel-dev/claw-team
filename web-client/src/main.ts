/**
 * 前端入口文件。
 *
 * 负责创建应用实例、注册全局依赖，并加载基础样式与主题。
 */
import { createApp } from "vue";

import App from "@/pages/frame/AppRoot.vue";
import { i18n } from "@/i18n";
import { router } from "@/router";
import { pinia } from "@/stores/pinia";
import { applyInitialTheme } from "@/theme/applyTheme";

import "@/styles/reset.css";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/page-container.css";

const app = createApp(App);

app.use(pinia);
app.use(router);
app.use(i18n);
applyInitialTheme();

app.mount("#app");
