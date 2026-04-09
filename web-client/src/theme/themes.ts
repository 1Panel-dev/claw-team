/**
 * 主题系统的静态定义。
 *
 * 这里维护可选主题列表、显示文案和默认主题。
 */
export const themeIds = ["light", "monochrome"] as const;

export type ThemeId = (typeof themeIds)[number];

export interface ThemeOption {
    id: ThemeId;
    label: string;
    description: string;
}

export const themeOptions: ThemeOption[] = [
    {
        id: "light",
        label: "默认浅色",
        description: "适合日常使用的浅色工作台风格。",
    },
    {
        id: "monochrome",
        label: "黑白极简",
        description: "强调对比度与信息秩序的黑白风格。",
    },
];

export const defaultThemeId: ThemeId = "light";
