import { execFileSync } from "node:child_process";

type JsonRecord = Record<string, unknown>;

// 容器环境里不同镜像的安装位置可能不同，这里按常见候选顺序尝试。
export function runOpenClawCli(args: string[]): string {
    for (const command of ["/usr/local/bin/openclaw", "openclaw"]) {
        try {
            return execFileSync(command, args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch {
            // 当前候选不可用时继续尝试下一个命令路径。
        }
    }
    throw new Error("openclaw_cli_unavailable");
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
