<template>
  <el-drawer
    :model-value="visible"
    :title="drawerTitle"
    size="620px"
    destroy-on-close
    @close="emit('update:visible', false)"
  >
    <div class="drawer-body">
      <el-form label-position="top">
        <el-form-item :label="t('openclaw.instanceName')">
          <el-input v-model="form.name" maxlength="120" :placeholder="t('openclaw.instanceNamePlaceholder')" />
        </el-form-item>

        <el-form-item :label="t('openclaw.openclawUrl')">
          <el-input v-model="form.channel_base_url" placeholder="例如：https://172.16.200.119:18789" />
        </el-form-item>
      </el-form>

      <el-form v-if="credentials" label-position="top">
        <el-form-item :label="t('openclaw.outboundToken')">
          <el-input :model-value="maskedSecret(credentials.outbound_token)" readonly>
            <template #append>
              <el-button text @click="copyCredential('outbound_token')">
                <el-icon><DocumentCopy /></el-icon>
              </el-button>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item :label="t('openclaw.inboundSigningSecret')">
          <el-input :model-value="maskedSecret(credentials.inbound_signing_secret)" readonly>
            <template #append>
              <el-button text @click="copyCredential('inbound_signing_secret')">
                <el-icon><DocumentCopy /></el-icon>
              </el-button>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="drawer-label-with-tip">
              <span>{{ t("openclaw.gatewayToken") }}</span>
              <el-tooltip :content="t('openclaw.gatewayTokenHint')" placement="top">
                <el-icon class="drawer-label-tip"><InfoFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input v-model="form.gateway_token" :placeholder="t('openclaw.gatewayTokenPlaceholder')" />
        </el-form-item>

        <el-form-item>
          <el-checkbox v-model="form.include_intermediate_messages">
            {{ t("openclaw.includeIntermediateMessages") }}
          </el-checkbox>
          <div class="drawer-config-help">{{ t("openclaw.includeIntermediateMessagesHelp") }}</div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="drawer-label-with-tip">
              <span>{{ t("openclaw.openclawJsonConfig") }}</span>
              <el-tooltip :content="t('openclaw.copyOpenclawJsonConfig')" placement="top">
                <el-button text @click="copyOpenClawConfig">
                  <el-icon><DocumentCopy /></el-icon>
                </el-button>
              </el-tooltip>
            </span>
          </template>
          <el-input
            :model-value="maskedOpenClawConfig"
            type="textarea"
            readonly
            :autosize="{ minRows: 12, maxRows: 18 }"
          />
          <div class="drawer-config-help">{{ t("openclaw.openclawJsonConfigHelp") }}</div>
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="drawer-actions">
        <el-button @click="emit('update:visible', false)">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
          {{ submitLabel }}
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 这个对话框负责新增 OpenClaw 实例。
 *
 * 第一阶段先只收集调度中心对接 channel 所需的最小字段，
 * 这样能尽快把实例管理链路补齐，而不把高级配置过早塞进 UI。
 */
import { computed, reactive, watch } from "vue";
import { DocumentCopy, InfoFilled } from "@element-plus/icons-vue";
import { useI18n } from "@/composables/useI18n";
import type { InstanceCredentialsReadApi } from "@/types/api/instance";

const props = defineProps<{
    visible: boolean;
    submitting: boolean;
    mode?: "create" | "edit";
    initialValue?: {
        id: number;
        name: string;
        channel_base_url: string;
        channel_account_id: string;
    } | null;
    credentials?: InstanceCredentialsReadApi | null;
}>();

const emit = defineEmits<{
    "update:visible": [value: boolean];
    submit: [payload:
        | {
            mode: "create";
            name: string;
            channel_base_url: string;
            channel_account_id: string;
        }
        | {
            mode: "edit";
            instance_id: number;
            name: string;
            channel_base_url: string;
            channel_account_id: string;
        }
    ];
}>();

const form = reactive({
    name: "",
    channel_base_url: "",
    channel_account_id: "default",
    gateway_token: "",
    include_intermediate_messages: true,
});
const { t } = useI18n();

const mode = computed(() => props.mode ?? "create");
const drawerTitle = computed(() => (mode.value === "edit" ? t("openclaw.drawerEditTitle") : t("openclaw.drawerCreateTitle")));
const submitLabel = computed(() => t("common.save"));

watch(
    () => props.visible,
    (visible) => {
        if (!visible) {
            return;
        }
        if (mode.value === "edit" && props.initialValue) {
            form.name = props.initialValue.name;
            form.channel_base_url = props.initialValue.channel_base_url;
            form.channel_account_id = props.initialValue.channel_account_id;
            form.gateway_token = "";
            form.include_intermediate_messages = true;
            return;
        }
        form.name = "";
        form.channel_base_url = "";
        form.channel_account_id = "default";
        form.gateway_token = "";
        form.include_intermediate_messages = true;
    },
);

const canSubmit = computed(
    () =>
        !!form.name.trim()
        && !!form.channel_base_url.trim(),
);

function submit() {
    if (!canSubmit.value) {
        return;
    }
    if (mode.value === "edit" && props.initialValue) {
        emit("submit", {
            mode: "edit",
            instance_id: props.initialValue.id,
            name: form.name.trim(),
            channel_base_url: form.channel_base_url.trim(),
            channel_account_id: form.channel_account_id.trim(),
        });
        return;
    }
    emit("submit", {
        mode: "create",
        name: form.name.trim(),
        channel_base_url: form.channel_base_url.trim(),
        channel_account_id: form.channel_account_id.trim(),
    });
}

function maskedSecret(value: string) {
    return value ? "••••••••••••••••••••••••" : "";
}

function buildOpenClawConfig(maskSecrets: boolean) {
    if (!props.credentials) {
        return "";
    }
    const backendBaseUrl = resolveBackendBaseUrl();
    const fullConfig = JSON.stringify({
        plugins: {
            allow: [
                "claw-team",
            ],
            entries: {
                "claw-team": {
                    enabled: true,
                    config: {},
                },
            },
        },
        skills: {
            load: {
                extraDirs: [
                    "/home/node/.openclaw/extensions/claw-team/skills",
                ],
            },
            entries: {
                "ct-chat": {
                    enabled: true,
                },
            },
        },
        channels: {
            "claw-team": {
                accounts: {
                    default: {
                        enabled: true,
                        baseUrl: backendBaseUrl,
                        outboundToken: maskSecrets ? maskedSecret(props.credentials.outbound_token) : props.credentials.outbound_token,
                        inboundSigningSecret: maskSecrets ? maskedSecret(props.credentials.inbound_signing_secret) : props.credentials.inbound_signing_secret,
                        webchatMirror: {
                            includeIntermediateMessages: form.include_intermediate_messages,
                        },
                        gateway: {
                            baseUrl: form.channel_base_url.trim(),
                            token: maskSecrets ? maskedSecret(form.gateway_token.trim()) : form.gateway_token.trim(),
                            model: "openclaw",
                            stream: true,
                            allowInsecureTls: true,
                        },
                        agentDirectory: {
                            allowedAgentIds: ["main"],
                            aliases: {},
                        },
                    },
                },
            },
        },
    }, null, 2);

    return `${fullConfig.replace(/^\{\n/, "").replace(/\n\}$/, "")},`;
}

const generatedOpenClawConfig = computed(() => buildOpenClawConfig(false));
const maskedOpenClawConfig = computed(() => buildOpenClawConfig(true));

function resolveBackendBaseUrl() {
    const explicit = import.meta.env.VITE_API_BASE_URL?.trim();
    if (explicit) {
        return explicit;
    }
    const devProxyTarget = import.meta.env.VITE_DEV_API_PROXY_TARGET?.trim();
    if (devProxyTarget) {
        return devProxyTarget;
    }
    if (typeof window !== "undefined" && window.location?.origin) {
        return window.location.origin;
    }
    return "http://127.0.0.1:18080";
}

async function copyCredential(key: keyof InstanceCredentialsReadApi) {
    if (!props.credentials) {
        return;
    }
    const value = props.credentials[key];
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
        } else {
            const textarea = document.createElement("textarea");
            textarea.value = value;
            textarea.setAttribute("readonly", "true");
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(textarea);
            if (!copied) {
                throw new Error(t("openclaw.copyFailed"));
            }
        }
        ElMessage.success(t("openclaw.copySuccess"));
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : String(error));
    }
}

async function copyOpenClawConfig() {
    const copyValue = generatedOpenClawConfig.value;
    if (!copyValue) {
        return;
    }
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(copyValue);
        } else {
            const textarea = document.createElement("textarea");
            textarea.value = copyValue;
            textarea.setAttribute("readonly", "true");
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(textarea);
            if (!copied) {
                throw new Error(t("openclaw.copyFailed"));
            }
        }
        form.gateway_token = "";
        ElMessage.success(t("openclaw.copySuccess"));
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : String(error));
    }
}
</script>

<style scoped>
.drawer-body {
  display: grid;
  gap: var(--space-3);
  padding-right: 6px;
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.drawer-label-with-tip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.drawer-label-tip {
  color: #909399;
  cursor: help;
}

.drawer-config-help {
  margin-bottom: 8px;
  color: #606266;
  font-size: 0.92rem;
  line-height: 1.5;
  white-space: pre-line;
}

</style>
