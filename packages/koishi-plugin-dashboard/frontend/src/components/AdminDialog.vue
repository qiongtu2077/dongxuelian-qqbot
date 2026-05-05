<template>
  <div v-if="visible" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000">
    <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;width:360px;max-width:90vw">
      <h2 style="margin-bottom:8px;color:#F472B6">管理员验证</h2>
      <p style="color:var(--text2);font-size:13px;margin-bottom:16px">{{ message }}</p>
      <input
        v-model="password"
        type="password"
        placeholder="管理员密码"
        style="width:100%;margin-bottom:12px"
        @keyup.enter="submit"
        autofocus
      />
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" @click="submit" :disabled="loading">{{ loading ? '验证中...' : '确认' }}</button>
        <button class="btn btn-sm" style="background:var(--border);color:var(--text2);flex:1" @click="cancel">取消</button>
      </div>
      <div v-if="error" style="color:#F472B6;font-size:12px;margin-top:8px">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue'
import { verifyAdmin, setAdminToken } from '../api'

export default {
  name: 'AdminDialog',
  props: { message: { type: String, default: '此操作需要管理员密码验证' } },
  emits: ['verified', 'cancel'],
  setup(props, { emit }) {
    const visible = ref(false)
    const password = ref('')
    const loading = ref(false)
    const error = ref('')

    function show() { visible.value = true; password.value = ''; error.value = '' }

    async function submit() {
      if (!password.value.trim()) return
      loading.value = true; error.value = ''
      const res = await verifyAdmin(password.value.trim())
      if (res.ok && res.data?.token) {
        setAdminToken(res.data.token)
        visible.value = false
        emit('verified')
      } else {
        error.value = res.data?.message || '验证失败'
      }
      loading.value = false
    }

    function cancel() { visible.value = false; emit('cancel') }

    return { visible, password, loading, error, show, submit, cancel }
  }
}
</script>
