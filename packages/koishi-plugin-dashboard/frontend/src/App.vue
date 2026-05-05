<template>
  <LoginPage v-if="!loggedIn" @logged-in="loggedIn = true" />
  <div v-else class="app" style="position:relative">
    <CursorGlow />
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;position:relative;z-index:1">
      <h1 style="margin:0">莲莲 Bot 控制台</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm" style="background:var(--tabBg);color:var(--tabColor);border:1px solid var(--tabBorder);font-size:16px;line-height:1" @click="toggleTheme">{{ themeIcon }}</button>
        <button class="btn btn-sm" style="background:var(--tabBg);color:var(--tabColor);border:1px solid var(--tabBorder)" @click="logout">退出登录</button>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;position:relative;z-index:1">
      <button v-for="t in tabs" :key="t.id"
        :class="['tab-btn', { active: activeTab === t.id, pulse: pulsingTab === t.id }]"
        @click="doSwitchTab(t.id)">{{ t.label }}</button>
    </div>

    <div style="position:relative;z-index:1">
      <KeepAlive>
        <ConfigPanel v-if="activeTab === 'config'" key="config" />
        <ControlPanel v-else-if="activeTab === 'control'" key="control" />
        <KeyManager v-else-if="activeTab === 'keys'" key="keys" />
        <PersonaPanel v-else-if="activeTab === 'persona'" key="persona" />
        <CommandBrowser v-else-if="activeTab === 'features'" key="features" />
        <CommandList v-else-if="activeTab === 'commands'" key="commands" />
        <WhitelistPanel v-else-if="activeTab === 'whitelist'" key="whitelist" />
        <SettingsPanel v-else-if="activeTab === 'settings'" key="settings" />
        <StatusPanel v-else-if="activeTab === 'status'" key="status" />
      </KeepAlive>
    </div>
    <!-- 全局管理员验证弹窗 -->
    <AdminDialog ref="globalAdmin" :message="adminMsg" @verified="onAdminVerified" @cancel="adminPending=null" />
  </div>
</template>

<script>
import { ref } from 'vue'
import LoginPage from './components/LoginPage.vue'
import CursorGlow from './components/CursorGlow.vue'
import ConfigPanel from './components/ConfigPanel.vue'
import ControlPanel from './components/ControlPanel.vue'
import KeyManager from './components/KeyManager.vue'
import PersonaPanel from './components/PersonaPanel.vue'
import CommandBrowser from './components/CommandBrowser.vue'
import CommandList from './components/CommandList.vue'
import WhitelistPanel from './components/WhitelistPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatusPanel from './components/StatusPanel.vue'
import AdminDialog from './components/AdminDialog.vue'

export default {
  components: { LoginPage, CursorGlow, ControlPanel, ConfigPanel, KeyManager, PersonaPanel, CommandBrowser, CommandList, WhitelistPanel, SettingsPanel, StatusPanel, AdminDialog },
  setup() {
    const loggedIn = ref(!!localStorage.getItem('dashboard_token'))
    const theme = ref(localStorage.getItem('dashboard_theme') || 'dark')
    const themeIcon = ref(theme.value === 'dark' ? '切换浅色' : '切换深色')

    function applyTheme(t) {
      document.documentElement.setAttribute('data-theme', t)
      localStorage.setItem('dashboard_theme', t)
    }
    applyTheme(theme.value)

    function toggleTheme() {
      theme.value = theme.value === 'dark' ? 'light' : 'dark'
      themeIcon.value = theme.value === 'dark' ? '切换浅色' : '切换深色'
      applyTheme(theme.value)
    }

    const tabs = [
      { id: 'control', label: '控制' },
      { id: 'config', label: '模型配置' },
      { id: 'keys', label: 'API Keys' },
      { id: 'persona', label: '人格管理' },
      { id: 'features', label: '功能介绍' },
      { id: 'commands', label: '指令速查' },
      { id: 'whitelist', label: '白名单' },
      { id: 'settings', label: '密码' },
      { id: 'status', label: '状态' },
    ]
    const activeTab = ref('features')
    const pulsingTab = ref(null)
    const globalAdmin = ref(null)
    const adminMsg = ref('需要管理员密码')
    const adminPending = ref(null)

    function onAdminVerified() {
      if (adminPending.value) { const fn = adminPending.value; adminPending.value = null; fn() }
    }

    // 全局管理员验证入口：子组件通过 window 调用
    window.showAdminDialog = (msg, onVerified) => {
      adminMsg.value = msg
      adminPending.value = onVerified
      globalAdmin.value?.show()
    }

    function doSwitchTab(id) {
      if (id !== activeTab.value) {
        pulsingTab.value = id
        setTimeout(() => { pulsingTab.value = null }, 600)
      }
      activeTab.value = id
    }

    function logout() {
      localStorage.removeItem('dashboard_token')
      loggedIn.value = false
    }

    return { loggedIn, tabs, activeTab, pulsingTab, globalAdmin, adminMsg, logout, themeIcon, toggleTheme, doSwitchTab }
  }
}
</script>
