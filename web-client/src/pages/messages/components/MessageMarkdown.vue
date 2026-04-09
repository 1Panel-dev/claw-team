<template>
  <div class="message-markdown" v-html="renderedHtml" />
</template>

<script setup lang="ts">
/**
 * Markdown 消息渲染组件。
 */
import { computed } from "vue";
import MarkdownIt from "markdown-it";

const props = defineProps<{
    content: string;
}>();

const markdown = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
    typographer: false,
});

const renderedHtml = computed(() => markdown.render(props.content ?? ""));
</script>

<style scoped>
.message-markdown {
  color: inherit;
  line-height: 1.72;
  word-break: break-word;
  font-size: 0.99rem;
}

.message-markdown :deep(h1),
.message-markdown :deep(h2),
.message-markdown :deep(h3),
.message-markdown :deep(h4) {
  margin: 0 0 10px;
  line-height: 1.35;
  font-weight: 700;
}

.message-markdown :deep(h1) {
  font-size: 1.16rem;
}

.message-markdown :deep(h2) {
  font-size: 1.08rem;
}

.message-markdown :deep(h3),
.message-markdown :deep(h4) {
  font-size: 1rem;
}

.message-markdown :deep(p) {
  margin: 0 0 12px;
}

.message-markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.message-markdown :deep(ul),
.message-markdown :deep(ol) {
  margin: 0 0 12px;
  padding-left: 22px;
}

.message-markdown :deep(li + li) {
  margin-top: 4px;
}

.message-markdown :deep(blockquote) {
  margin: 0 0 12px;
  padding: 12px 14px;
  border-left: 3px solid color-mix(in srgb, var(--color-accent) 35%, white);
  border-radius: 0 12px 12px 0;
  background: #f7f8fa;
  color: #5b616d;
}

.message-markdown :deep(code) {
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.06);
  font-size: 0.92em;
  font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
}

.message-markdown :deep(pre) {
  margin: 0 0 12px;
  padding: 14px 16px;
  overflow: auto;
  border-radius: 14px;
  background: #1f2430;
  color: #eef2f7;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.04),
    0 8px 20px rgba(15, 23, 42, 0.14);
}

.message-markdown :deep(pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
}

.message-markdown :deep(table) {
  display: block;
  max-width: 100%;
  margin: 0 0 12px;
  border-collapse: collapse;
  border: 1px solid color-mix(in srgb, var(--color-border) 90%, white);
  border-radius: 16px;
  overflow: hidden;
  background: #ffffff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
  overflow-x: auto;
  white-space: nowrap;
}

.message-markdown :deep(th),
.message-markdown :deep(td) {
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 88%, white);
  text-align: left;
  vertical-align: top;
}

.message-markdown :deep(th) {
  background: #f6f7f9;
  font-weight: 700;
}

.message-markdown :deep(tr:last-child td) {
  border-bottom: none;
}

.message-markdown :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}

.message-markdown :deep(a:hover) {
  text-decoration: underline;
}

.message-markdown :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 86%, white);
}
</style>
