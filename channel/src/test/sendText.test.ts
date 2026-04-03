/**
 * 这是 claw-team sendText 出站链路的最小行为测试。
 *
 * 重点验证：
 * 1. CT ID 归一化。
 * 2. messaging/outbound 目标解析需要的公共行为。
 * 3. sendText 是否会把 JSON 语义正确转成调度中心请求。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({
    request: vi.fn(),
}));

import { request } from "undici";

import {
    AGENT_DIALOGUE_START_KIND,
    looksLikeClawTeamCtId,
    normalizeTargetCtId,
    parseAgentDialogueStartPayload,
    resolveClawTeamMessagingTarget,
    resolveClawTeamTarget,
    sendClawTeamText,
} from "../outbound/sendText.js";

const requestMock = vi.mocked(request);

describe("claw-team sendText", () => {
    it("normalizes bare and prefixed CT IDs", () => {
        expect(normalizeTargetCtId("CTA-0009")).toBe("CTA-0009");
        expect(normalizeTargetCtId("CTU-0001")).toBe("CTU-0001");
        expect(normalizeTargetCtId("ctid:cta-0009")).toBe("CTA-0009");
        expect(normalizeTargetCtId("ctid:ctu-0001")).toBe("CTU-0001");
        expect(normalizeTargetCtId("@CTA-0010")).toBe("CTA-0010");
        expect(normalizeTargetCtId("@CTU-0001")).toBe("CTU-0001");
        expect(normalizeTargetCtId("\"CTA-0010\"")).toBe("CTA-0010");
        expect(normalizeTargetCtId("CTA－0010")).toBe("CTA-0010");
    });

    it("resolves CT IDs for outbound target validation", () => {
        expect(resolveClawTeamTarget("ctid:cta-0009")).toEqual({
            ok: true,
            to: "CTA-0009",
        });
        expect(resolveClawTeamTarget("ctid:ctu-0001")).toEqual({
            ok: true,
            to: "CTU-0001",
        });
        expect(resolveClawTeamTarget("bad-target")).toMatchObject({
            ok: true,
            to: "bad-target",
        });
    });

    it("resolves CT IDs for messaging target resolution", async () => {
        expect(looksLikeClawTeamCtId("CTA-0010")).toBe(true);
        expect(looksLikeClawTeamCtId("CTU-0001")).toBe(true);
        expect(looksLikeClawTeamCtId("@CTA-0010")).toBe(true);
        expect(looksLikeClawTeamCtId("bad-target")).toBe(false);

        await expect(resolveClawTeamMessagingTarget({ input: "CTA-0010" })).resolves.toEqual({
            to: "CTA-0010",
            kind: "user",
            display: "CTA-0010",
            source: "normalized",
        });
        await expect(resolveClawTeamMessagingTarget({ input: "CTU-0001" })).resolves.toEqual({
            to: "CTU-0001",
            kind: "user",
            display: "CTU-0001",
            source: "normalized",
        });
        await expect(resolveClawTeamMessagingTarget({ input: "bad-target" })).resolves.toBeNull();
    });

    it("parses the structured agent dialogue payload", () => {
        const payload = parseAgentDialogueStartPayload(
            JSON.stringify({
                kind: AGENT_DIALOGUE_START_KIND,
                sourceCtId: "cta-0001",
                topic: "讨论登录接口",
                message: "请确认字段",
                windowSeconds: 300,
                softMessageLimit: 12,
                hardMessageLimit: 20,
            }),
        );
        expect(payload).toEqual({
            kind: AGENT_DIALOGUE_START_KIND,
            sourceCtId: "CTA-0001",
            topic: "讨论登录接口",
            message: "请确认字段",
            windowSeconds: 300,
            softMessageLimit: 12,
            hardMessageLimit: 20,
        });
    });

    it("posts a semantic send-text request to claw-team backend", async () => {
        requestMock.mockResolvedValueOnce({
            statusCode: 200,
            body: {
                text: async () =>
                    JSON.stringify({
                        ok: true,
                        dialogueId: 11,
                        conversationId: 23,
                        openingMessageId: "msg_opening_1",
                    }),
            },
        } as never);

        const logger = {
            child: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        } as any;
        logger.child.mockReturnValue(logger);

        const result = await sendClawTeamText({
            ctx: {
                cfg: {},
                to: "CTA-0009",
                text: JSON.stringify({
                    kind: AGENT_DIALOGUE_START_KIND,
                    sourceCtId: "CTA-0001",
                    topic: "讨论登录接口",
                    message: "请确认字段",
                }),
            },
            account: {
                enabled: true,
                baseUrl: "https://example.com",
                outboundToken: "outbound-token-123",
                inboundSigningSecret: "inbound-signing-secret-123",
                webchatMirror: {
                    includeIntermediateMessages: true,
                },
                gateway: {},
                limits: {
                    maxBroadcastAgents: 50,
                    maxInFlightRuns: 20,
                    perAgentConcurrency: 2,
                    maxBodyBytes: 1024 * 1024,
                    timeSkewMs: 5 * 60 * 1000,
                    nonceTtlSeconds: 600,
                },
                idempotency: {
                    mode: "memory",
                    ttlSeconds: 3600,
                },
                retry: {
                    maxAttempts: 10,
                    baseDelayMs: 500,
                    maxDelayMs: 60_000,
                    jitterRatio: 0.2,
                    deadLetterFile: "./claw-team.dlq.jsonl",
                    callbackTimeoutMs: 8_000,
                },
            },
            logger,
        });

        expect(requestMock).toHaveBeenCalledTimes(1);
        const [, options] = requestMock.mock.calls[0]!;
        expect(options?.method).toBe("POST");
        expect(options?.headers).toMatchObject({
            authorization: "Bearer outbound-token-123",
        });
        expect(JSON.parse(String(options?.body))).toEqual({
            kind: "agent_dialogue.start",
            sourceCtId: "CTA-0001",
            targetCtId: "CTA-0009",
            topic: "讨论登录接口",
            message: "请确认字段",
        });
        expect(result.messageId).toBe("msg_opening_1");
        expect(result.conversationId).toBe("23");
    });
});
