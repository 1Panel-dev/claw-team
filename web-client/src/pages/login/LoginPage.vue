<template>
  <div class="login-page">
    <div class="login-card">
      <img class="login-card__logo" src="/Logo-2.png" alt="Claw Team Logo" />
      <h1 class="login-card__title">{{ t("auth.loginTitle") }}</h1>

      <el-form label-position="top" @submit.prevent="handleSubmit">
        <el-form-item :label="t('auth.username')">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item :label="t('auth.password')">
          <el-input v-model="form.password" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-button class="login-card__submit" type="primary" :loading="submitting" @click="handleSubmit">
          {{ t("auth.login") }}
        </el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useI18n } from "@/composables/useI18n";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const submitting = ref(false);
const form = reactive({
    username: "",
    password: "",
});

async function handleSubmit() {
    if (!form.username.trim() || !form.password) {
        return;
    }
    submitting.value = true;
    try {
        await authStore.login({
            username: form.username.trim(),
            password: form.password,
        });
        ElMessage.success(t("auth.loginSuccess"));
        if (authStore.user?.using_default_password) {
            window.localStorage.setItem("claw-team.open-account-dialog", "1");
            ElMessage.warning(t("auth.defaultPasswordWarning"));
        }
        const redirect = typeof route.query.redirect === "string" && route.query.redirect ? route.query.redirect : "/messages";
        await router.replace(redirect);
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : String(error));
    } finally {
        submitting.value = false;
    }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top left, rgba(8, 145, 178, 0.14), transparent 30%),
    radial-gradient(circle at bottom right, rgba(249, 115, 22, 0.12), transparent 26%),
    #eff2f4;
}

.login-card {
  width: min(100%, 420px);
  padding: 28px;
  border: 1px solid #d8dde3;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.10);
}

.login-card__logo {
  height: 42px;
  width: auto;
  object-fit: contain;
}

.login-card__title {
  margin: 18px 0 8px;
  font-size: 1.6rem;
  line-height: 1.2;
}

.login-card__submit {
  width: 100%;
  margin-top: 4px;
}

</style>
