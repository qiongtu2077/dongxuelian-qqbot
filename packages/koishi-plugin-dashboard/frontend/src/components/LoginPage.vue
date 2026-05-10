<template>
  <div class="gate-page login-page">
    <LoginBackdrop />
    <div
      ref="panelRef"
      class="gate-panel draggable-panel"
      :style="panelStyle"
      @mousedown="startDrag"
    >
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

      <div style="text-align:center;margin-top:14px">
        <a href="#" style="color:var(--text3);font-size:12px;text-decoration:none" @click.prevent="showReset = !showReset">忘记密码?</a>
      </div>

      <Transition name="fade">
        <div v-if="showReset" style="margin-top:14px;padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--input)">
          <div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.6">
            请通过 SSH 登录服务器，执行以下命令查看重置令牌：
          </div>
          <div style="background:#0d1117;border-radius:6px;padding:8px 12px;font-family:monospace;font-size:12px;color:#58a6ff;margin-bottom:10px;word-break:break-all">
            cat data/password-reset-token.txt
          </div>
          <input v-model="resetToken" placeholder="粘贴重置令牌" style="width:100%;font-family:monospace;font-size:13px;margin-bottom:8px" />
          <button class="btn btn-sm" style="width:100%" @click="doReset" :disabled="resetting">{{ resetting ? '重置中...' : '重置所有密码' }}</button>
          <div v-if="resetMsg" style="margin-top:8px;font-size:12px;text-align:center" :style="{color: resetMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ resetMsg.text }}</div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { login, resetPassword } from '../api'
import LoginBackdrop from './LoginBackdrop.vue'
import PasswordField from './PasswordField.vue'

export default {
  name: 'LoginPage',
  components: { LoginBackdrop, PasswordField },
  setup(props, { emit }) {
    const password = ref('')
    const loading = ref(false)
    const error = ref('')
    const panelRef = ref(null)
    const showReset = ref(false)
    const resetToken = ref('')
    const resetting = ref(false)
    const resetMsg = ref(null)

    const drag = reactive({ active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 })

    const panelStyle = computed(() => {
      if (drag.offsetX === 0 && drag.offsetY === 0) return {}
      return { transform: `translate(${drag.offsetX}px, ${drag.offsetY}px)` }
    })

    function startDrag(e) {
      if (e.target.closest('input, button, a')) return
      drag.active = true
      drag.startX = e.clientX - drag.offsetX
      drag.startY = e.clientY - drag.offsetY
      e.preventDefault()
    }

    function onDrag(e) {
      if (!drag.active) return
      const panel = panelRef.value
      if (!panel) return
      const rect = panel.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      let nx = e.clientX - drag.startX
      let ny = e.clientY - drag.startY
      const centerX = (vw - rect.width) / 2
      const centerY = (vh - rect.height) / 2
      const minX = -centerX
      const maxX = vw - rect.width - centerX
      const minY = -centerY
      const maxY = vh - rect.height - centerY
      drag.offsetX = Math.max(minX, Math.min(maxX, nx))
      drag.offsetY = Math.max(minY, Math.min(maxY, ny))
    }

    function stopDrag() { drag.active = false }

    onMounted(() => {
      window.addEventListener('mousemove', onDrag)
      window.addEventListener('mouseup', stopDrag)
      if (window.dongxuelianDeployer) doLogin()
    })
    onUnmounted(() => {
      window.removeEventListener('mousemove', onDrag)
      window.removeEventListener('mouseup', stopDrag)
    })

    async function doLogin() {
      if (!password.value.trim() && !window.dongxuelianDeployer) return
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

    async function doReset() {
      if (!resetToken.value.trim()) return
      resetting.value = true
      resetMsg.value = null
      try {
        const res = await resetPassword(resetToken.value.trim())
        if (res.ok) {
          resetMsg.value = { type: 'ok', text: res.data?.message || '密码已重置为 123' }
          resetToken.value = ''
        } else {
          resetMsg.value = { type: 'err', text: res.data?.message || '重置失败' }
        }
      } catch (e) {
        resetMsg.value = { type: 'err', text: e.message }
      }
      resetting.value = false
    }

    return { password, loading, error, doLogin, panelRef, panelStyle, startDrag, showReset, resetToken, resetting, resetMsg, doReset }
  }
}
</script>
