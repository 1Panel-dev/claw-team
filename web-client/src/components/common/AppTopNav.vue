<template>
  <header class="top-nav">
    <div class="top-nav__brand">
      <img class="top-nav__logo" src="/Logo-2.png" alt="Claw Team Logo"/>
    </div>

    <nav class="top-nav__actions">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        custom
        v-slot="{ href, navigate }"
      >
        <el-button
          :href="href"
          :type="isNavItemActive(item.to) ? 'primary' : 'default'"
          @click="navigate"
        >
          {{ t(item.labelKey) }}
        </el-button>
      </RouterLink>

      <el-select
        :model-value="locale"
        style="width: 100px"
        @update:model-value="handleLocaleChange"
      >
        <el-option
          v-for="option in localeOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>

      <el-dropdown trigger="click" @command="handleCommand">
        <el-button>
          <el-icon>
            <UserFilled/>
          </el-icon>
          <span>{{ authStore.user?.display_name ?? authStore.user?.username ?? "User" }}</span>
          <el-icon>
            <ArrowDown/>
          </el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="account">{{ t("auth.accountSettings") }}</el-dropdown-item>
            <el-dropdown-item divided command="logout">{{ t("auth.logout") }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </nav>
  </header>

  <AccountDialog
    :visible="accountDialogVisible"
    :submitting="accountSubmitting"
    :username="authStore.user?.username ?? ''"
    :display-name="authStore.user?.display_name ?? ''"
    @update:visible="accountDialogVisible = $event"
    @submit="handleAccountSubmit"
  />
</template>

<script setup lang="ts">
import type {SupportedLocale} from "@/i18n";
import {useI18n} from "@/composables/useI18n";
import {ArrowDown, UserFilled} from "@element-plus/icons-vue";
import {onMounted, ref} from "vue";
import {useRoute, useRouter} from "vue-router";

import AccountDialog from "@/components/common/AccountDialog.vue";
import {useAuthStore} from "@/stores/auth";

const {locale, localeOptions, setLocale, t} = useI18n();
const authStore = useAuthStore();
const route = useRoute();
const router = useRouter();
const accountDialogVisible = ref(false);
const accountSubmitting = ref(false);

const navItems = [
  {labelKey: "nav.messages", to: "/messages"},
  {labelKey: "nav.openclaw", to: "/openclaws"},
];

function handleLocaleChange(value: string | number | boolean) {
  if (value === "en" || value === "zh-CN") {
    setLocale(value as SupportedLocale);
  }
}

async function handleCommand(command: string) {
  if (command === "account") {
    accountDialogVisible.value = true;
    return;
  }
  if (command === "logout") {
    await authStore.logout();
    await router.replace("/login");
  }
}

async function handleAccountSubmit(payload: {
  display_name: string;
  current_password?: string;
  new_password?: string;
}) {
  accountSubmitting.value = true;
  try {
    await authStore.updateProfile(payload);
    accountDialogVisible.value = false;
    ElMessage.success(t("auth.accountUpdated"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    accountSubmitting.value = false;
  }
}

function isNavItemActive(targetPath: string) {
  return route.path === targetPath || route.path.startsWith(`${targetPath}/`);
}

onMounted(() => {
  if (typeof window === "undefined") {
    return;
  }
  if (window.localStorage.getItem("claw-team.open-account-dialog") !== "1") {
    return;
  }
  window.localStorage.removeItem("claw-team.open-account-dialog");
  accountDialogVisible.value = true;
});
</script>

<style scoped>
.top-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 58px;
  padding: 8px 14px;
  border-bottom: 1px solid #dddde2;
  background: #f3f3f5;
}

.top-nav__brand {
  display: flex;
  align-items: center;
}

.top-nav__logo {
  width: auto;
  height: 40px;
  object-fit: contain;
}

.top-nav__actions {
  display: flex;
  align-items: center;
  gap: 8px;

  .el-button + .el-button {
    margin-left: 0;
  }
}

@media (max-width: 960px) {
  .top-nav {
    flex-direction: column;
    align-items: stretch;
  }

  .top-nav__actions {
    overflow-x: auto;
  }
}
</style>
