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
 * MainFrame 是整套前端应用的稳定外壳。
 *
 * 它只负责整体结构，不直接耦合消息、任务、OpenClaw 管理这些具体业务。
 * 这样后面模块增加时，不需要重做全局布局。
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
