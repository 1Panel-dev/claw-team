/**
 * 这个文件提供插件内部统一的结构化日志能力。
 * 所有模块都尽量通过这里打日志，这样字段格式才能保持稳定。
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
    // child 用于把 traceId、messageId、accountId 这类上下文字段挂在整个调用链上。
    child(fields: LogFields): Logger;
    debug(fields: LogFields, msg: string): void;
    info(fields: LogFields, msg: string): void;
    warn(fields: LogFields, msg: string): void;
    error(fields: LogFields, msg: string): void;
}

type Sink = {
    debug?: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
};

function nowIso(): string {
    return new Date().toISOString();
}

export function createLogger(opts?: { base?: LogFields; sink?: Sink }): Logger {
    // 如果宿主没提供 logger，就退回到标准输出。
    const sink: Sink =
        opts?.sink ??
        ({
            info: (obj: unknown) => console.log(JSON.stringify(obj)),
            warn: (obj: unknown) => console.warn(JSON.stringify(obj)),
            error: (obj: unknown) => console.error(JSON.stringify(obj)),
            debug: (obj: unknown) => console.debug(JSON.stringify(obj)),
        } as const);

    const base = opts?.base ?? {};

    // emit 统一控制最终日志结构，保证不同模块打出来的日志形状一致。
    const emit = (level: LogLevel, fields: LogFields, msg: string) => {
        const rec = {
            ts: nowIso(),
            level,
            subsystem: "plugin/clawswarm",
            msg,
            ...base,
            ...fields,
        };
        const fn = level === "debug" ? sink.debug ?? sink.info : (sink as any)[level];
        fn(rec);
    };

    return {
        child(fields: LogFields) {
            // child 不会覆盖 sink，只是在原有 base 上继续叠字段。
            return createLogger({ base: { ...base, ...fields }, sink });
        },
        debug(fields, msg) {
            emit("debug", fields, msg);
        },
        info(fields, msg) {
            emit("info", fields, msg);
        },
        warn(fields, msg) {
            emit("warn", fields, msg);
        },
        error(fields, msg) {
            emit("error", fields, msg);
        },
    };
}

// 把宿主 logger 适配成我们内部的 Sink 形状。
export function wrapOpenClawLogger(openclawLogger: any | undefined): Sink | undefined {
    if (!openclawLogger) return undefined;
    return {
        debug: (obj, msg) => openclawLogger.debug?.(msg ?? "", obj),
        info: (obj, msg) => openclawLogger.info?.(msg ?? "", obj),
        warn: (obj, msg) => openclawLogger.warn?.(msg ?? "", obj),
        error: (obj, msg) => openclawLogger.error?.(msg ?? "", obj),
    };
}
