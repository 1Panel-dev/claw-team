<template>
  <el-config-provider :button="{ autoInsertSpace: false }" :locale="elementLocale" size="default">
    <RouterView />
  </el-config-provider>
</template>

<script setup lang="ts">
/**
 * 顶层根组件。
 *
 * 这里只负责挂载路由视图和 Element Plus 全局配置。
 */
import { useI18n } from "@/composables/useI18n";

const { elementLocale } = useI18n();
</script>
