<template>
  <el-drawer
    :model-value="visible"
    :title="t('conversation.createAgentDialogue')"
    size="520px"
    destroy-on-close
    @close="emit('update:visible', false)"
  >
    <div class="drawer-body">
      <p class="drawer-body__hint">{{ t("conversation.agentDialogueHint") }}</p>

      <el-form label-position="top">
        <el-form-item :label="t('conversation.sourceAgent')">
          <el-select v-model="sourceAgentId" filterable style="width: 100%">
            <el-option
              v-for="agent in agentOptions"
              :key="agent.value"
              :label="agent.label"
              :value="agent.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="t('conversation.targetAgent')">
          <el-select v-model="targetAgentId" filterable style="width: 100%">
            <el-option
              v-for="agent in targetOptions"
              :key="agent.value"
              :label="agent.label"
              :value="agent.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="t('conversation.agentDialogueTopic')">
          <el-input
            v-model="topic"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 8 }"
            :placeholder="t('conversation.agentDialogueTopicPlaceholder')"
          />
        </el-form-item>

        <el-form-item :label="t('conversation.agentDialogueWindowSeconds')">
          <el-input-number v-model="windowSeconds" :min="60" :max="3600" :step="60" />
        </el-form-item>

        <el-form-item :label="t('conversation.agentDialogueSoftMessageLimit')">
          <el-input-number v-model="softMessageLimit" :min="2" :max="100" />
        </el-form-item>

        <el-form-item :label="t('conversation.agentDialogueHardMessageLimit')">
          <el-input-number v-model="hardMessageLimit" :min="3" :max="200" />
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="drawer-actions">
        <el-button @click="emit('update:visible', false)">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :disabled="!canSubmit" @click="submit">
          {{ t("conversation.createAgentDialogue") }}
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
    visible: boolean;
    agentOptions: Array<{ value: number; label: string }>;
}>();

const emit = defineEmits<{
    "update:visible": [value: boolean];
    submit: [payload: {
        source_agent_id: number;
        target_agent_id: number;
        topic: string;
        window_seconds: number;
        soft_message_limit: number;
        hard_message_limit: number;
    }];
}>();

const { t } = useI18n();
const sourceAgentId = ref<number | null>(null);
const targetAgentId = ref<number | null>(null);
const topic = ref("");
const windowSeconds = ref(300);
const softMessageLimit = ref(12);
const hardMessageLimit = ref(20);

const targetOptions = computed(() =>
    props.agentOptions.filter((item) => item.value !== sourceAgentId.value),
);

const canSubmit = computed(() => {
    return (
        !!sourceAgentId.value
        && !!targetAgentId.value
        && sourceAgentId.value !== targetAgentId.value
        && !!topic.value.trim()
        && softMessageLimit.value < hardMessageLimit.value
    );
});

watch(
    () => props.visible,
    (visible) => {
        if (!visible) {
            return;
        }
        sourceAgentId.value = null;
        targetAgentId.value = null;
        topic.value = "";
        windowSeconds.value = 300;
        softMessageLimit.value = 12;
        hardMessageLimit.value = 20;
    },
);

function submit() {
    if (!canSubmit.value || sourceAgentId.value === null || targetAgentId.value === null) {
        return;
    }
    emit("submit", {
        source_agent_id: sourceAgentId.value,
        target_agent_id: targetAgentId.value,
        topic: topic.value.trim(),
        window_seconds: windowSeconds.value,
        soft_message_limit: softMessageLimit.value,
        hard_message_limit: hardMessageLimit.value,
    });
}
</script>

<style scoped>
.drawer-body {
  display: grid;
  gap: var(--space-3);
  padding-right: 6px;
}

.drawer-body__hint {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
