<template>
  <el-drawer
    :model-value="visible"
    :title="drawerTitle"
    size="720px"
    destroy-on-close
    @close="emit('update:visible', false)"
  >
    <div v-loading="submitting" class="drawer-shell">
      <div class="drawer-body">
        <el-form label-position="top">
          <el-form-item v-if="!isEditMode" :label="t('openclaw.agentTemplate')">
            <el-select
              v-model="selectedTemplateKey"
              class="agent-template-select"
              :placeholder="t('openclaw.agentTemplatePlaceholder')"
              @change="applySelectedTemplate"
            >
              <el-option
                v-for="template in agentTemplateOptions"
                :key="template.value"
                :label="template.label"
                :value="template.value"
              />
            </el-select>
          </el-form-item>

          <el-form-item :label="t('openclaw.agentKey')">
            <el-input
              v-model="form.agent_key"
              maxlength="120"
              :placeholder="t('openclaw.agentKeyPlaceholder')"
              :disabled="isEditMode"
            />
          </el-form-item>

          <el-form-item :label="t('openclaw.displayName')">
            <el-input v-model="form.display_name" maxlength="120" :placeholder="t('openclaw.displayNamePlaceholder')"/>
          </el-form-item>

          <el-form-item :label="t('openclaw.roleName')">
            <el-input v-model="form.role_name" maxlength="120" :placeholder="t('openclaw.rolePlaceholder')"/>
          </el-form-item>

          <div class="file-sections">
            <div
              v-for="fileField in fileFields"
              :key="fileField.key"
              class="file-section"
            >
              <button
                type="button"
                class="file-section__header"
                @click="toggleFileSection(fileField.key)"
              >
              <span class="file-section__title-wrap">
                <span class="file-section__title">{{ t(fileField.labelKey) }}</span>
                <span
                  v-if="isEditMode && fileDirtyState[fileField.key]"
                  class="file-section__edited"
                >
                  {{ t("openclaw.fileEdited") }}
                </span>
              </span>
                <span class="file-section__header-actions">
                <el-button
                  v-if="isEditMode"
                  type="primary"
                  text
                  size="small"
                  class="file-section__edit-button"
                  @click.stop="enableFileEdit(fileField.key)"
                >
                  <el-icon><EditPen/></el-icon>
                </el-button>
                <el-icon class="file-section__arrow"
                         :class="{ 'file-section__arrow--open': fileExpandedState[fileField.key] }">
                  <ArrowDown/>
                </el-icon>
              </span>
              </button>

              <div v-show="fileExpandedState[fileField.key]" class="file-section__body">
                <el-input
                  :model-value="form[fileField.key]"
                  type="textarea"
                  :autosize="{ minRows: 6, maxRows: 12 }"
                  :placeholder="t(fileField.placeholderKey)"
                  :readonly="isEditMode && !fileEditableState[fileField.key]"
                  @update:model-value="updateFileField(fileField.key, $event)"
                />
                <p v-if="isEditMode && !fileEditableState[fileField.key]" class="file-section__hint">
                  {{ t("openclaw.fileEditLockedHint") }}
                </p>
              </div>
            </div>
          </div>
        </el-form>
        <div class="drawer-actions">
          <el-button @click="emit('update:visible', false)">{{ t("common.cancel") }}</el-button>
          <el-button type="primary" @click="submit">
            {{ isEditMode ? t("openclaw.saveAgent") : t("common.create") }}
          </el-button>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 这个抽屉统一承接 Agent 的创建和编辑。
 *
 * 第一阶段只开放最关键的三类信息：
 * 1. 通讯录与路由需要的基础字段。
 * 2. IDENTITY.md / SOUL.md / USER.md / MEMORY.md 四个核心 bootstrap 文件。
 * 3. 编辑时直接从 OpenClaw 读取当前文件内容后回显。
 * 4. 编辑模式下只有显式点开某个文件的编辑按钮，才允许修改该文件。
 */
import {ArrowDown, EditPen} from "@element-plus/icons-vue";
import {computed, reactive, ref, watch} from "vue";
import {useI18n} from "@/composables/useI18n";
import {AGENT_TEMPLATES} from "@/constants/agentTemplates";

type AgentDrawerCreatePayload = {
  mode: "create";
  agent_key: string;
  display_name: string;
  role_name: string;
  identity_md?: string;
  soul_md?: string;
  user_md?: string;
  memory_md?: string;
};

type AgentDrawerEditPayload = {
  mode: "edit";
  agent_id: number;
  agent_key: string;
  display_name: string;
  role_name: string;
  identity_md?: string;
  soul_md?: string;
  user_md?: string;
  memory_md?: string;
};

type AgentDrawerInitialValue = {
  agent_id: number;
  agent_key: string;
  display_name: string;
  role_name: string | null;
  identity_md: string;
  soul_md: string;
  user_md: string;
  memory_md: string;
};

const props = defineProps<{
  visible: boolean;
  submitting: boolean;
  instanceName: string;
  mode: "create" | "edit";
  initialValue?: AgentDrawerInitialValue | null;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  submit: [payload: AgentDrawerCreatePayload | AgentDrawerEditPayload];
}>();

const {t} = useI18n();

const fileFields = [
  {
    key: "identity_md",
    labelKey: "openclaw.identityFile",
    placeholderKey: "openclaw.identityPlaceholder",
  },
  {
    key: "soul_md",
    labelKey: "openclaw.soulFile",
    placeholderKey: "openclaw.soulPlaceholder",
  },
  {
    key: "user_md",
    labelKey: "openclaw.userFile",
    placeholderKey: "openclaw.userPlaceholder",
  },
  {
    key: "memory_md",
    labelKey: "openclaw.memoryFile",
    placeholderKey: "openclaw.memoryPlaceholder",
  },
] as const;

type FileFieldKey = (typeof fileFields)[number]["key"];

const form = reactive({
  agent_id: 0,
  agent_key: "",
  display_name: "",
  role_name: "",
  identity_md: "",
  soul_md: "",
  user_md: "",
  memory_md: "",
});
const selectedTemplateKey = ref("blank");

const fileExpandedState = reactive<Record<FileFieldKey, boolean>>({
  identity_md: false,
  soul_md: false,
  user_md: false,
  memory_md: false,
});

const fileEditableState = reactive<Record<FileFieldKey, boolean>>({
  identity_md: true,
  soul_md: true,
  user_md: true,
  memory_md: true,
});

const fileDirtyState = reactive<Record<FileFieldKey, boolean>>({
  identity_md: false,
  soul_md: false,
  user_md: false,
  memory_md: false,
});

const initialFileValues = reactive<Record<FileFieldKey, string>>({
  identity_md: "",
  soul_md: "",
  user_md: "",
  memory_md: "",
});

const isEditMode = computed(() => props.mode === "edit");
const agentTemplateOptions = computed(() =>
  AGENT_TEMPLATES.map((template) => ({
    value: template.key,
    label: t(template.labelKey),
  })),
);
const drawerTitle = computed(() =>
  isEditMode.value
    ? t("openclaw.editAgent")
    : t("openclaw.createAgent"),
);

function resetForm() {
  form.agent_id = 0;
  form.agent_key = "";
  form.display_name = "";
  form.role_name = "";
  form.identity_md = "";
  form.soul_md = "";
  form.user_md = "";
  form.memory_md = "";
}

function applyTemplate(templateKey: string) {
  const template = AGENT_TEMPLATES.find((item) => item.key === templateKey);
  if (!template) {
    return;
  }

  form.agent_key = template.agent_key;
  form.display_name = template.display_name;
  form.role_name = template.role_name;
  form.identity_md = template.identity_md;
  form.soul_md = template.soul_md;
  form.user_md = template.user_md;
  form.memory_md = template.memory_md;
}

function hasCreateFormContent() {
  return Boolean(
    form.agent_key.trim()
    || form.display_name.trim()
    || form.role_name.trim()
    || form.identity_md.trim()
    || form.soul_md.trim()
    || form.user_md.trim()
    || form.memory_md.trim(),
  );
}

function applySelectedTemplate() {
  if (isEditMode.value) {
    return;
  }

  const templateKey = selectedTemplateKey.value;
  if (templateKey !== "blank" && hasCreateFormContent()) {
    const shouldOverwrite = window.confirm(t("openclaw.agentTemplateOverwriteConfirm"));
    if (!shouldOverwrite) {
      selectedTemplateKey.value = "blank";
      return;
    }
  }

  applyTemplate(templateKey);
}

function resetFileUiState() {
  for (const field of fileFields) {
    fileExpandedState[field.key] = false;
    fileEditableState[field.key] = !isEditMode.value;
    fileDirtyState[field.key] = false;
    initialFileValues[field.key] = "";
  }
}

function toggleFileSection(field: FileFieldKey) {
  fileExpandedState[field] = !fileExpandedState[field];
}

function enableFileEdit(field: FileFieldKey) {
  fileEditableState[field] = true;
  fileExpandedState[field] = true;
}

function updateFileField(field: FileFieldKey, value: string) {
  if (isEditMode.value && !fileEditableState[field]) {
    return;
  }
  form[field] = value;
  if (isEditMode.value) {
    // 编辑状态下用“当前值 vs 初始值”做真实比对，避免改完又改回去仍被判成已修改。
    fileDirtyState[field] = value !== initialFileValues[field];
  }
}

watch(
  () => [props.visible, props.mode, props.initialValue] as const,
  ([visible]) => {
    if (!visible) {
      return;
    }

    if (props.mode === "edit" && props.initialValue) {
      form.agent_id = props.initialValue.agent_id;
      form.agent_key = props.initialValue.agent_key;
      form.display_name = props.initialValue.display_name;
      form.role_name = props.initialValue.role_name ?? "";
      form.identity_md = props.initialValue.identity_md;
      form.soul_md = props.initialValue.soul_md;
      form.user_md = props.initialValue.user_md;
      form.memory_md = props.initialValue.memory_md;
      resetFileUiState();
      initialFileValues.identity_md = props.initialValue.identity_md;
      initialFileValues.soul_md = props.initialValue.soul_md;
      initialFileValues.user_md = props.initialValue.user_md;
      initialFileValues.memory_md = props.initialValue.memory_md;
      return;
    }

    resetForm();
    resetFileUiState();
    selectedTemplateKey.value = "blank";
  },
  {immediate: true},
);

const canSubmit = computed(() => !!form.agent_key.trim() && !!form.display_name.trim());

function submit() {
  if (!canSubmit.value) {
    return;
  }

  if (isEditMode.value) {
    const payload: AgentDrawerEditPayload = {
      mode: "edit",
      agent_id: form.agent_id,
      agent_key: form.agent_key.trim(),
      display_name: form.display_name.trim(),
      role_name: form.role_name.trim(),
    };

    // 编辑模式下只提交用户真正改过的文件，避免把未触碰内容误写回远端。
    if (fileDirtyState.identity_md) {
      payload.identity_md = form.identity_md;
    }
    if (fileDirtyState.soul_md) {
      payload.soul_md = form.soul_md;
    }
    if (fileDirtyState.user_md) {
      payload.user_md = form.user_md;
    }
    if (fileDirtyState.memory_md) {
      payload.memory_md = form.memory_md;
    }

    emit("submit", {
      ...payload,
    });
    return;
  }

  emit("submit", {
    mode: "create",
    agent_key: form.agent_key.trim(),
    display_name: form.display_name.trim(),
    role_name: form.role_name.trim(),
    ...(form.identity_md.trim() ? {identity_md: form.identity_md} : {}),
    ...(form.soul_md.trim() ? {soul_md: form.soul_md} : {}),
    ...(form.user_md.trim() ? {user_md: form.user_md} : {}),
    ...(form.memory_md.trim() ? {memory_md: form.memory_md} : {}),
  });
}
</script>

<style scoped>
.drawer-body {
  display: grid;
  gap: var(--space-3);
  padding-right: 6px;
}

.drawer-shell {
  display: grid;
  gap: var(--space-4);
  min-height: 100%;
}

.drawer-instance-line {
  color: var(--color-text-secondary);
  font-size: 0.88rem;
  line-height: 1.5;
}

.agent-template-select {
  width: 100%;
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.file-sections {
  display: grid;
  gap: var(--space-3);
}

.file-section {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-panel);
}

.file-section__header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 12px 14px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.file-section__title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.file-section__title {
  font-weight: 600;
}

.file-section__edited {
  color: var(--color-accent);
  font-size: 0.85rem;
}

.file-section__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.file-section__edit-button {
  padding: 4px;
}

.file-section__arrow {
  transition: transform 0.2s ease;
}

.file-section__arrow--open {
  transform: rotate(180deg);
}

.file-section__body {
  display: grid;
  gap: var(--space-2);
  padding: 0 14px 14px;
}

.file-section__hint {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  line-height: 1.6;
}
</style>
