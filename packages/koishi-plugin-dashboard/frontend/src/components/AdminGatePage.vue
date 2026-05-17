<template>
  <div class="gate-page">
    <div class="gate-panel">
      <div class="gate-kicker">Admin Access</div>
      <h1 class="gate-title">莲莲 Bot 控制台</h1>
      <p class="gate-copy">{{ message }}</p>

      <p v-if="electronDeployer" class="gate-copy" style="color:var(--text2);font-size:13px">
        打包部署器模式下将自动验证。
      </p>

      <PasswordField
        v-if="!electronDeployer"
        v-model="password"
        placeholder="管理员密码"
        autocomplete="current-password"
        autofocus
        @enter="submit"
      />

      <div v-if="!electronDeployer" class="gate-actions">
        <button class="btn" @click="submit" :disabled="loading">{{ loading ? '验证中...' : '进入控制台' }}</button>
        <button v-if="allowCancel" class="btn btn-ghost" @click="cancel" :disabled="loading">取消</button>
      </div>

      <div v-if="electronDeployer && loading" class="gate-actions">
        <span class="gate-copy" style="color:var(--text3)">正在验证…</span>
      </div>

      <div v-if="error" class="gate-error">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { verifyAdmin, setAdminToken } from '../api'
import { isElectronDeployerEnv } from '../electron-deployer'
import PasswordField from './PasswordField.vue'

export default {
  name: 'AdminGatePage',
  components: { PasswordField },
  props: {
    message: { type: String, default: '请输入管理员密码' },
    allowCancel: { type: Boolean, default: false },
  },
  emits: ['verified', 'cancel'],
  setup(props, { emit }) {
    const electronDeployer = isElectronDeployerEnv()
    const password = ref('')
    const loading = ref(false)
    const error = ref('')

    async function submit() {
      if (!password.value.trim() && !electronDeployer) return
      loading.value = true
      error.value = ''
      try {
        const res = await verifyAdmin(password.value.trim())
        if (res.ok && res.data?.token) {
          setAdminToken(res.data.token)
          password.value = ''
          emit('verified')
        } else {
          error.value = res.data?.message || '验证失败'
        }
      } catch (err) {
        error.value = err.message
      }
      loading.value = false
    }

    function cancel() {
      password.value = ''
      error.value = ''
      emit('cancel')
    }

    onMounted(() => {
      if (electronDeployer) submit()
    })

    return { electronDeployer, password, loading, error, submit, cancel }
  },
}
</script>
