/**
 * 这里封装前端统一的 HTTP 客户端。
 *
 * 后面如果要增加鉴权、全局错误处理、请求日志或切换 baseURL，
 * 优先都在这里做，而不是散落在页面组件里。
 */
import axios from "axios";
import { resolveApiBaseUrl } from "@/api/baseUrl";

export const apiClient = axios.create({
    baseURL: resolveApiBaseUrl(),
    timeout: 10000,
});
