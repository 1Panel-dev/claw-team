<template>
  <header class="top-nav">
    <div class="top-nav__brand">
      <img class="top-nav__logo" src="/Logo-2.png" alt="Claw Team Logo" />
    </div>

    <nav class="top-nav__links">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        custom
        v-slot="{ href, navigate }"
      >
        <el-button
          :href="href"
          class="top-nav__link"
          :type="isNavItemActive(item.to) ? 'primary' : 'default'"
          @click="navigate"
        >
          <span>{{ t(item.labelKey) }}</span>
        </el-button>
      </RouterLink>
      <el-select
        :model-value="locale"
        class="top-nav__locale"
        size="default"
        :aria-label="t('nav.language')"
        @update:model-value="handleLocaleChange"
      >
        <el-option
          v-for="option in localeOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
    </nav>
  </header>
</template>

<script setup lang="ts">
import type { SupportedLocale } from "@/i18n";
import { useI18n } from "@/composables/useI18n";
import { useRoute } from "vue-router";

const { locale, localeOptions, setLocale, t } = useI18n();
const route = useRoute();

const navItems = [
    { labelKey: "nav.messages", to: "/messages" },
    { labelKey: "nav.openclaw", to: "/openclaws" },
];

function handleLocaleChange(value: string | number | boolean) {
    if (value === "en" || value === "zh-CN") {
        setLocale(value as SupportedLocale);
    }
}

function isNavItemActive(targetPath: string) {
    return route.path === targetPath || route.path.startsWith(`${targetPath}/`);
}
</script>

<style scoped>
.top-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 58px;
  padding: 8px 14px;
  border-bottom: 1px solid #dddde2;
  background: #f3f3f5;
}

.top-nav__brand {
  display: flex;
  align-items: center;
}

.top-nav__logo {
  width: auto;
  height: 40px;
  object-fit: contain;
}

.top-nav__links {
  display: flex;
  align-items: center;
  gap: 8px;
}

.top-nav__locale {
  width: 132px;
}

.top-nav__link {
  white-space: nowrap;
  font-weight: 600;
  font-size: 0.95rem;
}

@media (max-width: 960px) {
  .top-nav {
    flex-direction: column;
    align-items: stretch;
  }

  .top-nav__links {
    overflow-x: auto;
  }
}
</style>
