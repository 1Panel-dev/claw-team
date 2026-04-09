<template>
  <div class="empty-card">
    <div class="empty-card__eyebrow">{{ eyebrow }}</div>
    <h2 class="empty-card__title">{{ title }}</h2>
    <p class="empty-card__description">{{ description }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
    eyebrow: string;
    title: string;
    description: string;
}>();
</script>

<style scoped>
.empty-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-6);
}

.empty-card__eyebrow {
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.empty-card__title {
  margin: 0;
  font-size: 1.6rem;
}

.empty-card__description {
  margin: 0;
  max-width: 54ch;
  color: var(--color-text-secondary);
  line-height: 1.7;
}
</style>
