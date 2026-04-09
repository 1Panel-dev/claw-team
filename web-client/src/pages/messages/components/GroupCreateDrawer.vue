<template>
  <el-drawer
    :model-value="visible"
    :title="t('conversation.create')"
    size="520px"
    destroy-on-close
    @close="emit('update:visible', false)"
  >
    <div class="drawer-body">
      <p class="drawer-body__hint">
        {{ t("conversation.drawerGroupHint") }}
      </p>

      <el-form label-position="top">
        <el-form-item :label="t('conversation.groupName')">
          <el-input v-model="name" maxlength="120" :placeholder="t('conversation.groupNamePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('conversation.groupDescription')">
          <el-input
            v-model="description"
            type="textarea"
            :rows="3"
            maxlength="500"
            :placeholder="t('conversation.groupDescriptionPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('conversation.addMembers')">
          <div class="drawer-body__field-hint">{{ t("conversation.addMembersHint") }}</div>
          <el-select
            v-model="selectedValues"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :placeholder="t('conversation.selectAgents')"
            style="width: 100%"
          >
            <el-option-group
              v-for="instance in instances"
              :key="instance.id"
              :label="instance.name"
            >
              <el-option
                v-for="agent in instance.agents"
                :key="`${instance.id}:${agent.id}`"
                :label="`${agent.display_name} / ${instance.name}`"
                :value="`${instance.id}:${agent.id}`"
                :disabled="!agent.enabled"
              />
            </el-option-group>
          </el-select>
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="drawer-actions">
        <el-button @click="emit('update:visible', false)">{{ t("conversation.cancel") }}</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!name.trim()" @click="submit">
          {{ t("conversation.create") }}
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 群组创建抽屉。
 */
import { ref, watch } from "vue";
import { useI18n } from "@/composables/useI18n";
import type { AddressBookInstanceApi } from "@/types/api/addressBook";

const props = defineProps<{
    visible: boolean;
    submitting: boolean;
    instances: AddressBookInstanceApi[];
}>();

const emit = defineEmits<{
    "update:visible": [value: boolean];
    submit: [payload: {
        name: string;
        description: string;
        members: Array<{ instance_id: number; agent_id: number }>;
    }];
}>();

const name = ref("");
const description = ref("");
const selectedValues = ref<string[]>([]);
const { t } = useI18n();

watch(
    () => props.visible,
    (visible) => {
        if (visible) {
            name.value = "";
            description.value = "";
            selectedValues.value = [];
        }
    },
);

function submit() {
    if (!name.value.trim()) {
        return;
    }
    emit("submit", {
        name: name.value.trim(),
        description: description.value.trim(),
        members: selectedValues.value.map((value) => {
            const [instanceId, agentId] = value.split(":").map((item) => Number(item));
            return {
                instance_id: instanceId,
                agent_id: agentId,
            };
        }),
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

.drawer-body__field-hint {
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
