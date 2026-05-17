<template>
  <div class="login-page">
    <LoginBackdrop />
    <div class="login-spacer"></div>
    <div class="login-sidebar">
      <div class="login-sidebar-inner">
        <div class="gate-kicker">LianBoard</div>
        <h1 class="gate-title">莲莲 Bot 控制台</h1>
        <template v-if="!electronDeployer">
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
            <code class="code-snippet">cat data/password-reset-token.txt</code>
            <input v-model="resetToken" placeholder="粘贴重置令牌" style="width:100%;font-family:monospace;font-size:13px;margin-bottom:8px" />
            <button class="btn btn-sm" style="width:100%" @click="doReset" :disabled="resetting">{{ resetting ? '重置中...' : '重置所有密码' }}</button>
            <div v-if="resetMsg" style="margin-top:8px;font-size:12px;text-align:center" :style="{color: resetMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ resetMsg.text }}</div>
          </div>
        </Transition>
        </template>

        <p v-else class="gate-copy" style="color:var(--text2);font-size:13px;margin-top:8px">
          打包部署器模式，直接进入控制台。
        </p>

        <div v-if="electronDeployer && loading" style="margin-top:12px;color:var(--text3);font-size:13px;text-align:center">正在登录…</div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { login, resetPassword } from '../api'
import { isElectronDeployerEnv } from '../electron-deployer'
import LoginBackdrop from './LoginBackdrop.vue'
import PasswordField from './PasswordField.vue'

export default {
  name: 'LoginPage',
  components: { LoginBackdrop, PasswordField },
  setup(props, { emit }) {
    const electronDeployer = isElectronDeployerEnv()
    const password = ref('')
    const loading = ref(false)
    const error = ref('')
    const showReset = ref(false)
    const resetToken = ref('')
    const resetting = ref(false)
    const resetMsg = ref(null)

    onMounted(() => {
      if (electronDeployer) doLogin()
    })

    async function doLogin() {
      if (!password.value.trim() && !electronDeployer) return
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

    return { electronDeployer, password, loading, error, doLogin, showReset, resetToken, resetting, resetMsg, doReset }
  }
}
</script>
