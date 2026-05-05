<template>
  <LoginPage v-if="!loggedIn" @logged-in="loggedIn = true" />
  <div v-else class="app">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <h1 style="margin:0">莲莲 Bot 控制台</h1>
      <button class="btn btn-sm" style="background:#2a3a4a;color:#94A3B8;border:1px solid #2a3a4a" @click="logout">退出登录</button>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap">
      <button v-for="t in tabs" :key="t.id" class="btn btn-sm"
        :style="activeTab === t.id ? { background: '#39C5BB' } : { background: '#1a2634', color: '#94A3B8', border: '1px solid #2a3a4a' }"
        @click="activeTab = t.id">{{ t.label }}</button>
    </div>

    <ConfigPanel v-if="activeTab === 'config'" />
    <ControlPanel v-else-if="activeTab === 'control'" />
    <KeyManager v-else-if="activeTab === 'keys'" />
    <PersonaPanel v-else-if="activeTab === 'persona'" />
    <CommandBrowser v-else-if="activeTab === 'features'" />
    <CommandList v-else-if="activeTab === 'commands'" />
    <WhitelistPanel v-else-if="activeTab === 'whitelist'" />
    <StatusPanel v-else-if="activeTab === 'status'" />
  </div>
</template>

<script>
import { ref } from 'vue'
import LoginPage from './components/LoginPage.vue'
import ConfigPanel from './components/ConfigPanel.vue'
import ControlPanel from './components/ControlPanel.vue'
import KeyManager from './components/KeyManager.vue'
import PersonaPanel from './components/PersonaPanel.vue'
import CommandBrowser from './components/CommandBrowser.vue'
import CommandList from './components/CommandList.vue'
import WhitelistPanel from './components/WhitelistPanel.vue'
import StatusPanel from './components/StatusPanel.vue'

export default {
  components: { LoginPage, ControlPanel, ConfigPanel, KeyManager, PersonaPanel, CommandBrowser, CommandList, WhitelistPanel, StatusPanel },
  setup() {
    const loggedIn = ref(!!localStorage.getItem('dashboard_token'))
    const tabs = [
      { id: 'control', label: '控制' },
      { id: 'config', label: '模型配置' },
      { id: 'keys', label: 'API Keys' },
      { id: 'persona', label: '人格管理' },
      { id: 'features', label: '功能介绍' },
      { id: 'commands', label: '指令速查' },
      { id: 'whitelist', label: '白名单' },
      { id: 'status', label: '状态' },
    ]
    const activeTab = ref('features')

    function logout() {
      localStorage.removeItem('dashboard_token')
      loggedIn.value = false
    }

    return { loggedIn, tabs, activeTab, logout }
  }
}
</script>
