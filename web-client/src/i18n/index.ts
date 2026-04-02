import { createI18n } from "vue-i18n";

import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";

export type SupportedLocale = "en" | "zh-CN";
export type MessageTree = Record<string, unknown>;
const LOCALE_STORAGE_KEY = "claw-team.locale";

export const messages = {
    en,
    "zh-CN": zhCN,
} as const;

function detectBrowserLocale(): SupportedLocale {
    if (typeof navigator === "undefined") {
        return "en";
    }
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function resolveInitialLocale(): SupportedLocale {
    if (typeof window === "undefined") {
        return "en";
    }
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") {
        return stored;
    }
    return detectBrowserLocale();
}

export const i18n = createI18n({
    legacy: false,
    locale: resolveInitialLocale(),
    fallbackLocale: "en",
    messages,
});

export { LOCALE_STORAGE_KEY };
