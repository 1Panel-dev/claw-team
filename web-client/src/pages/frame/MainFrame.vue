<template>
  <div class="main-frame">
    <AppTopNav />
    <main class="main-frame__body">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * 主框架外壳。
 *
 * 负责顶栏与页面主体的整体布局，不承载具体业务逻辑。
 */
import AppTopNav from "@/pages/components/AppTopNav.vue";
</script>

<style scoped>
.main-frame {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  height: 100vh;
  background: #ececee;
  color: var(--color-text-primary);
  overflow: hidden;
}

.main-frame__body {
  flex: 1;
  min-height: 0;
  padding-bottom: 10px;
  overflow: hidden;
}
</style>
