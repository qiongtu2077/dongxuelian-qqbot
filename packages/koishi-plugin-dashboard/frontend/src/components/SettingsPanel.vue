<template>
  <div class="card">
    <h2>访问密码</h2>
    <div style="color:var(--text2);font-size:13px;margin-bottom:12px">登录 Dashboard 所需的密码</div>
    <input v-model="accessNew" type="password" placeholder="新访问密码" style="width:100%;margin-bottom:8px" />
    <button class="btn btn-sm" @click="changeAccess" :disabled="accessLoading">{{ accessLoading ? '修改中...' : '修改访问密码' }}</button>
    <div v-if="accessMsg" style="margin-top:8px;font-size:12px" :style="{color: accessMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ accessMsg.text }}</div>
  </div>
  <div class="card">
    <h2>管理员密码</h2>
    <div style="color:var(--text2);font-size:13px;margin-bottom:12px">敏感操作（重启Bot、更换API等）所需的二级密码</div>
    <input v-model="adminOld" type="password" placeholder="当前管理员密码" style="width:100%;margin-bottom:8px" />
    <input v-model="adminNew" type="password" placeholder="新管理员密码" style="width:100%;margin-bottom:8px" />
    <button class="btn btn-sm" @click="changeAdmin" :disabled="adminLoading">{{ adminLoading ? '修改中...' : '修改管理员密码' }}</button>
    <div v-if="adminMsg" style="margin-top:8px;font-size:12px" :style="{color: adminMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ adminMsg.text }}</div>
  </div>
</template>

<script>
import { ref } from 'vue'
import { changePassword } from '../api'

export default {
  name: 'SettingsPanel',
  setup() {
    const accessNew = ref('')
    const accessLoading = ref(false)
    const accessMsg = ref(null)
    const adminOld = ref('')
    const adminNew = ref('')
    const adminLoading = ref(false)
    const adminMsg = ref(null)

    async function changeAccess() {
      if (!accessNew.value.trim()) return
      // 使用预先缓存的 admin token 或弹出管理员验证
      accessLoading.value = true; accessMsg.value = null
      const res = await changePassword('access', adminOld.value, accessNew.value.trim())
      if (res.code === 'ADMIN_REQUIRED') { accessMsg.value = { type: 'err', text: '需要管理员密码' }; accessLoading.value = false; return }
      accessMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '访问密码已更新，请重新登录' : '修改失败') }
      if (res.ok) accessNew.value = ''
      accessLoading.value = false
    }

    async function changeAdmin() {
      if (!adminOld.value.trim() || !adminNew.value.trim()) return
      adminLoading.value = true; adminMsg.value = null
      const res = await changePassword('admin', adminOld.value, adminNew.value.trim())
      if (res.code === 'ADMIN_REQUIRED') { adminMsg.value = { type: 'err', text: '当前管理员密码错误' }; adminLoading.value = false; return }
      adminMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '管理员密码已更新' : '修改失败') }
      if (res.ok) { adminOld.value = ''; adminNew.value = '' }
      adminLoading.value = false
    }

    return { accessNew, accessLoading, accessMsg, adminOld, adminNew, adminLoading, adminMsg, changeAccess, changeAdmin }
  }
}
</script>
