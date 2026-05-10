<template>
  <LoginPage v-if="!loggedIn" @logged-in="onLoggedIn" />
  <AdminGatePage v-else-if="!adminReady" :message="adminMsg" :allow-cancel="adminCanCancel" @verified="onAdminVerified" @cancel="onAdminCancel" />
  <template v-else>
    <LoginBackdrop :class="{ 'backdrop-dim': deployUnlocked }" />
    <div class="app">
      <CursorGlow />
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:32px;position:relative;z-index:1">
        <h1 style="margin:0">LianBoard 控制中心</h1>
        <div style="display:flex;gap:12px;align-items:center">
          <button class="icon-btn" type="button" :aria-label="'界面风格：' + currentThemeLabel" @click="themePickerOpen = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3 3h-1.5a2 2 0 0 0-1.5 3.32A9 9 0 0 0 12 3Z" /><circle cx="7.5" cy="10" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="14" cy="7" r="1" /><circle cx="16.5" cy="10" r="1" /></svg>
          </button>
          <button class="btn btn-ghost btn-sm" @click="logout">退出登录</button>
        </div>
      </div>
      <ThemeSwitcher :visible="themePickerOpen" :themes="themes" :current="theme" @select="setTheme" @close="themePickerOpen = false" />

      <div style="display:flex;gap:10px;margin-bottom:28px;flex-wrap:wrap;position:relative;z-index:1">
        <button v-for="t in tabs" :key="t.id"
          :class="['tab-btn', { active: activeTab === t.id }]"
          @click="doSwitchTab(t.id)">{{ t.label }}</button>
      </div>

      <div style="position:relative;z-index:1">
        <Transition name="tab-fade" mode="out-in">
          <KeepAlive>
            <component :is="activeComponent" :key="activeTab" :locked="!deployUnlocked" @unlocked="unlockDeploy" />
          </KeepAlive>
        </Transition>
      </div>
    </div>
  </template>
</template>

<script>
import { computed, ref, provide, onMounted, onUnmounted } from 'vue'
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

// 映射 tab ID 到组件
const componentMap = {
  deploy: DeployPanel, control: ControlPanel, config: ConfigPanel, keys: KeyManager,
  persona: PersonaPanel, features: CommandBrowser, commands: CommandList,
  whitelist: WhitelistPanel, settings: SettingsPanel, status: StatusPanel
}

export default {
  components: { LoginPage, AdminGatePage, LoginBackdrop, ThemeSwitcher, CursorGlow },
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
      { id: 'ocean-cyan', label: '海盐青', desc: '青蓝主色，信息面板更清透', colors: ['#ecfeff', '#0891b2', '#155e75'] },
      { id: 'graphite-blue', label: '石墨蓝', desc: '冷静灰蓝，适合夜间运维', colors: ['#0f172a', '#60a5fa', '#dbeafe'] },
      { id: 'crimson-red', label: '赤焰红', desc: '深暗底色配红色强调，适合警戒感', colors: ['#160b0d', '#ef4444', '#ffd4d4'] },
      { id: 'sakura-pink', label: '樱花粉', desc: '柔美粉白配桃红点缀，清新甜美', colors: ['#fff6fa', '#ec4899', '#fbcfe8'] },
    ]

    function normalizeTheme(value) { return themes.some(item => item.id === value) ? value : 'dark-gold' }
    const defaultTheme = window.dongxuelianDeployer ? 'light' : 'dark-gold'
    const theme = ref(normalizeTheme(localStorage.getItem('dashboard_theme') || defaultTheme))
    const currentThemeLabel = computed(() => themes.find(item => item.id === theme.value)?.label || '暗金')

    function applyTheme(t) {
      const nextTheme = normalizeTheme(t)
      document.documentElement.setAttribute('data-theme', nextTheme)
      localStorage.setItem('dashboard_theme', nextTheme)
    }
    applyTheme(theme.value)
    function setTheme(nextTheme) { theme.value = normalizeTheme(nextTheme); applyTheme(theme.value) }

    const deployUnlocked = ref(localStorage.getItem('dashboard_deploy_unlocked') === 'true')
    const allTabs = [
      { id: 'deploy', label: '部署' }, { id: 'control', label: '终端控制' }, { id: 'config', label: '模型配置' },
      { id: 'keys', label: 'API Keys' }, { id: 'persona', label: '人格实验室' }, { id: 'features', label: '功能地图' },
      { id: 'commands', label: '指令速查' }, { id: 'whitelist', label: '拦截白名单' }, { id: 'settings', label: '安全设置' },
      { id: 'status', label: '系统状态' }
    ]
    const tabs = computed(() => deployUnlocked.value ? allTabs : allTabs.filter(item => item.id === 'deploy'))
    const activeTab = ref(deployUnlocked.value ? (localStorage.getItem('dashboard_active_tab') || 'features') : 'deploy')
    const activeComponent = computed(() => componentMap[activeTab.value] || DeployPanel)

    const adminMsg = ref('请输入服务器密码')
    const adminPending = ref(null)

    function onLoggedIn() {
      loggedIn.value = true; adminMsg.value = '需要服务器密码'; adminCanCancel.value = false; adminReady.value = true
      activeTab.value = localStorage.getItem('dashboard_deploy_unlocked') === 'true' ? 'features' : 'deploy'
    }

    function onAdminVerified() {
      adminReady.value = true; adminCanCancel.value = false
      if (adminPending.value) { const fn = adminPending.value; adminPending.value = null; fn() }
    }

    function onAdminCancel() { adminPending.value = null; adminCanCancel.value = false; adminReady.value = true }

    // 优雅的 Provide 替代 window 全局挂载
    const showAdminDialog = (msg, onVerified) => {
      clearAdminToken()
      adminMsg.value = msg || '需要服务器密码'
      adminPending.value = onVerified
      adminCanCancel.value = true
      adminReady.value = false
    }
    provide('showAdminDialog', showAdminDialog) // 供子组件注入使用

    function doSwitchTab(id) {
      activeTab.value = id
      if (deployUnlocked.value) localStorage.setItem('dashboard_active_tab', id)
    }

    function unlockDeploy() {
      deployUnlocked.value = true
      localStorage.setItem('dashboard_deploy_unlocked', 'true')
      doSwitchTab('features')
    }

    function logout() {
      localStorage.removeItem('dashboard_token'); clearAdminToken()
      loggedIn.value = false; adminReady.value = true
    }

    // 监听 401 事件优雅退出
    onMounted(() => { window.addEventListener('auth-expired', logout) })
    onUnmounted(() => { window.removeEventListener('auth-expired', logout) })

    return { loggedIn, adminReady, adminCanCancel, themePickerOpen, themes, theme, currentThemeLabel, deployUnlocked, tabs, activeTab, activeComponent, adminMsg, onLoggedIn, onAdminVerified, onAdminCancel, unlockDeploy, logout, setTheme, doSwitchTab }
  }
}
</script>
