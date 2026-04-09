/**
 * 统一的 HTTP 客户端。
 *
 * 集中处理 baseURL、超时、凭证和错误消息归一化。
 */
import axios from "axios";
import { resolveApiBaseUrl } from "@/api/baseUrl";

export const apiClient = axios.create({
    baseURL: resolveApiBaseUrl(),
    timeout: 10000,
    withCredentials: true,
});

apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        const message = error?.response?.data?.message;
        const detail = error?.response?.data?.detail;
        const fallbackMessage = error?.message;

        if (typeof message === "string" && message.trim()) {
            return Promise.reject(new Error(message));
        }
        if (typeof detail === "string" && detail.trim()) {
            return Promise.reject(new Error(detail));
        }
        if (typeof fallbackMessage === "string" && fallbackMessage.trim()) {
            return Promise.reject(new Error(fallbackMessage));
        }
        return Promise.reject(new Error("Request failed"));
    },
);
