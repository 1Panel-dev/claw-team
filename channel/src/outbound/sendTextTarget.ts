/**
 * 这里集中处理 sendText 的统一 CS ID 目标。
 * 只负责识别、归一化和对外层 resolver 的适配。
 */
export const CS_ID_PREFIX = "csid:" as const;
const TARGET_CS_ID_PATTERN = /^CS[AU]-\d{4,}$/;

type TargetResolution =
    | { ok: true; to: string }
    | { ok: false; error: Error };

type MessagingTargetResolution = {
    to: string;
    kind: "user" | "group" | "channel";
    display?: string;
    source?: "normalized" | "directory";
};

function stripWrappingQuotes(value: string): string {
    let current = value.trim();
    while (
        current.length >= 2 &&
        ((current.startsWith('"') && current.endsWith('"')) ||
            (current.startsWith("'") && current.endsWith("'")) ||
            (current.startsWith("`") && current.endsWith("`")))
    ) {
        current = current.slice(1, -1).trim();
    }
    return current;
}

export function normalizeTargetCsId(to: string): string {
    // OpenClaw 在不同调用链里可能会给 target 包上 @、引号、零宽字符或变体短横线。
    // 这里统一做宽松归一化，避免把“看起来正确”的 CS ID 错误拒掉。
    const raw = stripWrappingQuotes(
        to
            .trim()
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/[\u2010-\u2015\u2212\uFF0D]/g, "-"),
    );
    const withoutAt = raw.startsWith("@") ? raw.slice(1).trim() : raw;
    const normalized = withoutAt.toLowerCase().startsWith(CS_ID_PREFIX)
        ? withoutAt.slice(CS_ID_PREFIX.length)
        : withoutAt;
    const value = normalized.trim().toUpperCase();
    if (!TARGET_CS_ID_PATTERN.test(value)) {
        throw new Error("clawswarm_invalid_target_cs_id");
    }
    return value;
}

export function resolveClawSwarmTarget(to?: string): TargetResolution {
    const raw = String(to ?? "").trim();
    if (!raw) {
        return {
            ok: false,
            error: new Error("Delivering to ClawSwarm requires a target CS ID like CSA-0009 or CSU-0001."),
        };
    }
    try {
        return {
            ok: true,
            to: normalizeTargetCsId(raw),
        };
    } catch {
        return {
            // framework 层过早拒绝会直接拦住 sendText，让我们拿不到更完整的上下文。
            // 这里宽松放行，让 sendText 与后端业务接口去做最终校验和报错。
            ok: true,
            to: raw,
        };
    }
}

export function looksLikeClawSwarmCsId(raw: string, normalized?: string): boolean {
    const candidate = String(normalized ?? raw ?? "").trim();
    try {
        normalizeTargetCsId(candidate);
        return true;
    } catch {
        return false;
    }
}

export async function resolveClawSwarmMessagingTarget(params: {
    input: string;
}): Promise<MessagingTargetResolution | null> {
    try {
        const to = normalizeTargetCsId(params.input);
        return {
            to,
            kind: "user",
            display: to,
            source: "normalized",
        };
    } catch {
        return null;
    }
}
