/**
 * 这些测试保护 Gateway 运行参数的解析规则。
 * 重点是确认“账号配置优先、环境变量兜底”的策略不会被无意改坏。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
    AccountConfigSchema,
    channelAccountConfigSchema,
    channelConfigSchema,
    channelConfigUiHints,
    pluginConfigSchema,
    resolveGatewayRuntimeConfig,
} from "../config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

describe("resolveGatewayRuntimeConfig", () => {
    it("prefers account config over environment variables", () => {
        process.env.OPENCLAW_GATEWAY_HTTP_URL = "https://env.example.com";
        process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
        process.env.OPENCLAW_GATEWAY_MODEL = "env-model";
        process.env.OPENCLAW_GATEWAY_STREAM = "0";
        process.env.OPENCLAW_GATEWAY_INSECURE_TLS = "0";

        const account = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
            gateway: {
                baseUrl: "https://account.example.com",
                token: "account-token",
                model: "openclaw",
                stream: true,
                allowInsecureTls: true,
            },
        });

        expect(resolveGatewayRuntimeConfig(account)).toEqual({
            baseUrl: "https://account.example.com",
            token: "account-token",
            model: "openclaw",
            transport: "auto",
            stream: true,
            allowInsecureTls: true,
        });
    });

    it("falls back to environment variables when account config is absent", () => {
        process.env.OPENCLAW_GATEWAY_HTTP_URL = "https://env.example.com";
        process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
        process.env.OPENCLAW_GATEWAY_MODEL = "env-model";
        process.env.OPENCLAW_GATEWAY_STREAM = "0";
        process.env.OPENCLAW_GATEWAY_INSECURE_TLS = "1";

        const account = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
        });

        expect(resolveGatewayRuntimeConfig(account)).toEqual({
            baseUrl: "https://env.example.com",
            token: "env-token",
            model: "env-model",
            transport: "auto",
            stream: false,
            allowInsecureTls: true,
        });
    });

    it("supports explicit plugin_runtime transport selection", () => {
        const account = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
            gateway: {
                baseUrl: "https://gateway.example.com",
                transport: "plugin_runtime",
            },
        });

        expect(resolveGatewayRuntimeConfig(account)).toEqual({
            baseUrl: "https://gateway.example.com",
            token: undefined,
            model: "openclaw",
            transport: "plugin_runtime",
            stream: true,
            allowInsecureTls: false,
        });
    });

    it("supports explicit auto transport selection", () => {
        const account = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
            gateway: {
                baseUrl: "https://gateway.example.com",
                transport: "auto",
            },
        });

        expect(resolveGatewayRuntimeConfig(account)).toEqual({
            baseUrl: "https://gateway.example.com",
            token: undefined,
            model: "openclaw",
            transport: "auto",
            stream: true,
            allowInsecureTls: false,
        });
    });
});

describe("config manifest schemas", () => {
    it("uses nested gateway fields consistently in plugin, channel, and account schemas", () => {
        const accountSchema = pluginConfigSchema.properties.accounts.additionalProperties;
        const gatewaySchema = accountSchema.properties.gateway;
        const accountProperties = accountSchema.properties as Record<string, unknown>;
        const channelProperties = channelAccountConfigSchema.properties as Record<string, unknown>;
        const channelRootProperties = channelConfigSchema.properties as Record<string, unknown>;

        expect(gatewaySchema).toBeDefined();
        expect(gatewaySchema.properties.baseUrl.type).toBe("string");
        expect(gatewaySchema.properties.token.type).toBe("string");
        expect(accountProperties.gatewayBaseUrl).toBeUndefined();
        expect(accountProperties.gatewayToken).toBeUndefined();

        expect(channelAccountConfigSchema.properties.gateway).toBeDefined();
        expect(channelProperties.gatewayBaseUrl).toBeUndefined();
        expect(channelProperties.gatewayToken).toBeUndefined();
        expect(channelRootProperties.accounts).toBeDefined();
        expect(channelRootProperties.gateway).toBeUndefined();
    });

    it("registers wildcard uiHints for dynamic account token fields", () => {
        expect(channelConfigUiHints["accounts.*.outboundToken"]).toEqual({
            sensitive: true,
            label: "Outbound Token",
        });
        expect(channelConfigUiHints["accounts.*.inboundSigningSecret"]).toEqual({
            sensitive: true,
            label: "Inbound Signing Secret",
        });
        expect(channelConfigUiHints["accounts.*.gateway.token"]).toEqual({
            sensitive: true,
            label: "Gateway Token",
        });
    });
});
