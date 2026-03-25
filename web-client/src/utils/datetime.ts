/**
 * 调度中心当前返回的时间字符串大多是 ISO 形状，但没有显式时区。
 *
 * 这类值如果直接 `new Date(value)`，浏览器会把它当成本地时间解析，
 * 而服务端实际保存的是 UTC 时间，最终就会整体偏 8 小时。
 *
 * 这里统一把“没有显式时区的 ISO 字符串”补成 UTC，再交给浏览器格式化，
 * 这样前端会按用户本地时区正确显示。
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

