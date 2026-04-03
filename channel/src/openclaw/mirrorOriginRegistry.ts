const LOCAL_ORIGIN_TTL_MS = 2 * 60_000;

const localOriginSessions = new Map<string, number>();

function prune(now = Date.now()): void {
    for (const [sessionKey, expiresAt] of localOriginSessions.entries()) {
        if (expiresAt <= now) {
            localOriginSessions.delete(sessionKey);
        }
    }
}

export function markLocalOriginSession(sessionKey: string, ttlMs = LOCAL_ORIGIN_TTL_MS): void {
    if (!sessionKey.trim()) {
        return;
    }
    prune();
    localOriginSessions.set(sessionKey.trim(), Date.now() + ttlMs);
}

export function isLocalOriginSession(sessionKey: string): boolean {
    prune();
    return localOriginSessions.has(sessionKey.trim());
}

export function clearLocalOriginSession(sessionKey: string): void {
    localOriginSessions.delete(sessionKey.trim());
}

export function clearAllLocalOriginSessionsForTest(): void {
    localOriginSessions.clear();
}
