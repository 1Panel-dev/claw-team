import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureOpenClawCliRuntime, runOpenClawCli } from "../openclaw/openclawCli.js";

describe("runOpenClawCli", () => {
    beforeEach(() => {
        configureOpenClawCliRuntime(undefined);
    });

    afterEach(() => {
        configureOpenClawCliRuntime(undefined);
    });

    it("prefers plugin runtime system commands when available", async () => {
        const runCommandWithTimeout = vi.fn(async () => ({
            stdout: JSON.stringify([{ id: "main", name: "main" }]),
        }));
        configureOpenClawCliRuntime({
            runCommandWithTimeout,
        });

        const result = await runOpenClawCli(["agents", "list", "--json"]);

        expect(result).toContain("\"id\":\"main\"");
        expect(runCommandWithTimeout).toHaveBeenCalledWith(
            ["openclaw", "agents", "list", "--json"],
            expect.objectContaining({
                timeoutMs: 60000,
            }),
        );
    });

    it("treats timed out runtime helper results as failures", async () => {
        const runCommandWithTimeout = vi.fn(async () => ({
            stdout: "",
            stderr: "timed out",
            code: null,
            signal: "SIGKILL",
            killed: true,
            termination: "timeout",
            noOutputTimedOut: false,
        }));
        configureOpenClawCliRuntime({
            runCommandWithTimeout,
        });

        await expect(runOpenClawCli(["agents", "add", "demo", "--json"])).rejects.toThrow(
            /openclaw_runtime_command_failed/,
        );
    });
});
