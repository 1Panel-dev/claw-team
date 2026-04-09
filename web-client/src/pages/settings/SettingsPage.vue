<template>
  <div class="page-container">
    <section class="settings-hero page-card page-container__header">
      <div>
        <div class="settings-card__eyebrow">{{ t("settings.eyebrow") }}</div>
        <h1 class="settings-card__title">{{ t("settings.title") }}</h1>
        <p class="settings-card__description">
          {{ t("settings.description") }}
        </p>
      </div>
      <div class="settings-hero__badge">{{ t("settings.badge") }}</div>
    </section>

    <section class="settings-grid page-grid">
      <div class="settings-card page-card">
        <h2 class="settings-card__section-title">{{ t("settings.themeSection") }}</h2>
        <div class="settings-card__options">
          <button
            v-for="item in themeOptions"
            :key="item.id"
            class="theme-option"
            :class="{ 'theme-option--active': item.id === themeId }"
            @click="setTheme(item.id)"
          >
            <div class="theme-option__title">{{ item.label }}</div>
            <div class="theme-option__description">{{ item.description }}</div>
          </button>
        </div>
      </div>

      <div class="settings-card page-card">
        <h2 class="settings-card__section-title">{{ t("settings.whyTheme") }}</h2>
        <ul class="settings-card__list">
          <li>{{ t("settings.reason1") }}</li>
          <li>{{ t("settings.reason2") }}</li>
          <li>{{ t("settings.reason3") }}</li>
        </ul>
      </div>
    </section>

    <section class="settings-card page-card">
      <h2 class="settings-card__section-title">{{ t("settings.languageSection") }}</h2>
      <p class="settings-card__description">
        {{ t("settings.languageDesc") }}
      </p>
      <div class="settings-card__compare">
        <el-select :model-value="locale" style="width: 220px" @update:model-value="handleLocaleChange">
          <el-option
            v-for="option in localeOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </div>
    </section>

    <section class="settings-card page-card">
      <h2 class="settings-card__section-title">{{ t("settings.futureSection") }}</h2>
      <div class="settings-card__options settings-card__options--future">
        <button
          class="theme-option theme-option--disabled"
          disabled
        >
          <div class="theme-option__title">{{ t("settings.messagePrefs") }}</div>
          <div class="theme-option__description">{{ t("settings.messagePrefsDesc") }}</div>
        </button>
        <button
          class="theme-option theme-option--disabled"
          disabled
        >
          <div class="theme-option__title">{{ t("settings.layoutPrefs") }}</div>
          <div class="theme-option__description">{{ t("settings.layoutPrefsDesc") }}</div>
        </button>
      </div>
    </section>

    <section class="settings-card page-card">
      <h2 class="settings-card__section-title">{{ t("settings.buttonCompare") }}</h2>
      <p class="settings-card__description">
        {{ t("settings.buttonCompareDesc") }}
      </p>
      <div class="settings-card__compare">
        <el-button type="primary">{{ t("settings.elementPrimary") }}</el-button>
        <button class="settings-card__brand-button" type="button">{{ t("settings.customPrimary") }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 设置页。
 *
 * 当前承载主题与语言相关的用户偏好设置。
 */
import { useTheme } from "@/composables/useTheme";
import type { SupportedLocale } from "@/i18n";
import { useI18n } from "@/composables/useI18n";

const { themeId, themeOptions, setTheme } = useTheme();
const { locale, localeOptions, setLocale, t } = useI18n();

function handleLocaleChange(value: string | number | boolean) {
    if (value === "en" || value === "zh-CN") {
        setLocale(value as SupportedLocale);
    }
}
</script>

<style scoped>
.settings-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  background: linear-gradient(135deg, var(--color-bg-panel), color-mix(in srgb, var(--color-bg-soft) 65%, white));
}

.settings-hero__badge {
  padding: 10px 14px;
  border-radius: 999px;
  background: var(--color-bg-app);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.settings-grid {
}

.settings-card {
  gap: var(--space-4);
  background: var(--color-bg-app);
}

.settings-card__eyebrow {
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.settings-card__title {
  margin: 0;
  font-size: 1.7rem;
}

.settings-card__section-title {
  margin: 0;
  font-size: 1.15rem;
}

.settings-card__description {
  margin: 0;
  color: var(--color-text-secondary);
  max-width: 58ch;
  line-height: 1.7;
}

.settings-card__options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-4);
}

.theme-option {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-app);
  text-align: left;
  cursor: pointer;
}

.theme-option--active {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 40%, transparent);
}

.theme-option--disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.theme-option__title {
  font-weight: 700;
}

.theme-option__description {
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.settings-card__options--future {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.settings-card__compare {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.settings-card__brand-button {
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #ffffff;
  cursor: pointer;
}

.settings-card__list {
  margin: 0;
  padding-left: 1.2rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
}

@media (max-width: 960px) {
  .settings-hero,
  .settings-grid {
    grid-template-columns: 1fr;
    flex-direction: column;
  }
}
</style>
