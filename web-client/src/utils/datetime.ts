/**
 * 时间解析工具。
 *
 * 后端部分时间字符串不显式带时区，这里统一按 UTC 处理后再格式化。
 */

const ISO_WITHOUT_TIMEZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function normalizeServerDateTime(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return trimmed;
    }
    return ISO_WITHOUT_TIMEZONE_RE.test(trimmed) ? `${trimmed}Z` : trimmed;
}

export function parseServerDateTime(value: string): Date {
    return new Date(normalizeServerDateTime(value));
}

export function formatServerDateTime(
    value: string,
    locale: string,
    options: Intl.DateTimeFormatOptions,
): string {
    return new Intl.DateTimeFormat(locale, options).format(parseServerDateTime(value));
}
