<template>
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg)">
    <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;padding:40px;width:380px;max-width:90vw">
      <h1 style="font-size:22px;text-align:center;margin-bottom:8px;background:linear-gradient(135deg,#39C5BB,#5EEAD4,#FCD34D);-webkit-background-clip:text;-webkit-text-fill-color:transparent">莲莲 Bot 控制台</h1>
      <p style="color:var(--text2);font-size:14px;text-align:center;margin-bottom:28px">请输入密码以继续</p>

      <input
        ref="inputRef"
        v-model="password"
        type="password"
        placeholder="密码"
        style="width:100%;margin-bottom:16px"
        @keyup.enter="doLogin"
      />

      <button class="btn" style="width:100%" @click="doLogin" :disabled="loading">
        {{ loading ? '验证中...' : '登录' }}
      </button>

      <div v-if="error" style="color:#F472B6;font-size:13px;text-align:center;margin-top:12px">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { login } from '../api'

export default {
  name: 'LoginPage',
  setup(props, { emit }) {
    const password = ref('')
    const loading = ref(false)
    const error = ref('')
    const inputRef = ref(null)

    onMounted(() => {
      if (!localStorage.getItem('dashboard_token')) {
        // 尝试空密码自动登录（本地模式/默认密码）
        ;(async () => {
          const res = await login('')
          if (res.ok && res.data?.token) {
            localStorage.setItem('dashboard_token', res.data.token)
            emit('logged-in')
          } else if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
            inputRef.value?.focus()
          }
        })()
      }
    })

    async function doLogin() {
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

    return { password, loading, error, inputRef, doLogin }
  }
}
</script>
