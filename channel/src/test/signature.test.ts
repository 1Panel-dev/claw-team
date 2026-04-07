/**
 * 这些测试聚焦签名算法最底层的辅助函数。
 * 目的是尽早发现 canonical string 或哈希格式被意外修改。
 */
import { describe, expect, it } from "vitest";

import { buildCanonicalString, hmacSha256Hex, sha256Hex } from "../security/signature.js";

describe("signature helpers", () => {
    it("builds canonical strings consistently", () => {
        const canonical = buildCanonicalString({
            timestampMs: 1000,
            nonce: "nonce-1",
            method: "POST",
            path: "/clawswarm/v1/inbound",
            bodySha256Hex: sha256Hex(Buffer.from("{\"ok\":true}")),
        });

        expect(canonical).toContain("/clawswarm/v1/inbound");
        expect(hmacSha256Hex("secret-1234567890", canonical)).toHaveLength(64);
    });
});
