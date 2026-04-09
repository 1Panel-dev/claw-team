<template>
  <MainFrame>
    <div class="main-layout">
      <div class="main-layout__frame">
        <section class="main-layout__content">
          <RouterView />
        </section>
      </div>
    </div>
  </MainFrame>
</template>

<script setup lang="ts">
/**
 * MainLayout 只负责统一的页面外壳。
 *
 * 页面内部是否需要分左右、是否存在侧栏，
 * 都应该由各页面自己负责，而不是在布局层分叉成多套结构。
 */
import MainFrame from "@/pages/shell/MainFrame.vue";
</script>

<style scoped>
.main-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  padding: 4px;
}

.main-layout__frame {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  border: 1px solid #dddddf;
  border-radius: var(--page-container-radius);
  background: #f5f5f7;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.03);
  overflow: hidden;
}

.main-layout__content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: #ffffff;
  display: flex;
  overflow: hidden;
  box-sizing: border-box;
}

@media (max-width: 960px) {
  .main-layout__content {
    min-height: auto;
  }
}
</style>
