import { describe, expect, it } from "vitest";

import { AccountConfigSchema } from "../config.js";
import { createGroupDispatchQueue } from "../dispatcher/groupQueue.js";

describe("createGroupDispatchQueue", () => {
    it("serializes tasks with the same account, agent, and session key", async () => {
        const account = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
            limits: {
                maxInFlightRuns: 4,
                perAgentConcurrency: 2,
            },
        });

        const queue = createGroupDispatchQueue(account);
        const events: string[] = [];
        let releaseFirst!: () => void;

        const first = queue.run({
            accountId: "default",
            agentId: "pm",
            sessionKey: "group:pm:conv-1",
            task: async () => {
                events.push("first:start");
                await new Promise<void>((resolve) => {
                    releaseFirst = () => {
                        events.push("first:end");
                        resolve();
                    };
                });
            },
        });

        const second = queue.run({
            accountId: "default",
            agentId: "pm",
            sessionKey: "group:pm:conv-1",
            task: async () => {
                events.push("second:start");
                events.push("second:end");
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events).toEqual(["first:start"]);

        releaseFirst();
        await Promise.all([first, second]);

        expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    });
});
