/**
 * 这个文件负责幂等去重存储。
 * 任何“同一消息不要重复执行”的约束，都应该通过这里统一实现。
 */
import Redis from "ioredis";
import type { Logger } from "../observability/logger.js";

export interface IdempotencyStore {
    // 如果 key 首次写入成功则返回 true；如果已存在则返回 false。
    setIfNotExists(key: string, ttlSeconds: number): Promise<boolean>;
    close(): Promise<void>;
}

// 内存实现适合本地开发和单进程测试。
class MemoryIdempotencyStore implements IdempotencyStore {
    private map = new Map<string, number>();

    constructor(private logger: Logger) {}

    // 这是一个简单的懒 GC：每次写入前顺手清掉过期数据。
    private gc(now: number): void {
        for (const [k, exp] of this.map) {
            if (exp <= now) this.map.delete(k);
        }
    }

    async setIfNotExists(key: string, ttlSeconds: number): Promise<boolean> {
        const now = Date.now();
        this.gc(now);
        const exp = this.map.get(key);
        if (exp && exp > now) return false;
        this.map.set(key, now + ttlSeconds * 1000);
        return true;
    }

    async close(): Promise<void> {
        this.map.clear();
        this.logger.info({}, "memory idempotency store closed");
    }
}

// Redis 实现适合多实例部署，能让不同进程共享去重结果。
class RedisIdempotencyStore implements IdempotencyStore {
    private redis: Redis;

    constructor(redisUrl: string, private logger: Logger) {
        this.redis = new Redis(redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableReadyCheck: true,
        });
    }

    async setIfNotExists(key: string, ttlSeconds: number): Promise<boolean> {
        // lazyConnect 模式下，第一次真正使用时再建连接。
        if (this.redis.status === "wait" || this.redis.status === "end") {
            await this.redis.connect();
        }
        const res = await this.redis.set(key, "1", "EX", ttlSeconds, "NX");
        return res === "OK";
    }

    async close(): Promise<void> {
        try {
            await this.redis.quit();
        } catch {
            // ignore
        }
        this.logger.info({}, "redis idempotency store closed");
    }
}

// 工厂函数根据配置返回合适的去重实现。
export function createIdempotencyStore(params: {
    mode: "memory" | "redis";
    redisUrl?: string;
    logger: Logger;
}): IdempotencyStore {
    if (params.mode === "redis" && params.redisUrl) {
        params.logger.info({ redisUrl: redactUrl(params.redisUrl) }, "using redis idempotency store");
        return new RedisIdempotencyStore(params.redisUrl, params.logger);
    }
    params.logger.info({}, "using memory idempotency store");
    return new MemoryIdempotencyStore(params.logger);
}

// messageId + agentId 是当前插件里最重要的幂等粒度。
export function dedupeKeyForMessageAgent(params: {
    accountId: string;
    messageId: string;
    agentId: string;
}): string {
    return `oc:dedupe:${params.accountId}:${params.messageId}:${params.agentId}`;
}

// 打日志时不要把 Redis 密码明文打出来。
function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        if (u.password) u.password = "****";
        return u.toString();
    } catch {
        return "<invalid-url>";
    }
}
