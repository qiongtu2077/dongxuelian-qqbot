<template>
  <main v-if="checking" class="session-check" role="status">正在验证访问权限…</main>
  <LoginPage v-else-if="!loggedIn" :notice="loginNotice" :allow-source="paused || probeFailed" @logged-in="onLoggedIn" @source-login="resumeSource" />
  <div v-else class="dashboard-shell" :class="{ 'rail-collapsed': !sidebarExpanded }">
    <Sidebar :tabs="tabs" :active-tab="activeTab" :expanded="sidebarExpanded" :mobile="mobile"
      :suppress-logout="isElectronDeployer" :current-theme-label="currentThemeLabel"
      @toggle="setSidebar(!sidebarExpanded)" @switch-tab="doSwitchTab" @open-theme="themePickerOpen = true" @logout="logout()" />
    <button v-if="mobile && sidebarExpanded" class="sidebar-scrim" type="button" aria-label="关闭导航" @click="setSidebar(false)"></button>
    <main class="app" :inert="mobile && sidebarExpanded || undefined">
      <header class="app-head">
        <h1 class="active-view-label" ref="pageTitle" tabindex="-1">{{ activeTabLabel }}</h1>
        <ProtocolSwitcher v-if="activeTab === 'control'" @viewed="doSwitchTab('control', true)" @switched="doSwitchTab('control', true)" />
      </header>
      <KeepAlive><component :is="activeComponent" :key="activeTab" :locked="!deployGuideSkipped" @unlocked="skipDeployGuide" /></KeepAlive>
    </main>
    <ThemeSwitcher :visible="themePickerOpen" :current="theme" @select="setTheme" @close="themePickerOpen = false" />
    <AdminModal v-if="!isElectronDeployer" :visible="adminModalOpen" :message="adminModalMsg" @verified="onVerified" @cancel="closeAdmin" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from 'vue'
import type { Component } from 'vue'
import { clearAdminToken, readDashboardSession } from './api'
import { isElectronDeployerEnv } from './electron-deployer'
import { applyTheme, themes, THEME_KEY } from './shared/theme'
import { pauseSource, sourcePaused } from './shared/session'
import type { DashboardTab, ShowAdminDialog } from './types'
import LoginPage from './components/LoginPage.vue'
import Sidebar from './components/Sidebar.vue'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
import AdminModal from './components/AdminModal.vue'
import DeployPanel from './components/DeployPanel.vue'
import ControlPanel from './components/ControlPanel.vue'
import ProtocolSwitcher from './components/ProtocolSwitcher.vue'
import AiModelApiConfigPanel from './components/AiModelApiConfigPanel.vue'
import PersonaPanel from './components/PersonaPanel.vue'
import CommandBrowser from './components/CommandBrowser.vue'
import WhitelistPanel from './components/WhitelistPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import LogPanel from './components/LogPanel.vue'
import GalleryPanel from './components/GalleryPanel.vue'
import ResourcePanel from './components/ResourcePanel.vue'

defineOptions({ name: 'DashboardApp' })

// --- 主题、部署引导和导航 ---
const isElectronDeployer = isElectronDeployerEnv()
const defaultTheme = isElectronDeployer ? 'light' : 'clear-water'
const theme = ref(applyTheme(defaultTheme))
const currentThemeLabel = computed(() => themes.find(item => item.id === theme.value)!.label)
const themePickerOpen = ref(false)
const viewport = window.matchMedia('(max-width: 760px)')
const mobile = ref(viewport.matches)
const sidebarExpanded = ref(!mobile.value && localStorage.getItem('dashboard_sidebar_expanded') !== 'false')
const pageTitle = ref<HTMLElement>()
if (localStorage.getItem('dashboard_deploy_unlocked') === 'true') localStorage.setItem('dashboard_deploy_guide_skipped', 'true')
localStorage.removeItem('dashboard_deploy_unlocked')
const deployGuideSkipped = ref(localStorage.getItem('dashboard_deploy_guide_skipped') === 'true')
const allTabs: DashboardTab[] = [
  { id: 'deploy', label: '部署' }, { id: 'control', label: '终端控制' }, { id: 'ai-model-api', label: 'AI模型与API配置' },
  { id: 'persona', label: '人格实验室' }, { id: 'features', label: '功能与指令' }, { id: 'whitelist', label: '黑白名单' },
  { id: 'settings', label: '安全设置' }, { id: 'agent', label: 'Agent 控制台' }, { id: 'resource', label: '资源中心' },
  { id: 'logs', label: '日志中心' }, { id: 'gallery', label: '莲莲图集' }
]
const components: Record<string, Component> = { deploy: DeployPanel, control: ControlPanel, 'ai-model-api': AiModelApiConfigPanel,
  persona: PersonaPanel, features: CommandBrowser, whitelist: WhitelistPanel, settings: SettingsPanel, resource: ResourcePanel, logs: LogPanel, gallery: GalleryPanel }
const tabs = computed(() => allTabs.filter(item => (deployGuideSkipped.value || item.id === 'deploy') && (!isElectronDeployer || item.id !== 'settings')))
const activeTab = ref('deploy')
const activeComponent = computed(() => components[activeTab.value])
const activeTabLabel = computed(() => tabs.value.find(item => item.id === activeTab.value)?.label)

/** 同页由响应式状态更新，其他标签页由 storage 事件恢复选择。 */
function setTheme(id: string) {
  theme.value = applyTheme(defaultTheme, id)
  localStorage.setItem(THEME_KEY, theme.value)
}

/** 将旧栏目键映射到唯一新入口，首次恢复定位到原来的内容。 */
async function restoreTab() {
  if (!deployGuideSkipped.value) { activeTab.value = 'deploy'; return }
  const value = localStorage.getItem('dashboard_active_tab') || 'features'
  let tab = value
  if (value === 'config' || value === 'keys') tab = 'ai-model-api'
  else if (value === 'status') tab = 'control'
  else if (value === 'commands' || value === 'agent') tab = 'features'
  if (!tabs.value.some(item => item.id === tab)) tab = 'deploy'
  activeTab.value = tab
  localStorage.setItem('dashboard_active_tab', tab)
  await nextTick()
  const anchor = value === 'status' ? 'system-status' : value === 'commands' ? 'command-directory' : ''
  if (anchor) document.getElementById(anchor)?.focus()
}

/** 点选已有菜单；协议回执可直接返回终端控制。 */
async function doSwitchTab(id: string, protocolNavigation = false) {
  if (!tabs.value.some(item => item.id === id)) return
  if (id === 'agent') { window.location.assign('/agent/'); return }
  if (mobile.value) setSidebar(false)
  if (id === activeTab.value && !protocolNavigation) return
  activeTab.value = id
  if (deployGuideSkipped.value) localStorage.setItem('dashboard_active_tab', id)
  await nextTick()
  pageTitle.value?.focus({ preventScroll: true })
  window.scrollTo(0, 0)
}

/** 应用侧栏宽度或移动抽屉状态。 */
function setSidebar(expanded: boolean) {
  sidebarExpanded.value = expanded
  if (!mobile.value) localStorage.setItem('dashboard_sidebar_expanded', String(expanded))
  else if (!expanded) nextTick(() => document.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus())
}

/** 在断点变化时匹配当前设备的导航形态。 */
function resize() {
  mobile.value = viewport.matches
  sidebarExpanded.value = !mobile.value && localStorage.getItem('dashboard_sidebar_expanded') !== 'false'
}

/** 显式跳过部署引导并进入合并后的功能目录。 */
function skipDeployGuide() {
  deployGuideSkipped.value = true
  localStorage.setItem('dashboard_deploy_guide_skipped', 'true')
  void doSwitchTab('features')
}

// --- 会话和管理员操作 ---
const loggedIn = ref(isElectronDeployer)
const checking = ref(!isElectronDeployer)
const paused = ref(sourcePaused())
const probeFailed = ref(false)
const loginNotice = ref('')
const adminModalOpen = ref(false)
const adminModalMsg = ref('')
let callback: (() => void | Promise<void>) | undefined
let sessionRead: AbortController | undefined
let sessionIdentity = ''

/** 取消尚未完成的管理员确认，清空待执行动作。 */
function closeAdmin() { callback = undefined; adminModalOpen.value = false }

/** 有效的管理员确认只消费一次发起时的回调。 */
function onVerified() {
  const action = callback
  closeAdmin()
  if (loggedIn.value) void action?.()
}

const showAdminDialog: ShowAdminDialog = (message = '请输入管理员密码', after) => {
  if (!loggedIn.value) return
  if (isElectronDeployer) { void after?.(); return }
  callback = after
  adminModalMsg.value = message
  adminModalOpen.value = true
}
provide('showAdminDialog', showAdminDialog)
provide('isElectronDeployer', isElectronDeployer)

/** 清除当前标签页的权限视图及其在途自检。 */
function logout(event?: Event) {
  sessionRead?.abort()
  if (!event) { pauseSource(true); paused.value = true }
  localStorage.removeItem('dashboard_token')
  clearAdminToken()
  closeAdmin()
  themePickerOpen.value = false
  loggedIn.value = isElectronDeployer
  checking.value = false
  loginNotice.value = event instanceof CustomEvent ? event.detail?.reason || '登录已失效' : ''
}

/** 普通登录成功后使用真实口令会话，保留用户选择的栏目。 */
function onLoggedIn() {
  sessionIdentity = localStorage.getItem('dashboard_token') || 'source'
  loggedIn.value = true; loginNotice.value = ''; probeFailed.value = false
  void restoreTab()
}

/** 探测当前网络与令牌的真实权限，迟到结果不可复活已退出的视图。 */
async function probeSession() {
  if (isElectronDeployer) { loggedIn.value = true; void restoreTab(); return }
  sessionRead?.abort()
  const read = new AbortController()
  sessionRead = read
  const accessAtStart = localStorage.getItem('dashboard_token')
  const result = await readDashboardSession(read.signal)
  if (read.signal.aborted || sessionRead !== read) return
  if (accessAtStart !== localStorage.getItem('dashboard_token')) { void probeSession(); return }
  checking.value = false
  probeFailed.value = !result.ok
  if (!result.ok) {
    // 网络中断时收起授权页面，保留凭据供下次自检。
    loggedIn.value = false
    closeAdmin()
    themePickerOpen.value = false
    loginNotice.value = '会话检查暂不可用，可重试或使用访问密码。'
    return
  }
  if (!result.data?.access) {
    if (loggedIn.value || localStorage.getItem('dashboard_token')) logout(new CustomEvent('auth-expired', { detail: { reason: '请重新验证访问权限' } }))
    return
  }
  const identity = result.data.mode === 'source' ? 'source' : localStorage.getItem('dashboard_token') || result.data.mode
  if (loggedIn.value && identity !== sessionIdentity) {
    loggedIn.value = false
    closeAdmin()
    await nextTick()
    if (read.signal.aborted || sessionRead !== read) return
  }
  if (!loggedIn.value) { onLoggedIn(); sessionIdentity = identity }
}

/** 主动退出后由用户明确重新使用来源认证。 */
function resumeSource() { pauseSource(false); paused.value = false; void probeSession() }

/** 从另一个标签页同步主题与口令会话变化。 */
function storageChanged(event: StorageEvent) {
  if (event.key === THEME_KEY || event.key === null) theme.value = applyTheme(defaultTheme)
  if (['dashboard_token', 'dashboard_server_token', 'dashboard_admin_token'].includes(event.key || '') || event.key === null) void probeSession()
}

onMounted(() => {
  void probeSession()
  window.addEventListener('focus', probeSession)
  window.addEventListener('storage', storageChanged)
  window.addEventListener('auth-expired', logout)
  viewport.addEventListener('change', resize)
})
onUnmounted(() => {
  sessionRead?.abort()
  window.removeEventListener('focus', probeSession)
  window.removeEventListener('storage', storageChanged)
  window.removeEventListener('auth-expired', logout)
  viewport.removeEventListener('change', resize)
})
</script>
