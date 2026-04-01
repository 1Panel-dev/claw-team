function resolveBrowserOrigin(): string {
    if (typeof window === "undefined" || !window.location?.origin) {
        return "http://127.0.0.1:8080";
    }
    return window.location.origin;
}

export function resolveApiBaseUrl(): string {
    return import.meta.env.VITE_API_BASE_URL ?? resolveBrowserOrigin();
}

export function resolveWebSocketBaseUrl(): string {
    return resolveApiBaseUrl().replace(/^http/i, "ws");
}
