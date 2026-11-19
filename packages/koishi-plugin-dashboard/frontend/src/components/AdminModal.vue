<template>
  <ConsoleDialog v-if="visible" :label="message" panel-class="admin-modal-card" @dismiss="cancel">
        <h2 class="admin-modal-title">{{ message }}</h2>
        <PasswordField
          v-model="password"
          placeholder="管理员密码"
          autocomplete="current-password"
          autofocus
          @enter="submit"
        />
        <div class="gate-actions">
          <button class="btn" @click="submit" :disabled="loading">{{ loading ? '验证中...' : '确认' }}</button>
          <button class="btn btn-ghost" @click="cancel" :disabled="loading">取消</button>
        </div>
        <div v-if="error" class="gate-error">{{ error }}</div>
  </ConsoleDialog>
</template>

<script lang="ts">
import { ref, watch } from 'vue'
import { verifyAdmin, setAdminToken } from '../api'
import { errorMessage } from '../types'
import PasswordField from './PasswordField.vue'
import ConsoleDialog from './ConsoleDialog.vue'

export default {
  name: 'AdminModal',
  components: { PasswordField, ConsoleDialog },
  props: {
    visible: { type: Boolean, default: false },
    message: { type: String, default: '请输入管理员密码' },
  },
  emits: ['verified', 'cancel'],
  setup(props, { emit }) {
    const password = ref('')
    const loading = ref(false)
    const error = ref('')

    watch(() => props.visible, (v) => {
      if (v) { password.value = ''; error.value = '' }
    })

    // 只消费当前弹窗发出的验证结果。
    let generation = 0
    watch(() => props.visible, () => { generation++; loading.value = false })
    async function submit() {
      const current = generation
      if (!password.value.trim()) return
      loading.value = true
      error.value = ''
      try {
        const res = await verifyAdmin(password.value.trim())
        if (current !== generation || !props.visible) return
        if (res.ok && res.data?.token) {
          setAdminToken(res.data.token)
          emit('verified')
        } else {
          error.value = res.data?.message || '验证失败'
        }
      } catch (e) {
        error.value = '验证失败: ' + errorMessage(e)
      }
      loading.value = false
    }

    function cancel() {
      emit('cancel')
    }

    return { password, loading, error, submit, cancel }
  }
}
</script>
