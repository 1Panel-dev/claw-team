/**
 * 应用路由定义。
 *
 * 这里集中管理公开页、主框架页以及登录态守卫。
 */
import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { pinia } from "@/stores/pinia";

const LoginPage = () => import("@/pages/login/LoginPage.vue");
const MainLayout = () => import("@/pages/frame/MainLayout.vue");
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
