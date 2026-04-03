type JsonRecord = Record<string, unknown>;
type RuntimeSystemResult =
    | string
    | {
          stdout?: string;
          output?: string;
          stderr?: string;
          code?: number | null;
          signal?: string | null;
          killed?: boolean;
          termination?: string | null;
          noOutputTimedOut?: boolean;
      };
type RuntimeSystemLike = {
    runCommandWithTimeout?: (argv: string[], opts?: { timeoutMs?: number }) => Promise<RuntimeSystemResult>;
};

let runtimeSystem: RuntimeSystemLike | undefined;

function isRuntimeSystemProcessResult(result: RuntimeSystemResult): result is Exclude<RuntimeSystemResult, string> {
    return typeof result === "object" && result !== null;
}

function ensureRuntimeCommandSucceeded(result: RuntimeSystemResult, command: string, args: string[]) {
    if (!isRuntimeSystemProcessResult(result)) {
        return;
    }

    const failed =
        result.killed === true ||
        (typeof result.code === "number" && result.code !== 0) ||
        result.termination === "timeout" ||
        (typeof result.signal === "string" && result.signal.length > 0 && result.signal !== "SIGTERM") ||
        result.noOutputTimedOut === true;

    if (!failed) {
        return;
    }

    throw new Error(
        JSON.stringify({
            error: "openclaw_runtime_command_failed",
            command,
            args,
            code: result.code ?? null,
            signal: result.signal ?? null,
            killed: result.killed ?? false,
            termination: result.termination ?? null,
            noOutputTimedOut: result.noOutputTimedOut ?? false,
            stderr: result.stderr ?? "",
            stdout: result.stdout ?? result.output ?? "",
        }),
    );
}

export function configureOpenClawCliRuntime(system?: RuntimeSystemLike) {
    runtimeSystem = system;
}

function extractRuntimeOutput(result: RuntimeSystemResult): string {
    if (typeof result === "string") {
        return result;
    }
    if (typeof result?.stdout === "string") {
        return result.stdout;
    }
    if (typeof result?.output === "string") {
        return result.output;
    }
    return "";
}

export async function runOpenClawCli(args: string[]): Promise<string> {
    if (runtimeSystem?.runCommandWithTimeout) {
        try {
            const result = await runtimeSystem.runCommandWithTimeout(["openclaw", ...args], { timeoutMs: 60000 });
            ensureRuntimeCommandSucceeded(result, "openclaw", args);
            return extractRuntimeOutput(result);
        } catch (error) {
            throw error;
        }
    }
    throw new Error("openclaw_runtime_helper_unavailable");
}

// CLI --json 输出前后偶尔会混进日志，这里从原始文本里尽量提取首个对象。
export function extractJsonObject(raw: string): JsonRecord | null {
    const start = raw.indexOf("{");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (ch === "{") {
            depth += 1;
            continue;
        }

        if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(raw.slice(start, i + 1));
                    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                        ? (parsed as JsonRecord)
                        : null;
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

// list 场景同理，尽量从原始输出里提取首个 JSON 数组。
export function extractJsonArray(raw: string): unknown[] | null {
    const start = raw.indexOf("[");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (ch === "[") {
            depth += 1;
            continue;
        }

        if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(raw.slice(start, i + 1));
                    return Array.isArray(parsed) ? parsed : null;
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}
