<template>
  <div class="gate-page login-page">
    <div class="login-bg active" :style="{ backgroundImage: `url(${activeBackground})` }"></div>
    <div v-if="previousBackground" class="login-bg leaving" :style="{ backgroundImage: `url(${previousBackground})` }"></div>
    <div class="login-vignette"></div>
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
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { login } from '../api'
import PasswordField from './PasswordField.vue'

export default {
  name: 'LoginPage',
  components: { PasswordField },
  setup(props, { emit }) {
    const password = ref('')
    const loading = ref(false)
    const error = ref('')
    const base = import.meta.env.BASE_URL || '/dashboard/'
    const backgrounds = Array.from({ length: 6 }, (_, index) => `${base}backgrounds/login-bg-${index + 1}.png`)
    const activeIndex = ref(Math.floor(Math.random() * backgrounds.length))
    const previousIndex = ref(null)
    let timer = null

    const activeBackground = computed(() => backgrounds[activeIndex.value])
    const previousBackground = computed(() => previousIndex.value === null ? '' : backgrounds[previousIndex.value])

    function rotateBackground() {
      previousIndex.value = activeIndex.value
      activeIndex.value = (activeIndex.value + 1) % backgrounds.length
      setTimeout(() => { previousIndex.value = null }, 1300)
    }

    onMounted(() => { timer = setInterval(rotateBackground, 5000) })
    onUnmounted(() => { if (timer) clearInterval(timer) })

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

    return { password, loading, error, activeBackground, previousBackground, doLogin }
  }
}
</script>
