/**
 * 这个文件负责 webhook 入站签名校验。
 * 它同时覆盖完整性校验、时间窗校验和 nonce 防重放。
 */
import crypto from "node:crypto";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { AccountConfig } from "../config.js";

// 这是从请求头里解析出的签名相关字段。
export type SignatureHeaders = {
    accountId: string;
    timestampMs: number;
    nonce: string;
    signatureHex: string;
};

// 先对 body 做 sha256，避免大 body 直接进 HMAC 拼接逻辑。
export function sha256Hex(data: Uint8Array): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

export function hmacSha256Hex(secret: string, msg: string): string {
    return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

// 用 timingSafeEqual 避免签名比较时出现时序侧信道。
function timingSafeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// 统一构造签名原文，前后端只要共享这一规则就能互认签名。
export function buildCanonicalString(params: {
    timestampMs: number;
    nonce: string;
    method: string;
    path: string;
    bodySha256Hex: string;
}): string {
    return `${params.timestampMs}\n${params.nonce}\n${params.method}\n${params.path}\n${params.bodySha256Hex}\n`;
}

// 允许头名有一定大小写差异，降低接入方实现成本。
export function parseSignatureHeaders(req: any): SignatureHeaders | null {
    const accountId = String(req.headers?.["x-oc-accountid"] ?? req.headers?.["X-OC-AccountId"] ?? "default");
    const tsRaw = req.headers?.["x-oc-timestamp"] ?? req.headers?.["X-OC-Timestamp"];
    const nonce = String(req.headers?.["x-oc-nonce"] ?? req.headers?.["X-OC-Nonce"] ?? "");
    const sigRaw = String(req.headers?.["x-oc-signature"] ?? req.headers?.["X-OC-Signature"] ?? "");

    const timestampMs = Number(tsRaw);
    if (!Number.isFinite(timestampMs)) return null;
    if (!nonce) return null;
    if (!sigRaw) return null;

    const signatureHex = sigRaw.startsWith("v1=") ? sigRaw.slice(3) : sigRaw;
    if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return null;

    return { accountId, timestampMs, nonce, signatureHex };
}

export async function verifyInboundSignature(params: {
    req: any;
    rawBody: Uint8Array;
    pathname: string;
    nowMs: number;
    accountConfig: AccountConfig;
    nonceStore: IdempotencyStore;
}): Promise<{ ok: true; headers: SignatureHeaders } | { ok: false; status: number; reason: string }> {
    const h = parseSignatureHeaders(params.req);
    if (!h) {
        return { ok: false, status: 401, reason: "missing_or_invalid_signature_headers" };
    }

    // 超出时间窗口就拒绝，避免旧请求被重放。
    const skew = Math.abs(params.nowMs - h.timestampMs);
    if (skew > params.accountConfig.limits.timeSkewMs) {
        return { ok: false, status: 401, reason: "timestamp_skew" };
    }

    // nonce 只允许首次出现，和时间窗一起构成防重放方案。
    const nonceKey = `oc:nonce:${h.accountId}:${h.nonce}`;
    const nonceOk = await params.nonceStore.setIfNotExists(nonceKey, params.accountConfig.limits.nonceTtlSeconds);
    if (!nonceOk) {
        return { ok: false, status: 401, reason: "nonce_replay" };
    }

    const method = String(params.req.method ?? "").toUpperCase();
    const bodySha = sha256Hex(params.rawBody);
    const canonical = buildCanonicalString({
        timestampMs: h.timestampMs,
        nonce: h.nonce,
        method,
        path: params.pathname,
        bodySha256Hex: bodySha,
    });
    const expected = hmacSha256Hex(params.accountConfig.inboundSigningSecret, canonical);

    // 最终用常量时间比较来确认签名完全一致。
    if (!timingSafeEqualHex(expected.toLowerCase(), h.signatureHex.toLowerCase())) {
        return { ok: false, status: 401, reason: "bad_signature" };
    }

    return { ok: true, headers: h };
}
