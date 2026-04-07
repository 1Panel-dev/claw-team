import { defaultThemeId, type ThemeId } from "@/theme/themes";

const STORAGE_KEY = "clawswarm-theme";

export function applyTheme(themeId: ThemeId): void {
    document.documentElement.setAttribute("data-theme", themeId);
    window.localStorage.setItem(STORAGE_KEY, themeId);
}

export function getStoredTheme(): ThemeId {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "monochrome" ? "monochrome" : defaultThemeId;
}

export function applyInitialTheme(): void {
    applyTheme(getStoredTheme());
}
