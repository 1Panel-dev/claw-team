<template>
  <el-config-provider :button="{ autoInsertSpace: false }" :locale="elementLocale" size="default">
    <RouterView />
  </el-config-provider>
</template>

<script setup lang="ts">
/**
 * 顶层组件只负责挂载路由视图。
 *
 * 真正的应用骨架由 MainLayout / MainFrame 承担，
 * 这样后面如果接入登录页、独立落地页或错误页，不需要推倒整个 App 结构。
 */
import { useI18n } from "@/composables/useI18n";

const { elementLocale } = useI18n();
</script>
