/**
 * 这是 clawswarm sendText 出站链路的最小行为测试。
 *
 * 重点验证：
 * 1. CS ID 归一化。
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
    looksLikeClawSwarmCsId,
    normalizeTargetCsId,
    parseAgentDialogueStartPayload,
    resolveClawSwarmMessagingTarget,
    resolveClawSwarmTarget,
    sendClawSwarmText,
} from "../outbound/sendText.js";

const requestMock = vi.mocked(request);

describe("clawswarm sendText", () => {
    it("normalizes bare and prefixed CS IDs", () => {
        expect(normalizeTargetCsId("CSA-0009")).toBe("CSA-0009");
        expect(normalizeTargetCsId("CSU-0001")).toBe("CSU-0001");
        expect(normalizeTargetCsId("csid:csa-0009")).toBe("CSA-0009");
        expect(normalizeTargetCsId("csid:csu-0001")).toBe("CSU-0001");
        expect(normalizeTargetCsId("@CSA-0010")).toBe("CSA-0010");
        expect(normalizeTargetCsId("@CSU-0001")).toBe("CSU-0001");
        expect(normalizeTargetCsId("\"CSA-0010\"")).toBe("CSA-0010");
        expect(normalizeTargetCsId("CSA－0010")).toBe("CSA-0010");
    });

    it("resolves CS IDs for outbound target validation", () => {
        expect(resolveClawSwarmTarget("csid:csa-0009")).toEqual({
            ok: true,
            to: "CSA-0009",
        });
        expect(resolveClawSwarmTarget("csid:csu-0001")).toEqual({
            ok: true,
            to: "CSU-0001",
        });
        expect(resolveClawSwarmTarget("bad-target")).toMatchObject({
            ok: true,
            to: "bad-target",
        });
    });

    it("resolves CS IDs for messaging target resolution", async () => {
        expect(looksLikeClawSwarmCsId("CSA-0010")).toBe(true);
        expect(looksLikeClawSwarmCsId("CSU-0001")).toBe(true);
        expect(looksLikeClawSwarmCsId("@CSA-0010")).toBe(true);
        expect(looksLikeClawSwarmCsId("bad-target")).toBe(false);

        await expect(resolveClawSwarmMessagingTarget({ input: "CSA-0010" })).resolves.toEqual({
            to: "CSA-0010",
            kind: "user",
            display: "CSA-0010",
            source: "normalized",
        });
        await expect(resolveClawSwarmMessagingTarget({ input: "CSU-0001" })).resolves.toEqual({
            to: "CSU-0001",
            kind: "user",
            display: "CSU-0001",
            source: "normalized",
        });
        await expect(resolveClawSwarmMessagingTarget({ input: "bad-target" })).resolves.toBeNull();
    });

    it("parses the structured agent dialogue payload", () => {
        const payload = parseAgentDialogueStartPayload(
            JSON.stringify({
                kind: AGENT_DIALOGUE_START_KIND,
                sourceCsId: "csa-0001",
                topic: "讨论登录接口",
                message: "请确认字段",
                windowSeconds: 300,
                softMessageLimit: 12,
                hardMessageLimit: 20,
            }),
        );
        expect(payload).toEqual({
            kind: AGENT_DIALOGUE_START_KIND,
            sourceCsId: "CSA-0001",
            topic: "讨论登录接口",
            message: "请确认字段",
            windowSeconds: 300,
            softMessageLimit: 12,
            hardMessageLimit: 20,
        });
    });

    it("posts a semantic send-text request to clawswarm backend", async () => {
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

        const result = await sendClawSwarmText({
            ctx: {
                cfg: {},
                to: "CSA-0009",
                text: JSON.stringify({
                    kind: AGENT_DIALOGUE_START_KIND,
                    sourceCsId: "CSA-0001",
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
                    deadLetterFile: "./clawswarm.dlq.jsonl",
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
            sourceCsId: "CSA-0001",
            targetCsId: "CSA-0009",
            topic: "讨论登录接口",
            message: "请确认字段",
        });
        expect(result.messageId).toBe("msg_opening_1");
        expect(result.conversationId).toBe("23");
    });
});
