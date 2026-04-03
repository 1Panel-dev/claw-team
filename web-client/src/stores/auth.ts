import { defineStore } from "pinia";

import { fetchCurrentUser, login as loginRequest, logout as logoutRequest, updateProfile as updateProfileRequest, type LoginPayload, type UpdateProfilePayload } from "@/api/auth";

type AuthUser = {
    id: string;
    username: string;
    display_name: string;
    using_default_password: boolean;
};

type AuthState = {
    user: AuthUser | null;
    initialized: boolean;
    loadingMe: Promise<AuthUser | null> | null;
};

export const useAuthStore = defineStore("auth", {
    state: (): AuthState => ({
        user: null,
        initialized: false,
        loadingMe: null,
    }),
    getters: {
        isAuthenticated: (state) => !!state.user,
    },
    actions: {
        async ensureLoaded() {
            if (this.initialized) {
                return this.user;
            }
            if (this.loadingMe) {
                return this.loadingMe;
            }
            this.loadingMe = (async () => {
                try {
                    this.user = await fetchCurrentUser();
                } catch {
                    this.user = null;
                } finally {
                    this.initialized = true;
                    this.loadingMe = null;
                }
                return this.user;
            })();
            return this.loadingMe;
        },
        async login(payload: LoginPayload) {
            const user = await loginRequest(payload);
            this.user = user;
            this.initialized = true;
            return user;
        },
        async logout() {
            await logoutRequest();
            this.user = null;
            this.initialized = true;
        },
        async updateProfile(payload: UpdateProfilePayload) {
            const user = await updateProfileRequest(payload);
            this.user = user;
            this.initialized = true;
            return user;
        },
    },
});
