<template>
  <section class="overview-grid">
    <article
      v-for="item in items"
      :key="item.label"
      class="overview-card"
    >
      <div class="overview-card__label">{{ item.label }}</div>
      <div class="overview-card__value">{{ item.value }}</div>
      <div class="overview-card__description">{{ item.description }}</div>
    </article>
  </section>
</template>

<script setup lang="ts">
/**
 * 任务概览卡片。
 *
 * 用于展示任务模块的聚合统计信息。
 */
defineProps<{
    items: Array<{
        label: string;
        value: number | string;
        description: string;
    }>;
}>();
</script>

<style scoped>
.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

.overview-card {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-app);
}

.overview-card__label {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

.overview-card__value {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
}

.overview-card__description {
  color: var(--color-text-secondary);
  font-size: 0.92rem;
  line-height: 1.6;
}

@media (max-width: 1200px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
