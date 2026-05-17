<template>
  <LoginPage v-if="!loggedIn && !isElectronDeployer" @logged-in="onLoggedIn" />
  <template v-else>
    <LoginBackdrop :class="{ 'backdrop-dim': deployUnlocked }" />
    <Sidebar
      :tabs="tabs"
      :active-tab="activeTab"
      :expanded="sidebarExpanded"
      :suppress-logout="isElectronDeployer"
      :current-theme-label="currentThemeLabel"
      @toggle="toggleSidebar"
      @switch-tab="doSwitchTab"
      @open-theme="themePickerOpen = true"
      @logout="logout"
    />
    <div v-if="isMobileSidebarOpen" class="sidebar-scrim" @click="setSidebarExpanded(false)"></div>
    <div class="app" :class="{ 'sidebar-collapsed': !sidebarExpanded }">
      <div class="app-head">
        <h1>LianBoard 控制中心</h1>
        <span class="active-view-label">{{ activeTabLabel }}</span>
      </div>
      <ThemeSwitcher :visible="themePickerOpen" :themes="themes" :current="theme" @select="setTheme" @close="themePickerOpen = false" />

      <div style="position:relative;z-index:1">
        <KeepAlive>
          <component :is="activeComponent" :key="activeTab" :locked="!deployUnlocked" @unlocked="unlockDeploy" />
        </KeepAlive>
      </div>
    </div>
    <AdminModal v-if="!isElectronDeployer" :visible="adminModalOpen" :message="adminModalMsg" @verified="onAdminModalVerified" @cancel="onAdminModalCancel" />
  </template>
</template>

<script>
import { computed, ref, provide, onMounted, onUnmounted } from 'vue'
import { clearAdminToken } from './api'
import { isElectronDeployerEnv } from './electron-deployer'
import LoginPage from './components/LoginPage.vue'
import LoginBackdrop from './components/LoginBackdrop.vue'
import Sidebar from './components/Sidebar.vue'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
import AdminModal from './components/AdminModal.vue'
import DeployPanel from './components/DeployPanel.vue'
import ConfigPanel from './components/ConfigPanel.vue'
import ControlPanel from './components/ControlPanel.vue'
import KeyManager from './components/KeyManager.vue'
import PersonaPanel from './components/PersonaPanel.vue'
import CommandBrowser from './components/CommandBrowser.vue'
import CommandList from './components/CommandList.vue'
import WhitelistPanel from './components/WhitelistPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatusPanel from './components/StatusPanel.vue'
import LogPanel from './components/LogPanel.vue'
import GalleryPanel from './components/GalleryPanel.vue'
import AgentPanel from './components/AgentPanel.vue'

const componentMap = {
  deploy: DeployPanel, control: ControlPanel, config: ConfigPanel, keys: KeyManager,
  persona: PersonaPanel, features: CommandBrowser, commands: CommandList,
  whitelist: WhitelistPanel, settings: SettingsPanel, status: StatusPanel, logs: LogPanel,
  gallery: GalleryPanel, agent: AgentPanel
}

export default {
  components: { LoginPage, LoginBackdrop, Sidebar, ThemeSwitcher, AdminModal },
  setup() {
    const isElectronDeployer = isElectronDeployerEnv()
    const loggedIn = ref(isElectronDeployer || !!localStorage.getItem('dashboard_token'))
    const isMobileViewport = ref(window.matchMedia('(max-width: 760px)').matches)
    const sidebarStored = localStorage.getItem('dashboard_sidebar_expanded')
    const sidebarExpanded = ref(sidebarStored === null ? !isMobileViewport.value : sidebarStored === 'true')
    const themePickerOpen = ref(false)
    const themes = [
      { id: 'dark-gold', label: '暗金', desc: '黑底金线，适合长期盯控制台', colors: ['#0c0d0c', '#f4c430', '#fff1a8'] },
      { id: 'light', label: '昼白', desc: '参考白底黄强调的清爽面板', colors: ['#ffffff', '#ffe600', '#111827'] },
      { id: 'forest-green', label: '环保绿', desc: '低饱和绿和暖白，适合白天使用', colors: ['#f4fbf5', '#2f9e44', '#102a19'] },
      { id: 'monet-purple', label: '莫奈紫', desc: '雾紫、青蓝和浅灰的柔和组合', colors: ['#f7f4ff', '#8b5cf6', '#38bdf8'] },
      { id: 'ocean-cyan', label: '海盐青', desc: '青蓝主色，信息面板更清透', colors: ['#ecfeff', '#0891b2', '#155e75'] },
      { id: 'graphite-blue', label: '石墨蓝', desc: '冷静灰蓝，适合夜间运维', colors: ['#0f172a', '#60a5fa', '#dbeafe'] },
      { id: 'clear-water', label: '清水紫', desc: '深蓝紫底色，像清澈水面一样轻透', colors: ['#071225', '#7dd3fc', '#8b5cf6'] },
      { id: 'crimson-red', label: '赤焰红', desc: '深暗底色配红色强调，适合警戒感', colors: ['#160b0d', '#ef4444', '#ffd4d4'] },
      { id: 'sakura-pink', label: '樱花粉', desc: '柔美粉白配桃红点缀，清新甜美', colors: ['#fff6fa', '#ec4899', '#fbcfe8'] },
    ]

    function normalizeTheme(value) { return themes.some(item => item.id === value) ? value : 'clear-water' }
    const defaultTheme = isElectronDeployer ? 'light' : 'clear-water'
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
      { id: 'commands', label: '指令速查' }, { id: 'whitelist', label: '黑白名单' },
      { id: 'settings', label: '安全设置' }, { id: 'agent', label: 'Agent 控制台' }, { id: 'logs', label: '日志中心' }, { id: 'status', label: '系统状态' }, { id: 'gallery', label: '莲莲图集' }
    ]
    const visibleTabs = computed(() => isElectronDeployer ? allTabs.filter(item => item.id !== 'settings') : allTabs)
    const tabs = computed(() => deployUnlocked.value ? visibleTabs.value : visibleTabs.value.filter(item => item.id === 'deploy'))
    const initialActiveTab = deployUnlocked.value ? (localStorage.getItem('dashboard_active_tab') || 'features') : 'deploy'
    const activeTab = ref(isElectronDeployer && initialActiveTab === 'settings' ? 'deploy' : initialActiveTab)
    const activeComponent = computed(() => componentMap[activeTab.value] || DeployPanel)
    const activeTabLabel = computed(() => tabs.value.find(item => item.id === activeTab.value)?.label || '部署')
    const isMobileSidebarOpen = computed(() => isMobileViewport.value && sidebarExpanded.value)
    let tabSwitchUnlockTimer = null
    let tabSwitchLocked = false

    function onLoggedIn() {
      loggedIn.value = true
      activeTab.value = localStorage.getItem('dashboard_deploy_unlocked') === 'true' ? 'features' : 'deploy'
    }

    const adminModalOpen = ref(false)
    const adminModalMsg = ref('请输入管理员密码')
    let adminModalCallback = null

    const showAdminDialog = (msg, onVerified) => {
      if (isElectronDeployer) {
        if (onVerified) onVerified()
        return
      }
      adminModalMsg.value = msg || '请输入管理员密码'
      adminModalCallback = onVerified || null
      adminModalOpen.value = true
    }
    function onAdminModalVerified() {
      adminModalOpen.value = false
      if (adminModalCallback) { const fn = adminModalCallback; adminModalCallback = null; fn() }
    }
    function onAdminModalCancel() {
      adminModalOpen.value = false
      adminModalCallback = null
    }
    provide('showAdminDialog', showAdminDialog)
    provide('isElectronDeployer', isElectronDeployer)

    function doSwitchTab(id) {
      if (id === 'agent') {
        window.location.href = '/agent/'
        return
      }
      if (id === activeTab.value) return
      if (!tabs.value.some(item => item.id === id)) return
      if (tabSwitchLocked) return
      tabSwitchLocked = true
      if (tabSwitchUnlockTimer) clearTimeout(tabSwitchUnlockTimer)
      tabSwitchUnlockTimer = setTimeout(() => { tabSwitchLocked = false; tabSwitchUnlockTimer = null }, 150)
      activeTab.value = id
      if (deployUnlocked.value) localStorage.setItem('dashboard_active_tab', id)
      if (isMobileViewport.value) setSidebarExpanded(false)
    }

    function setSidebarExpanded(value) {
      sidebarExpanded.value = !!value
      localStorage.setItem('dashboard_sidebar_expanded', sidebarExpanded.value ? 'true' : 'false')
    }

    function toggleSidebar() { setSidebarExpanded(!sidebarExpanded.value) }

    function unlockDeploy() {
      deployUnlocked.value = true
      localStorage.setItem('dashboard_deploy_unlocked', 'true')
      doSwitchTab('features')
    }

    function logout() {
      if (isElectronDeployer) { loggedIn.value = true; return }
      localStorage.removeItem('dashboard_token'); clearAdminToken()
      loggedIn.value = false
    }

    function handleResize() { isMobileViewport.value = window.matchMedia('(max-width: 760px)').matches }
    function handleKeydown(event) { if (event.key === 'Escape' && isMobileSidebarOpen.value) setSidebarExpanded(false) }

    // 监听 401 事件优雅退出
    onMounted(() => {
      window.addEventListener('auth-expired', logout)
      window.addEventListener('resize', handleResize)
      window.addEventListener('keydown', handleKeydown)
    })
    onUnmounted(() => {
      window.removeEventListener('auth-expired', logout)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeydown)
      if (tabSwitchUnlockTimer) clearTimeout(tabSwitchUnlockTimer)
    })

    return { isElectronDeployer, loggedIn, sidebarExpanded, isMobileSidebarOpen, themePickerOpen, themes, theme, currentThemeLabel, deployUnlocked, tabs, activeTab, activeTabLabel, activeComponent, adminModalOpen, adminModalMsg, onLoggedIn, onAdminModalVerified, onAdminModalCancel, unlockDeploy, logout, setTheme, doSwitchTab, setSidebarExpanded, toggleSidebar }
  }
}
</script>
