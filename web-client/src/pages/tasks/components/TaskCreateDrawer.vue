<template>
  <el-drawer
    :model-value="visible"
    :title="t('tasks.createTask')"
    size="640px"
    destroy-on-close
    @close="emit('update:visible', false)"
  >
    <div class="drawer-body">
      <p class="drawer-body__hint">
        {{ t("tasks.drawerHint") }}
      </p>

      <el-form label-position="top">
        <el-form-item :label="t('tasks.titleField')">
          <el-input v-model="form.title" maxlength="200" :placeholder="t('tasks.titlePlaceholder')" />
        </el-form-item>

        <el-form-item :label="t('tasks.descriptionField')">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="5"
            maxlength="4000"
            :placeholder="t('tasks.descriptionPlaceholder')"
          />
        </el-form-item>

        <div class="drawer-grid">
          <el-form-item :label="t('tasks.priorityField')">
            <el-select v-model="form.priority" style="width: 100%">
              <el-option :label="t('tasks.priorityLow')" value="low" />
              <el-option :label="t('tasks.priorityMedium')" value="medium" />
              <el-option :label="t('tasks.priorityHigh')" value="high" />
              <el-option :label="t('tasks.priorityUrgent')" value="urgent" />
            </el-select>
          </el-form-item>

          <el-form-item :label="t('tasks.assigneeField')">
            <el-select
              v-model="selectedAgentKey"
              filterable
              :placeholder="t('tasks.assigneePlaceholder')"
              style="width: 100%"
            >
              <el-option-group
                v-for="instance in enabledInstances"
                :key="instance.id"
                :label="instance.name"
              >
                <el-option
                  v-for="agent in instance.agents"
                  :key="`${instance.id}:${agent.id}`"
                  :label="`${agent.display_name}${agent.role_name ? ` / ${agent.role_name}` : ''}`"
                  :value="`${instance.id}:${agent.id}`"
                />
              </el-option-group>
            </el-select>
          </el-form-item>
        </div>

        <el-form-item :label="t('tasks.tagsField')">
          <el-select
            v-model="form.tags"
            multiple
            filterable
            allow-create
            default-first-option
            :placeholder="t('tasks.tagsPlaceholder')"
            style="width: 100%"
          >
            <el-option
              v-for="tag in tagSuggestions"
              :key="tag"
              :label="tag"
              :value="tag"
            />
          </el-select>
        </el-form-item>

        <section class="child-section">
          <header class="child-section__header">
            <div>
              <h3 class="child-section__title">{{ t("tasks.childTasksTitle") }}</h3>
              <p class="child-section__hint">{{ t("tasks.childTasksHint") }}</p>
            </div>
            <el-button plain @click="addChildTask">
              {{ t("tasks.addChildTask") }}
            </el-button>
          </header>

          <div v-if="form.children.length" class="child-list">
            <article
              v-for="(child, index) in form.children"
              :key="child.id"
              class="child-card"
            >
              <div class="child-card__header">
                <div class="child-card__title">{{ t("tasks.childTaskLabel", { index: index + 1 }) }}</div>
                <el-button text type="danger" @click="removeChildTask(child.id)">
                  {{ t("common.remove") }}
                </el-button>
              </div>

              <el-form-item :label="t('tasks.titleField')">
                <el-input v-model="child.title" maxlength="200" :placeholder="t('tasks.childTitlePlaceholder')" />
              </el-form-item>

              <el-form-item :label="t('tasks.descriptionField')">
                <el-input
                  v-model="child.description"
                  type="textarea"
                  :rows="3"
                  maxlength="4000"
                  :placeholder="t('tasks.childDescriptionPlaceholder')"
                />
              </el-form-item>

              <div class="drawer-grid">
                <el-form-item :label="t('tasks.priorityField')">
                  <el-select v-model="child.priority" style="width: 100%">
                    <el-option :label="t('tasks.priorityLow')" value="low" />
                    <el-option :label="t('tasks.priorityMedium')" value="medium" />
                    <el-option :label="t('tasks.priorityHigh')" value="high" />
                    <el-option :label="t('tasks.priorityUrgent')" value="urgent" />
                  </el-select>
                </el-form-item>

                <el-form-item :label="t('tasks.tagsField')">
                  <el-select
                    v-model="child.tags"
                    multiple
                    filterable
                    allow-create
                    default-first-option
                    :placeholder="t('tasks.tagsPlaceholder')"
                    style="width: 100%"
                  >
                    <el-option
                      v-for="tag in tagSuggestions"
                      :key="`${child.id}:${tag}`"
                      :label="tag"
                      :value="tag"
                    />
                  </el-select>
                </el-form-item>
              </div>
            </article>
          </div>
        </section>
      </el-form>
    </div>

    <template #footer>
      <div class="drawer-actions">
        <el-button @click="emit('update:visible', false)">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :disabled="!canSubmit" @click="submit">
          {{ t("tasks.createTask") }}
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 任务创建弹窗负责承接第一阶段最小闭环：
 * 用户创建任务，并明确指定一个可用 Agent 作为执行者。
 *
 * 这里先使用前端本地数据验证流程，后续接真实后端时，
 * 尽量只替换提交逻辑，不重做表单结构。
 */
import { computed, reactive, ref, watch } from "vue";

import { useI18n } from "@/composables/useI18n";
import type { OpenClawInstanceView } from "@/stores/openclaw";
import type { TaskCreatePayload, TaskPriority } from "@/types/view/task";

const props = defineProps<{
    visible: boolean;
    instances: OpenClawInstanceView[];
}>();

const emit = defineEmits<{
    "update:visible": [value: boolean];
    submit: [payload: TaskCreatePayload];
}>();

const tagSuggestions = ["前端", "后端", "登录", "排障", "数据", "文案", "官网", "消息"];
const selectedAgentKey = ref("");
const form = reactive({
    title: "",
    description: "",
    priority: "medium" as TaskPriority,
    tags: [] as string[],
    children: [] as Array<{
        id: string;
        title: string;
        description: string;
        priority: TaskPriority;
        tags: string[];
    }>,
});
const { t } = useI18n();

const enabledInstances = computed(() =>
    props.instances
        .map((instance) => ({
            ...instance,
            agents: instance.agents.filter((agent) => agent.enabled),
        }))
        .filter((instance) => instance.agents.length > 0),
);

const selectedAssignee = computed(() => {
    const [instanceIdRaw, agentIdRaw] = selectedAgentKey.value.split(":");
    const instanceId = Number(instanceIdRaw);
    const agentId = Number(agentIdRaw);
    if (!Number.isFinite(instanceId) || !Number.isFinite(agentId)) {
        return null;
    }
    const instance = enabledInstances.value.find((item) => item.id === instanceId);
    const agent = instance?.agents.find((item) => item.id === agentId);
    if (!instance || !agent) {
        return null;
    }
    return {
        instanceId: instance.id,
        instanceName: instance.name,
        agentId: agent.id,
        agentName: agent.display_name,
        roleName: agent.role_name,
    };
});

const canSubmit = computed(
    () => !!form.title.trim() && !!form.description.trim() && !!selectedAssignee.value,
);

watch(
    () => props.visible,
    (visible) => {
        if (!visible) {
            return;
        }
        form.title = "";
        form.description = "";
        form.priority = "medium";
        form.tags = [];
        form.children = [];
        selectedAgentKey.value = "";
    },
);

function submit() {
    if (!canSubmit.value || !selectedAssignee.value) {
        return;
    }
    emit("submit", {
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        tags: form.tags.map((tag) => tag.trim()).filter(Boolean),
        assignee: selectedAssignee.value,
        // 第一阶段只支持“父任务 + 子任务”两级输入，
        // 提交时把无效子任务先过滤掉，避免后端收到空标题/空描述。
        children: form.children
            .map((child) => ({
                title: child.title.trim(),
                description: child.description.trim(),
                priority: child.priority,
                tags: child.tags.map((tag) => tag.trim()).filter(Boolean),
            }))
            .filter((child) => child.title && child.description),
    });
}

function addChildTask() {
    // 子任务只做最小执行单元录入，不再继续往下拆孙任务。
    form.children.push({
        id: crypto.randomUUID(),
        title: "",
        description: "",
        priority: "medium",
        tags: [],
    });
}

function removeChildTask(childId: string) {
    form.children = form.children.filter((child) => child.id !== childId);
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

.drawer-grid {
  display: grid;
  grid-template-columns: 0.8fr 1.2fr;
  gap: var(--space-3);
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.child-section {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-2);
}

.child-section__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.child-section__title {
  margin: 0;
  font-size: 1rem;
}

.child-section__hint {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
  line-height: 1.6;
  font-size: 0.92rem;
}

.child-list {
  display: grid;
  gap: var(--space-3);
}

.child-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-panel);
}

.child-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.child-card__title {
  font-weight: 700;
}

@media (max-width: 800px) {
  .drawer-grid {
    grid-template-columns: 1fr;
  }
}
</style>
