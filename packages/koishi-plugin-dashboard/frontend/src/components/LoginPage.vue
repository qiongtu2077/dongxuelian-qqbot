<template>
  <div class="gate-page">
    <div class="gate-panel">
      <div class="gate-kicker">LianBoard</div>
      <h1 class="gate-title">莲莲 Bot 控制台</h1>
      <p class="gate-copy">请输入访问密码以继续</p>

      <PasswordField
        v-model="password"
        placeholder="密码"
        autocomplete="current-password"
        autofocus
        @enter="doLogin"
      />

      <button class="btn gate-submit" @click="doLogin" :disabled="loading">
        {{ loading ? '验证中...' : '登录' }}
      </button>

      <div v-if="error" class="gate-error">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue'
import { login } from '../api'
import PasswordField from './PasswordField.vue'

export default {
  name: 'LoginPage',
  components: { PasswordField },
  setup(props, { emit }) {
    const password = ref('')
    const loading = ref(false)
    const error = ref('')

    async function doLogin() {
      if (!password.value.trim()) return
      loading.value = true
      error.value = ''
      try {
        const res = await login(password.value.trim())
        if (res.ok && res.data?.token) {
          localStorage.setItem('dashboard_token', res.data.token)
          emit('logged-in')
        } else {
          error.value = res.data?.message || '登录失败'
        }
      } catch (e) {
        error.value = e.message
      }
      loading.value = false
    }

    return { password, loading, error, doLogin }
  }
}
</script>
