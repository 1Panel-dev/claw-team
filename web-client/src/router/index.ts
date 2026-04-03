/**
 * 这里定义 Web Client 的路由骨架。
 *
 * 路由从第一天就按长期产品模块划分：
 * 1. 消息
 * 2. OpenClaw 管理
 * 3. 任务
 * 4. 设置
 *
 * 这样第一阶段虽然只有消息模块真正落地，
 * 但后续扩展不会从“聊天 demo”再重构成“完整应用”。
 */
import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { pinia } from "@/stores/pinia";

const LoginPage = () => import("@/pages/login/LoginPage.vue");
const MainLayout = () => import("@/layouts/MainLayout.vue");
const MessagesPage = () => import("@/pages/messages/MessagesPage.vue");
const OpenClawsPage = () => import("@/pages/openclaws/OpenClawsPage.vue");
const TasksPage = () => import("@/pages/tasks/TasksPage.vue");
const SettingsPage = () => import("@/pages/settings/SettingsPage.vue");

export const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: "/login",
            component: LoginPage,
            meta: { public: true },
        },
        {
            path: "/",
            redirect: "/messages",
        },
        {
            path: "/",
            component: MainLayout,
            children: [
                {
                    path: "messages",
                    component: MessagesPage,
                },
                {
                    path: "messages/conversation/:conversationId",
                    component: MessagesPage,
                    props: true,
                },
                {
                    path: "openclaws",
                    component: OpenClawsPage,
                },
                {
                    path: "tasks",
                    component: TasksPage,
                },
                {
                    path: "settings",
                    component: SettingsPage,
                },
            ],
        },
    ],
});

router.beforeEach(async (to) => {
    const authStore = useAuthStore(pinia);

    if (to.meta.public) {
        await authStore.ensureLoaded();
        if (to.path === "/login" && authStore.isAuthenticated) {
            return "/messages";
        }
        return true;
    }

    await authStore.ensureLoaded();
    if (authStore.isAuthenticated) {
        return true;
    }
    return {
        path: "/login",
        query: to.fullPath !== "/login" ? { redirect: to.fullPath } : {},
    };
});
