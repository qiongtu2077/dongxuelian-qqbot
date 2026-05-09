<template>
  <LoginPage v-if="!loggedIn" @logged-in="onLoggedIn" />
  <AdminGatePage v-else-if="!adminReady" :message="adminMsg" :allow-cancel="adminCanCancel" @verified="onAdminVerified" @cancel="onAdminCancel" />
  <template v-else>
    <LoginBackdrop v-if="!deployUnlocked" />
    <div class="app" style="position:relative">
      <CursorGlow />
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;position:relative;z-index:1">
      <h1 style="margin:0">莲莲 Bot 控制台</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="icon-btn" type="button" :aria-label="'界面风格：' + currentThemeLabel" @click="themePickerOpen = true">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3 3h-1.5a2 2 0 0 0-1.5 3.32A9 9 0 0 0 12 3Z" /><circle cx="7.5" cy="10" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="14" cy="7" r="1" /><circle cx="16.5" cy="10" r="1" /></svg>
        </button>
        <button class="btn btn-sm" style="background:var(--tabBg);color:var(--tabColor);border:1px solid var(--tabBorder)" @click="logout">退出登录</button>
      </div>
    </div>
    <ThemeSwitcher :visible="themePickerOpen" :themes="themes" :current="theme" @select="setTheme" @close="themePickerOpen = false" />

    <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;position:relative;z-index:1">
      <button v-for="t in tabs" :key="t.id"
        :class="['tab-btn', { active: activeTab === t.id, pulse: pulsingTab === t.id }]"
        @click="doSwitchTab(t.id)">{{ t.label }}</button>
    </div>

    <div style="position:relative;z-index:1">
      <KeepAlive>
        <DeployPanel v-if="activeTab === 'deploy'" key="deploy" :locked="!deployUnlocked" @unlocked="unlockDeploy" />
        <ConfigPanel v-else-if="activeTab === 'config'" key="config" />
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
    </div>
  </template>
</template>

<script>
import { computed, ref } from 'vue'
import { clearAdminToken } from './api'
import LoginPage from './components/LoginPage.vue'
import AdminGatePage from './components/AdminGatePage.vue'
import LoginBackdrop from './components/LoginBackdrop.vue'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
import DeployPanel from './components/DeployPanel.vue'
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

export default {
  components: { LoginPage, AdminGatePage, LoginBackdrop, ThemeSwitcher, DeployPanel, CursorGlow, ControlPanel, ConfigPanel, KeyManager, PersonaPanel, CommandBrowser, CommandList, WhitelistPanel, SettingsPanel, StatusPanel },
  setup() {
    const loggedIn = ref(!!localStorage.getItem('dashboard_token'))
    const adminReady = ref(true)
    const adminCanCancel = ref(false)
    const themePickerOpen = ref(false)
    const themes = [
      { id: 'dark-gold', label: '暗金', desc: '黑底金线，适合长期盯控制台', colors: ['#0c0d0c', '#f4c430', '#fff1a8'] },
      { id: 'light', label: '昼白', desc: '参考白底黄强调的清爽面板', colors: ['#ffffff', '#ffe600', '#111827'] },
      { id: 'forest-green', label: '环保绿', desc: '低饱和绿和暖白，适合白天使用', colors: ['#f4fbf5', '#2f9e44', '#102a19'] },
      { id: 'monet-purple', label: '莫奈紫', desc: '雾紫、青蓝和浅灰的柔和组合', colors: ['#f7f4ff', '#8b5cf6', '#38bdf8'] },
      { id: 'crimson-red', label: '绯红', desc: '深红强调，高对比警戒感', colors: ['#160b0d', '#ef4444', '#ffd4d4'] },
      { id: 'sakura-pink', label: '樱粉', desc: '粉白和玫色，轻盈一点', colors: ['#fff6fa', '#ec4899', '#831843'] },
      { id: 'ocean-cyan', label: '海盐青', desc: '青蓝主色，信息面板更清透', colors: ['#ecfeff', '#0891b2', '#155e75'] },
      { id: 'graphite-blue', label: '石墨蓝', desc: '冷静灰蓝，适合夜间运维', colors: ['#0f172a', '#60a5fa', '#dbeafe'] },
    ]

    function normalizeTheme(value) {
      if (value === 'dark') return 'dark-gold'
      return themes.some(item => item.id === value) ? value : 'dark-gold'
    }

    const defaultTheme = window.dongxuelianDeployer ? 'light' : 'dark-gold'
    const theme = ref(normalizeTheme(localStorage.getItem('dashboard_theme') || defaultTheme))
    const currentThemeLabel = computed(() => themes.find(item => item.id === theme.value)?.label || '暗金')

    function applyTheme(t) {
      const nextTheme = normalizeTheme(t)
      document.documentElement.setAttribute('data-theme', nextTheme)
      localStorage.setItem('dashboard_theme', nextTheme)
    }
    applyTheme(theme.value)

    function setTheme(nextTheme) {
      theme.value = normalizeTheme(nextTheme)
      applyTheme(theme.value)
    }

    const deployUnlocked = ref(localStorage.getItem('dashboard_deploy_unlocked') === 'true')
    const allTabs = [
      { id: 'deploy', label: '部署' },
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
    const tabs = computed(() => deployUnlocked.value ? allTabs : allTabs.filter(item => item.id === 'deploy'))
    const activeTab = ref(deployUnlocked.value ? (localStorage.getItem('dashboard_active_tab') || 'features') : 'deploy')
    const pulsingTab = ref(null)
    const adminMsg = ref('请输入服务器密码')
    const adminPending = ref(null)

    function onLoggedIn() {
      loggedIn.value = true
      adminMsg.value = '需要服务器密码'
      adminCanCancel.value = false
      adminReady.value = true
      activeTab.value = localStorage.getItem('dashboard_deploy_unlocked') === 'true' ? 'features' : 'deploy'
    }

    function onAdminVerified() {
      adminReady.value = true
      adminCanCancel.value = false
      if (adminPending.value) { const fn = adminPending.value; adminPending.value = null; fn() }
    }

    function onAdminCancel() {
      adminPending.value = null
      adminCanCancel.value = false
      adminReady.value = true
    }

    window.showAdminDialog = (msg, onVerified) => {
      clearAdminToken()
      adminMsg.value = msg || '需要服务器密码'
      adminPending.value = onVerified
      adminCanCancel.value = true
      adminReady.value = false
    }

    function doSwitchTab(id) {
      if (id !== activeTab.value) {
        pulsingTab.value = id
        setTimeout(() => { pulsingTab.value = null }, 600)
      }
      activeTab.value = id
      if (deployUnlocked.value) localStorage.setItem('dashboard_active_tab', id)
    }

    function unlockDeploy() {
      deployUnlocked.value = true
      localStorage.setItem('dashboard_deploy_unlocked', 'true')
      doSwitchTab('features')
    }

    function logout() {
      localStorage.removeItem('dashboard_token')
      clearAdminToken()
      loggedIn.value = false
      adminReady.value = true
    }

    return { loggedIn, adminReady, adminCanCancel, themePickerOpen, themes, theme, currentThemeLabel, deployUnlocked, tabs, activeTab, pulsingTab, adminMsg, onLoggedIn, onAdminVerified, onAdminCancel, unlockDeploy, logout, setTheme, doSwitchTab }
  }
}
</script>
