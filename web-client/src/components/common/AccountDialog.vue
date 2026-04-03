<template>
  <el-dialog
    :model-value="visible"
    :title="t('auth.accountSettings')"
    width="460px"
    @close="emit('update:visible', false)"
  >
    <el-form label-position="top">
      <el-form-item :label="t('auth.username')">
        <div class="account-dialog__static-value">{{ username }}</div>
      </el-form-item>
      <el-form-item :label="t('auth.displayName')">
        <el-input v-model="form.display_name" maxlength="120" />
      </el-form-item>
      <el-form-item :label="t('auth.currentPassword')">
        <el-input v-model="form.current_password" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-form-item :label="t('auth.newPassword')">
        <el-input v-model="form.new_password" type="password" show-password autocomplete="new-password" />
      </el-form-item>
      <el-form-item :label="t('auth.confirmPassword')">
        <el-input v-model="form.confirm_password" type="password" show-password autocomplete="new-password" />
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="account-dialog__footer">
        <el-button @click="emit('update:visible', false)">{{ t("common.cancel") }}</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSave">{{ t("common.save") }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, watch } from "vue";

import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
    visible: boolean;
    submitting: boolean;
    username: string;
    displayName: string;
}>();

const emit = defineEmits<{
    "update:visible": [value: boolean];
    submit: [{
        display_name: string;
        current_password?: string;
        new_password?: string;
    }];
}>();

const { t } = useI18n();
const form = reactive({
    display_name: "",
    current_password: "",
    new_password: "",
    confirm_password: "",
});

watch(
    () => props.visible,
    (visible) => {
        if (!visible) {
            return;
        }
        form.display_name = props.displayName;
        form.current_password = "";
        form.new_password = "";
        form.confirm_password = "";
    },
);

function handleSave() {
    const displayName = form.display_name.trim();
    const currentPassword = form.current_password;
    const newPassword = form.new_password.trim();
    const confirmPassword = form.confirm_password.trim();

    if (!displayName) {
        ElMessage.error(t("auth.accountRequired"));
        return;
    }
    if (newPassword || confirmPassword) {
        if (!currentPassword) {
            ElMessage.error(t("auth.currentPasswordRequired"));
            return;
        }
        if (newPassword !== confirmPassword) {
            ElMessage.error(t("auth.passwordMismatch"));
            return;
        }
        if (newPassword.length < 8) {
            ElMessage.error(t("auth.passwordTooShort"));
            return;
        }
    }

    emit("submit", {
        display_name: displayName,
        current_password: currentPassword || undefined,
        new_password: newPassword || undefined,
    });
}
</script>

<style scoped>
.account-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.account-dialog__static-value {
  color: #303133;
  line-height: 32px;
}
</style>
