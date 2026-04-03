import { apiClient } from "@/api/client";

export type AuthUserApi = {
    id: string;
    username: string;
    display_name: string;
    using_default_password: boolean;
};

export type LoginPayload = {
    username: string;
    password: string;
};

export type UpdateProfilePayload = {
    display_name: string;
    current_password?: string;
    new_password?: string;
};

export async function login(payload: LoginPayload) {
    const response = await apiClient.post<AuthUserApi>("/api/auth/login", payload);
    return response.data;
}

export async function logout() {
    await apiClient.post("/api/auth/logout");
}

export async function fetchCurrentUser() {
    const response = await apiClient.get<AuthUserApi>("/api/auth/me");
    return response.data;
}

export async function updateProfile(payload: UpdateProfilePayload) {
    const response = await apiClient.put<AuthUserApi>("/api/auth/profile", payload);
    return response.data;
}
