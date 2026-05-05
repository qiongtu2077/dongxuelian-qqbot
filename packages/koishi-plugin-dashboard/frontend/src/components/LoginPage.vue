<template>
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1923">
    <div style="background:#1a2634;border:1px solid #2a3a4a;border-radius:16px;padding:40px;width:380px;max-width:90vw">
      <h1 style="color:#39C5BB;font-size:22px;text-align:center;margin-bottom:8px">莲莲 Bot 控制台</h1>
      <p style="color:#64748B;font-size:14px;text-align:center;margin-bottom:28px">请输入密码以继续</p>

      <input
        v-model="password"
        type="password"
        placeholder="密码"
        style="width:100%;margin-bottom:16px"
        @keyup.enter="doLogin"
        autofocus
      />

      <button class="btn" style="width:100%" @click="doLogin" :disabled="loading">
        {{ loading ? '验证中...' : '登录' }}
      </button>

      <div v-if="error" style="color:#F472B6;font-size:13px;text-align:center;margin-top:12px">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue'
import { login } from '../api'

export default {
  name: 'LoginPage',
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
