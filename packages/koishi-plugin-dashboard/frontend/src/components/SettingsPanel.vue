<template>
  <div v-if="!isElectronDeployer">
    <div class="card">
      <h2>访问密码</h2>
      <div style="color:var(--text2);font-size:13px;margin-bottom:8px">登录 Dashboard 所需的密码</div>
      <div style="color:var(--text3);font-size:11px;margin-bottom:12px">支持大小写字母、数字、下划线及特殊字符，最少 3 位</div>
      <PasswordField v-model="accessNew" placeholder="新访问密码" autocomplete="new-password" @enter="changeAccess" />
      <button class="btn btn-sm" @click="changeAccess()" :disabled="accessLoading">{{ accessLoading ? '修改中...' : '修改访问密码' }}</button>
      <div v-if="accessMsg" style="margin-top:8px;font-size:12px" :style="{color: accessMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ accessMsg.text }}</div>
    </div>
    <div class="card">
      <h2>管理员密码</h2>
      <div style="color:var(--text2);font-size:13px;margin-bottom:8px">敏感操作（重启 Bot、更换 API、部署等）所需的二次验证密码</div>
      <div style="color:var(--text3);font-size:11px;margin-bottom:12px">支持大小写字母、数字、下划线及特殊字符，最少 3 位</div>
      <PasswordField v-model="adminOld" placeholder="当前管理员密码" autocomplete="current-password" @enter="changeAdmin" />
      <PasswordField v-model="adminNew" placeholder="新管理员密码" autocomplete="new-password" @enter="changeAdmin" />
      <button class="btn btn-sm" @click="changeAdmin()" :disabled="adminLoading">{{ adminLoading ? '修改中...' : '修改管理员密码' }}</button>
      <div v-if="adminMsg" style="margin-top:8px;font-size:12px" :style="{color: adminMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ adminMsg.text }}</div>
    </div>
  </div>
</template>

<script lang="ts">
import { inject, ref } from 'vue'
import { changePassword, clearDashboardSession } from '../api'
import type { MessageState, ShowAdminDialog } from '../types'
import { messageFromData } from '../types'
import PasswordField from './PasswordField.vue'

export default {
  name: 'SettingsPanel',
  components: { PasswordField },
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const isElectronDeployer = inject('isElectronDeployer', false)
    const accessNew = ref('')
    const accessLoading = ref(false)
    const accessMsg = ref<MessageState | null>(null)
    const adminOld = ref('')
    const adminNew = ref('')
    const adminLoading = ref(false)
    const adminMsg = ref<MessageState | null>(null)

    // Changes the access password and invalidates both authentication layers on success.
    async function changeAccess(retried = false) {
      if (!accessNew.value.trim()) return
      // 使用预先缓存的管理员 token 或弹出管理员密码验证
      accessLoading.value = true; accessMsg.value = null
      const res = await changePassword('access', adminOld.value, accessNew.value.trim())
      if (res.code === 'ADMIN_REQUIRED') {
        if (!retried && showAdminDialog) showAdminDialog('修改访问密码需要管理员密码', () => changeAccess(true))
        else accessMsg.value = { type: 'err', text: '管理员验证后修改访问密码仍被拒绝' }
        accessLoading.value = false
        return
      }
      accessMsg.value = { type: res.ok ? 'ok' : 'err', text: messageFromData(res.data, res.ok ? '访问密码已更新，请重新登录' : '修改失败') }
      if (res.ok) {
        accessNew.value = ''
        clearDashboardSession('密码已修改，请重新登录')
      }
      accessLoading.value = false
    }

    // Changes the administrator password and invalidates both authentication layers on success.
    async function changeAdmin(retried = false) {
      if (!adminOld.value.trim() || !adminNew.value.trim()) return
      adminLoading.value = true; adminMsg.value = null
      const res = await changePassword('admin', adminOld.value, adminNew.value.trim())
      if (res.code === 'ADMIN_REQUIRED') {
        if (!retried && showAdminDialog) showAdminDialog('修改管理员密码需要当前管理员密码', () => changeAdmin(true))
        else adminMsg.value = { type: 'err', text: '管理员验证后修改管理员密码仍被拒绝' }
        adminLoading.value = false
        return
      }
      adminMsg.value = { type: res.ok ? 'ok' : 'err', text: messageFromData(res.data, res.ok ? '管理员密码已更新' : '修改失败') }
      if (res.ok) {
        adminOld.value = ''
        adminNew.value = ''
        clearDashboardSession('密码已修改，请重新登录')
      }
      adminLoading.value = false
    }

    return { isElectronDeployer, accessNew, accessLoading, accessMsg, adminOld, adminNew, adminLoading, adminMsg, changeAccess, changeAdmin }
  }
}
</script>
