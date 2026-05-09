<template>
  <div class="gate-page">
    <div class="gate-panel">
      <div class="gate-kicker">Server Access</div>
      <h1 class="gate-title">莲莲 Bot 控制台</h1>
      <p class="gate-copy">{{ message }}</p>

      <PasswordField
        v-model="password"
        placeholder="服务器密码"
        autocomplete="current-password"
        autofocus
        @enter="submit"
      />

      <div class="gate-actions">
        <button class="btn" @click="submit" :disabled="loading">{{ loading ? '验证中...' : '进入控制台' }}</button>
        <button v-if="allowCancel" class="btn btn-ghost" @click="cancel" :disabled="loading">取消</button>
      </div>

      <div v-if="error" class="gate-error">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue'
import { verifyAdmin, setAdminToken } from '../api'
import PasswordField from './PasswordField.vue'

export default {
  name: 'AdminGatePage',
  components: { PasswordField },
  props: {
    message: { type: String, default: '请输入服务器密码' },
    allowCancel: { type: Boolean, default: false },
  },
  emits: ['verified', 'cancel'],
  setup(props, { emit }) {
    const password = ref('')
    const loading = ref(false)
    const error = ref('')

    async function submit() {
      if (!password.value.trim()) return
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

    return { password, loading, error, submit, cancel }
  },
}
</script>
