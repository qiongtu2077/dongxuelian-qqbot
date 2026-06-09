<template>
  <section class="agent-panel panel-card">
    <div class="panel-head">
      <div>
        <h2>Agent 控制台</h2>
        <p>管理工具暴露范围、安全策略，并在 Dashboard 内测试 Agent。</p>
      </div>
      <button class="ghost" type="button" :disabled="loading" @click="loadConfig">刷新</button>
    </div>

    <div v-if="error" class="notice error">{{ error }}</div>
    <div v-if="message" class="notice">{{ message }}</div>

    <div class="grid">
      <label class="field">
        <span>工具安全模式</span>
        <SelectBox v-model="mode" :options="modeOptions" />
      </label>
      <label class="field">
        <span>危险工具策略</span>
        <SelectBox v-model="config.dangerousPolicy" :options="dangerousPolicyOptions" />
      </label>
      <label class="switch-row">
        <input v-model="config.channels.qq.enabled" type="checkbox" />
        <span>QQ Agent</span>
      </label>
      <label class="switch-row">
        <input v-model="config.channels.dashboard.enabled" type="checkbox" />
        <span>Dashboard Agent</span>
      </label>
      <label class="switch-row">
        <input v-model="config.autoRoute.qq.enabled" type="checkbox" />
        <span>QQ 自动路由</span>
      </label>
    </div>

    <div class="section-head">
      <h3>MCP 工作台</h3>
      <button class="primary" type="button" :disabled="saving" @click="toggleMcp">{{ config.mcp.enabled ? '关闭 MCP' : '启用 MCP' }}</button>
    </div>
    <div class="grid">
      <label class="switch-row">
        <input v-model="config.mcp.enabled" type="checkbox" />
        <span>本地 MCP</span>
      </label>
      <label class="switch-row">
        <input v-model="config.mcp.allowWriteWorkspace" type="checkbox" :disabled="!config.mcp.enabled" />
        <span>允许改工作区</span>
      </label>
      <label class="switch-row">
        <input v-model="config.mcp.allowRunLocal" type="checkbox" :disabled="!config.mcp.enabled" />
        <span>允许本地检查</span>
      </label>
    </div>

    <div class="section-head">
      <h3>工具开关</h3>
      <button class="primary" type="button" :disabled="saving" @click="saveConfig">保存配置</button>
    </div>
    <div class="tool-list">
      <div v-for="tool in tools" :key="tool.name" class="tool-row" :class="{ danger: tool.dangerous }">
        <div>
          <strong>{{ tool.name }}</strong>
          <p>{{ tool.description }}</p>
          <small>{{ tool.dangerous ? '危险工具' : (tool.external ? '外部网络工具' : '安全工具') }} · 默认 {{ (tool.defaultChannels || []).join('/') || '-' }}</small>
        </div>
        <label><input v-model="config.channels.qq.tools[tool.name]" type="checkbox" /> QQ</label>
        <label><input v-model="config.channels.dashboard.tools[tool.name]" type="checkbox" /> Dashboard</label>
      </div>
    </div>

    <div class="section-head">
      <h3>文件读取根目录</h3>
      <button class="ghost" type="button" @click="addReadRoot">添加</button>
    </div>
    <div class="root-list">
      <div v-for="(root, index) in config.readFileRoots" :key="index" class="root-row">
        <input v-model="config.readFileRoots[index]" placeholder="留空则使用进程工作目录" />
        <button class="ghost" type="button" @click="removeReadRoot(index)">删除</button>
      </div>
      <p v-if="effectiveReadRoots.length" class="muted">实际读取根目录：{{ effectiveReadRoots.join('；') }}</p>
      <p v-else-if="config.readFileRoots.length === 0" class="muted">未配置时默认限制在当前工作目录。</p>
    </div>

    <div class="section-head">
      <h3>Skill 索引</h3>
      <span class="muted">轻量索引 {{ skills.length }} 个 · 正文由 read_agent_skill 按需读取</span>
    </div>
    <div class="skill-list">
      <label v-for="skill in skills" :key="skill.file" class="skill-row">
        <input v-model="config.enabledSkills" type="checkbox" :value="skill.name" />
        <strong>{{ skill.name }}</strong>
        <span>{{ skill.kind }}</span>
        <p>{{ skill.description || '无描述' }}</p>
      </label>
    </div>

    <div class="section-head">
      <h3>Console 人格</h3>
      <span class="muted">{{ currentDashboardPersona || '默认（东雪莲）' }}</span>
    </div>
    <div class="grid">
      <label class="field">
        <span>Dashboard Agent 人格</span>
        <SelectBox v-model="persona.dashboardPersona" :options="dashboardPersonaOptions" :disabled="savingPersona" @change="savePersona" />
      </label>
      <label class="switch-row">
        <input v-model="persona.qqInheritChatPersona" type="checkbox" :disabled="savingPersona" @change="savePersona" />
        <span>QQ 继承聊天人格</span>
      </label>
    </div>

    <div class="section-head">
      <h3>Dashboard Agent 测试</h3>
      <span class="muted">累计调用 {{ stats.total || 0 }} 次 · QQ {{ stats.byChannel?.qq || 0 }} / Dashboard {{ stats.byChannel?.dashboard || 0 }}</span>
    </div>
    <div v-if="pendingTools.length" class="section-head">
      <h3>审批队列</h3>
      <span class="muted">{{ pendingTools.length }} 个待确认</span>
    </div>
    <div v-if="pendingTools.length" class="pending-list">
      <div v-for="item in pendingTools" :key="item.id" class="pending-row">
        <div>
          <strong>{{ item.toolName }}</strong>
          <p>{{ item.channelKey }} / {{ item.userId }} · {{ formatTime(item.expireAt) }} 过期</p>
          <small>{{ item.argsSummary || '无参数摘要' }}</small>
        </div>
        <button class="ghost" type="button" :disabled="sending" @click="confirmPendingTool(item.id)">确认</button>
        <button class="ghost" type="button" :disabled="sending" @click="rejectPendingTool(item.id)">拒绝</button>
      </div>
    </div>

    <div v-if="sessions.length" class="section-head">
      <h3>Agent Sessions</h3>
      <span class="muted">{{ sessions.length }} 个</span>
    </div>
    <div v-if="sessions.length" class="session-list">
      <div v-for="session in sessions" :key="session.id" class="session-row">
        <strong>{{ session.title }}</strong>
        <p>{{ session.channel }} / {{ session.userName }} · {{ session.turns }} 轮 · {{ session.toolCalls }} 次工具 · {{ formatTime(session.updatedAt) }}</p>
        <small>{{ session.lastMessage }}</small>
        <button class="ghost" type="button" @click="loadSessionDetail(session.id)">详情</button>
      </div>
    </div>
    <div v-if="selectedSession" class="session-row">
      <strong>会话详情</strong>
      <p>{{ selectedSession.id }}</p>
      <small v-for="turn in selectedSession.turns" :key="turn.at">{{ formatTime(turn.at) }} · {{ turn.userMessage }} → {{ turn.reply }}</small>
    </div>

    <div v-if="stats.recent?.length" class="section-head">
      <h3>最近工具调用</h3>
      <span class="muted">{{ stats.recent.length }} 条</span>
    </div>
    <div v-if="stats.recent?.length" class="stats-list">
      <span v-for="item in stats.recent" :key="item.at + item.tool" class="stat-pill">{{ item.channel }} · {{ item.tool }}</span>
    </div>

    <div class="section-head">
      <h3>Browser Agent 辅助</h3>
      <span class="muted">browser_action {{ isBrowserToolEnabled ? '已启用' : '未启用' }}</span>
    </div>
    <div class="notice">
      浏览器工具启用后仍按危险工具策略审批。可在聊天中使用：打开网页、截图、提取页面文本、tabs、pdf、cookies_get 等结构化请求。
    </div>

    <div class="chat-box">
      <textarea v-model="prompt" placeholder="例如：读取 package.json 总结项目脚本" @keydown.ctrl.enter.prevent="sendMessage"></textarea>
      <div class="chat-actions">
        <button class="primary" type="button" :disabled="sending || !prompt.trim()" @click="sendMessage">发送</button>
        <button class="ghost" type="button" :disabled="sending || !pendingId" @click="() => confirmPendingTool()">确认工具</button>
        <button class="ghost" type="button" :disabled="sending || history.length === 0" @click="clearHistory">清空</button>
      </div>
      <label class="remember-history">
        <input v-model="rememberHistory" type="checkbox" @change="onRememberHistoryChange" />
        <span>记住本机历史</span>
      </label>
    </div>
    <div v-if="history.length" class="history-list">
      <div v-for="(item, index) in history" :key="index" class="history-item" :class="item.role">
        <strong>{{ item.role === 'user' ? '你' : 'Agent' }}</strong>
        <pre>{{ item.content }}</pre>
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { computed, inject, onMounted, reactive, ref } from 'vue'
import { fetchAgentConfig, saveAgentConfig, fetchAgentPersonas, saveAgentPersona, sendAgentMessage, confirmAgentTool, rejectAgentTool, fetchPendingAgentTools, fetchAgentSessions, fetchAgentSession, fetchAgentTask, isAdminRequired } from '../api'
import type { MessageState, ShowAdminDialog } from '../types'
import { asRecord, errorMessage, messageFromData } from '../types'
import SelectBox from './SelectBox.vue'

interface AgentChannelConfig {
  enabled: boolean
  tools: Record<string, boolean>
}

interface AgentAutoRouteConfig {
  enabled: boolean
}

interface AgentConfigState {
  dangerousPolicy: string
  channels: Record<'qq' | 'dashboard', AgentChannelConfig>
  autoRoute: Record<'qq' | 'dashboard', AgentAutoRouteConfig>
  enabledSkills: string[]
  readFileRoots: string[]
  mcp: {
    enabled: boolean
    allowWriteWorkspace: boolean
    allowRunLocal: boolean
    exposeDangerousActions: boolean
  }
  persona?: AgentPersonaConfig
}

interface AgentPersonaConfig {
  dashboardPersona: string
  qqInheritChatPersona: boolean
}

interface AgentToolInfo {
  name: string
  description?: string
  dangerous?: boolean
  external?: boolean
  defaultChannels?: string[]
  qqEnabled?: boolean
  dashboardEnabled?: boolean
}

interface AgentSkillInfo {
  file: string
  name: string
  kind?: string
  description?: string
}

interface AgentPersonaSummary {
  name: string
}

interface AgentStats {
  total: number
  byChannel?: Record<string, number>
  recent?: Array<{ at: number | string, tool: string, channel?: string }>
}

interface PendingAgentTool {
  id: string
  toolName?: string
  channelKey?: string
  userId?: string
  expireAt?: number | string
  argsSummary?: string
}

interface AgentSessionSummary {
  id: string
  title?: string
  channel?: string
  userName?: string
  turns?: number
  toolCalls?: number
  updatedAt?: number | string
  lastMessage?: string
}

interface AgentSessionDetail {
  id: string
  turns: Array<{ at: number | string, userMessage?: string, reply?: string }>
}

interface AgentChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AgentTaskResult {
  ok?: boolean
  reply?: string
  message?: string
  error?: string
  pendingId?: string | null
}

interface AgentTaskStatus {
  id?: string
  status?: string
  step?: string
  error?: string
  result?: AgentTaskResult
}

const defaultConfig: AgentConfigState = {
  dangerousPolicy: 'confirm',
  channels: {
    qq: { enabled: true, tools: {} },
    dashboard: { enabled: true, tools: {} },
  },
  autoRoute: {
    qq: { enabled: false },
    dashboard: { enabled: false },
  },
  enabledSkills: [],
  readFileRoots: [],
  mcp: {
    enabled: false,
    allowWriteWorkspace: false,
    allowRunLocal: false,
    exposeDangerousActions: false,
  },
}

export default {
  name: 'AgentPanel',
  components: { SelectBox },
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const loading = ref(false)
    const saving = ref(false)
    const savingPersona = ref(false)
    const sending = ref(false)
    const error = ref('')
    const message = ref('')
    const mode = ref('config')
    const tools = ref<AgentToolInfo[]>([])
    const skills = ref<AgentSkillInfo[]>([])
    const personas = ref<AgentPersonaSummary[]>([])
    const stats = ref<AgentStats>({ total: 0 })
    const prompt = ref('')
    const pendingId = ref('')
    const pendingTools = ref<PendingAgentTool[]>([])
    const sessions = ref<AgentSessionSummary[]>([])
    const selectedSession = ref<AgentSessionDetail | null>(null)
    const effectiveReadRoots = ref<string[]>([])
    const history = ref<AgentChatMessage[]>([])
    const rememberHistory = ref(localStorage.getItem('dashboard_agent_remember_history') === '1')
    const config = reactive(JSON.parse(JSON.stringify(defaultConfig)))
    const persona = reactive({ dashboardPersona: '', qqInheritChatPersona: true })
    const isBrowserToolEnabled = computed(() => !!config.channels.dashboard.tools.browser_action)
    const currentDashboardPersona = computed(() => persona.dashboardPersona || '')
    const modeOptions = [
      { value: 'config', label: '跟随配置' },
      { value: 'confirm', label: '危险工具需确认' },
      { value: 'block', label: '禁用危险工具' },
      { value: 'auto', label: '自动执行' },
    ]
    const dangerousPolicyOptions = [
      { value: 'confirm', label: '需确认' },
      { value: 'block', label: '禁用' },
      { value: 'auto', label: '自动执行' },
    ]
    const dashboardPersonaOptions = computed(() => [
      { value: '', label: '默认（东雪莲）' },
      ...personas.value.map(item => ({ value: item.name, label: item.name })),
    ])

    function applyConfig(next: unknown) {
      const merged = JSON.parse(JSON.stringify({ ...defaultConfig, ...(next || {}) }))
      config.dangerousPolicy = merged.dangerousPolicy || 'confirm'
      config.readFileRoots = Array.isArray(merged.readFileRoots) ? merged.readFileRoots : []
      config.mcp = {
        enabled: !!merged.mcp?.enabled,
        allowWriteWorkspace: !!merged.mcp?.allowWriteWorkspace,
        allowRunLocal: !!merged.mcp?.allowRunLocal,
        exposeDangerousActions: !!merged.mcp?.exposeDangerousActions,
      }
      for (const channel of ['qq', 'dashboard']) {
        config.channels[channel].enabled = !!merged.channels?.[channel]?.enabled
        config.channels[channel].tools = { ...(merged.channels?.[channel]?.tools || {}) }
        config.autoRoute[channel].enabled = !!merged.autoRoute?.[channel]?.enabled
      }
      config.enabledSkills = Array.isArray(merged.enabledSkills) ? merged.enabledSkills.slice() : []
      persona.dashboardPersona = String(merged.persona?.dashboardPersona || '')
      persona.qqInheritChatPersona = merged.persona?.qqInheritChatPersona !== false
    }

    function applyPersona(next: unknown) {
      const value = asRecord(next)
      persona.dashboardPersona = String(value.dashboardPersona || '')
      persona.qqInheritChatPersona = value.qqInheritChatPersona !== false
    }

    function formatTime(ts: number | string | undefined) {
      if (!ts) return '-'
      try { return new Date(ts).toLocaleTimeString() } catch { return '-' }
    }

    function requestAdmin(messageText: string, retry: () => void | Promise<void>) {
      if (showAdminDialog) showAdminDialog(messageText, retry)
      else error.value = '需要管理员密码验证'
    }

    function normalizePendingId(value: unknown = pendingId.value) {
      return typeof value === 'string' ? value : (pendingId.value || '')
    }

    function getAgentReply(data: unknown, fallback = '') {
      const value = asRecord(data)
      return String(value.reply || value.result || value.message || fallback || '').trim()
    }

    function getAgentTaskReply(task: AgentTaskStatus | null, fallback = '') {
      const result = task?.result || {}
      return String(result.reply || result.message || result.error || task?.error || fallback || '').trim()
    }

    function sleep(ms: number) {
      return new Promise(resolve => setTimeout(resolve, ms))
    }

    async function pollAgentTask(taskId: string, fallback = ''): Promise<AgentTaskStatus | null> {
      const id = String(taskId || '').trim()
      if (!id) return null
      for (let i = 0; i < 90; i++) {
        const res = await fetchAgentTask(id)
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '读取任务状态失败'))
        const task = asRecord(data.task) as unknown as AgentTaskStatus
        const status = String(task.status || '')
        if (status === 'done' || status === 'failed' || status === 'deferred' || status === 'cancelled') return task
        if (i === 0 && fallback) pushAssistant(fallback)
        await sleep(i < 10 ? 1000 : 2000)
      }
      return { id, status: 'timeout', result: { message: '后台任务仍在执行，可稍后刷新 Agent 会话或资源中心查看结果。' } }
    }

    function persistHistory() {
      history.value = history.value.slice(-30)
      if (rememberHistory.value) localStorage.setItem('dashboard_agent_history', JSON.stringify(history.value))
      else localStorage.removeItem('dashboard_agent_history')
    }

    function pushAssistant(content: string) {
      const text = String(content || '').trim()
      if (!text) return
      history.value.push({ role: 'assistant', content: text })
      persistHistory()
    }

    async function loadPendingTools() {
      try {
        const res = await fetchPendingAgentTools()
        const data = asRecord(res.data)
        if (res.ok && data.ok) {
          pendingTools.value = Array.isArray(data.pending) ? data.pending as PendingAgentTool[] : []
          pendingId.value = pendingTools.value[0]?.id || ''
        }
      } catch { /* non-critical: pending approvals can be refreshed manually */ }
    }

    async function loadSessions() {
      try {
        const res = await fetchAgentSessions()
        const data = asRecord(res.data)
        if (res.ok && data.ok) sessions.value = Array.isArray(data.sessions) ? data.sessions as AgentSessionSummary[] : []
      } catch { /* non-critical: session history is optional for the console */ }
    }

    async function loadConfig() {
      loading.value = true
      error.value = ''
      try {
        const res = await fetchAgentConfig()
        if (isAdminRequired(res)) {
          requestAdmin('查看 Agent 控制台需要管理员密码', loadConfig)
          return
        }
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '加载失败'))
        applyConfig(data.config)
        if (asRecord(data.config).persona) applyPersona(asRecord(data.config).persona)
        mode.value = typeof data.mode === 'string' ? data.mode : 'config'
        tools.value = Array.isArray(data.tools) ? data.tools as AgentToolInfo[] : []
        stats.value = asRecord(data.stats) as unknown as AgentStats || { total: 0 }
        skills.value = Array.isArray(data.skills) ? data.skills as AgentSkillInfo[] : []
        personas.value = Array.isArray(data.personas) ? data.personas as AgentPersonaSummary[] : personas.value
        effectiveReadRoots.value = Array.isArray(data.effectiveReadRoots) ? data.effectiveReadRoots.map(String) : []
        const personaRes = await fetchAgentPersonas()
        const personaData = asRecord(personaRes.data)
        if (personaRes.ok && personaData.ok) {
          personas.value = Array.isArray(personaData.personas) ? personaData.personas as AgentPersonaSummary[] : []
          applyPersona(personaData.persona)
        }
        for (const tool of tools.value) {
          if (config.channels.qq.tools[tool.name] === undefined) config.channels.qq.tools[tool.name] = !!tool.qqEnabled
          if (config.channels.dashboard.tools[tool.name] === undefined) config.channels.dashboard.tools[tool.name] = !!tool.dashboardEnabled
        }
        await loadPendingTools()
        await loadSessions()
      } catch (e) {
        error.value = errorMessage(e, '加载失败')
      } finally {
        loading.value = false
      }
    }

    async function savePersona() {
      savingPersona.value = true
      error.value = ''
      message.value = ''
      try {
        const payload = JSON.parse(JSON.stringify(persona))
        const res = await saveAgentPersona(payload)
        if (isAdminRequired(res)) {
          requestAdmin('切换 Agent 人格需要管理员密码', savePersona)
          return
        }
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '人格更新失败'))
        applyPersona(data.persona || payload)
        config.persona = JSON.parse(JSON.stringify(persona))
        history.value = []
        localStorage.removeItem('dashboard_agent_history')
        message.value = messageFromData(data, 'Agent 人格已更新')
      } catch (e) {
        error.value = errorMessage(e, '人格更新失败')
      } finally {
        savingPersona.value = false
      }
    }

    async function loadSessionDetail(id: string) {
      try {
        const res = await fetchAgentSession(id)
        const data = asRecord(res.data)
        if (res.ok && data.ok) selectedSession.value = (data.session as AgentSessionDetail | undefined) || null
      } catch { /* non-critical: failed session detail should not break the panel */ }
    }

    async function saveConfig() {
      saving.value = true
      error.value = ''
      message.value = ''
      try {
        const res = await saveAgentConfig({ config: JSON.parse(JSON.stringify(config)), mode: mode.value })
        if (isAdminRequired(res)) {
          requestAdmin('保存 Agent 配置需要管理员密码', saveConfig)
          return
        }
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '保存失败'))
        applyConfig(data.config)
        mode.value = typeof data.mode === 'string' ? data.mode : mode.value
        message.value = messageFromData(data, '已保存')
      } catch (e) {
        error.value = errorMessage(e, '保存失败')
      } finally {
        saving.value = false
      }
    }

    function addReadRoot() {
      config.readFileRoots.push('')
    }

    function removeReadRoot(index: number) {
      config.readFileRoots.splice(index, 1)
    }

    async function toggleMcp() {
      config.mcp.enabled = !config.mcp.enabled
      await saveConfig()
    }

    function loadHistory() {
      if (!rememberHistory.value) {
        history.value = []
        localStorage.removeItem('dashboard_agent_history')
        return
      }
      try {
        const saved = JSON.parse(localStorage.getItem('dashboard_agent_history') || '[]')
        history.value = Array.isArray(saved) ? saved.filter(item => item && ['user', 'assistant'].includes(item.role)).slice(-30) as AgentChatMessage[] : []
      } catch {
        history.value = []
      }
    }

    function clearHistory() {
      history.value = []
      localStorage.removeItem('dashboard_agent_history')
    }

    function onRememberHistoryChange() {
      if (rememberHistory.value) {
        localStorage.setItem('dashboard_agent_remember_history', '1')
        persistHistory()
      } else {
        localStorage.removeItem('dashboard_agent_remember_history')
        localStorage.removeItem('dashboard_agent_history')
      }
    }

    async function confirmPendingTool(targetId: unknown = pendingId.value) {
      const id = normalizePendingId(targetId)
      if (!id) return
      sending.value = true
      error.value = ''
      try {
        const res = await confirmAgentTool(id)
        if (isAdminRequired(res)) {
          requestAdmin('确认 Agent 工具需要管理员密码', () => confirmPendingTool(id))
          return
        }
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '确认失败'))
        const taskId = typeof data.taskId === 'string' ? data.taskId : ''
        if (taskId) {
          const task = await pollAgentTask(taskId, getAgentReply(data, '工具确认已提交后台执行。'))
          pushAssistant(getAgentTaskReply(task, '工具确认任务已结束，但没有返回文本。'))
          pendingId.value = typeof task?.result?.pendingId === 'string' ? task.result.pendingId : ''
        } else {
          pushAssistant(getAgentReply(data))
          pendingId.value = ''
        }
        await loadConfig()
      } catch (e) {
        error.value = errorMessage(e, '确认失败')
      } finally {
        sending.value = false
      }
    }

    async function rejectPendingTool(targetId: unknown = pendingId.value) {
      const id = normalizePendingId(targetId)
      if (!id) return
      sending.value = true
      error.value = ''
      try {
        const res = await rejectAgentTool(id)
        if (isAdminRequired(res)) {
          requestAdmin('拒绝 Agent 工具需要管理员密码', () => rejectPendingTool(id))
          return
        }
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '拒绝失败'))
        message.value = messageFromData(data, '已拒绝工具请求')
        pendingId.value = ''
        await loadConfig()
      } catch (e) {
        error.value = errorMessage(e, '拒绝失败')
      } finally {
        sending.value = false
      }
    }

    async function sendMessage() {
      const text = prompt.value.trim()
      if (!text) return
      sending.value = true
      error.value = ''
      const recentHistory = history.value.slice(-10)
      history.value.push({ role: 'user', content: text })
      prompt.value = ''
      try {
        const res = await sendAgentMessage(text, recentHistory)
        if (isAdminRequired(res)) {
          const last = history.value[history.value.length - 1]
          if (last && last.role === 'user' && last.content === text) history.value.pop()
          prompt.value = text
          requestAdmin('使用 Dashboard Agent 需要管理员密码', sendMessage)
          return
        }
        const data = asRecord(res.data)
        if (!res.ok || !data.ok) throw new Error(messageFromData(data, '发送失败'))
        const taskId = typeof data.taskId === 'string' ? data.taskId : ''
        if (taskId) {
          const task = await pollAgentTask(taskId, getAgentReply(data, 'Agent 已提交后台执行。'))
          pushAssistant(getAgentTaskReply(task, 'Agent 任务已结束，但没有返回文本。'))
          pendingId.value = typeof task?.result?.pendingId === 'string' ? task.result.pendingId : ''
        } else {
          pushAssistant(getAgentReply(data, data.pendingId ? '工具请求已进入审批队列，请确认后继续。' : '(无回复)'))
          pendingId.value = typeof data.pendingId === 'string' ? data.pendingId : ''
        }
        persistHistory()
        await loadConfig()
      } catch (e) {
        const text = errorMessage(e, '发送失败')
        pushAssistant(text)
        error.value = text
      } finally {
        sending.value = false
      }
    }

    onMounted(() => { loadHistory(); loadConfig() })
    return { loading, saving, savingPersona, sending, error, message, mode, modeOptions, dangerousPolicyOptions, dashboardPersonaOptions, tools, skills, personas, persona, currentDashboardPersona, stats, prompt, pendingId, pendingTools, sessions, selectedSession, effectiveReadRoots, isBrowserToolEnabled, history, rememberHistory, config, formatTime, loadConfig, saveConfig, savePersona, addReadRoot, removeReadRoot, toggleMcp, clearHistory, onRememberHistoryChange, confirmPendingTool, rejectPendingTool, loadSessionDetail, sendMessage }
  },
}
</script>

<style scoped>
.agent-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-head, .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2, h3, p { margin: 0; }
.panel-head p, .tool-row p, .muted { color: var(--text3); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.field, .switch-row { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--card) 70%, transparent); }
.switch-row { flex-direction: row; align-items: center; }
:deep(.sb-wrap), textarea { width: 100%; }
textarea { border: 1px solid var(--border); border-radius: 10px; background: var(--input); color: var(--text); padding: 10px; }
textarea { min-height: 110px; resize: vertical; }
.tool-list, .skill-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.tool-row { display: grid; grid-template-columns: minmax(0, 1fr) 110px 130px; gap: 12px; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); }
.tool-row:last-child, .skill-row:last-child { border-bottom: 0; }
.skill-row { display: grid; grid-template-columns: 24px minmax(120px, .5fr) 90px minmax(0, 1fr); gap: 12px; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); }
.skill-row p { margin: 0; color: var(--text3); }
.tool-row.danger { background: color-mix(in srgb, #ef4444 8%, transparent); }
.tool-row small { color: var(--text3); }
.chat-box { display: grid; grid-template-columns: minmax(0, 1fr) 110px; gap: 12px; align-items: stretch; }
.root-list { display: flex; flex-direction: column; gap: 8px; }
.root-row { display: grid; grid-template-columns: minmax(0, 1fr) 90px; gap: 8px; }
.root-row input { width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--input); color: var(--text); padding: 10px; }
.history-list { display: flex; flex-direction: column; gap: 10px; }
.history-item { border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: color-mix(in srgb, var(--input) 65%, transparent); }
.history-item.user { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.history-item pre { white-space: pre-wrap; margin: 6px 0 0; color: var(--text); font-family: inherit; }
.pending-list, .session-list { display: flex; flex-direction: column; gap: 8px; }
.pending-row, .session-row { display: grid; grid-template-columns: minmax(0, 1fr) 90px 90px; gap: 10px; align-items: center; border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: color-mix(in srgb, var(--input) 65%, transparent); }
.session-row { grid-template-columns: 1fr; }
.pending-row p, .session-row p, .session-row small { margin: 4px 0 0; color: var(--text3); }
.stats-list { display: flex; flex-wrap: wrap; gap: 8px; }
.stat-pill { border: 1px solid var(--border); border-radius: 999px; padding: 6px 10px; color: var(--text3); background: color-mix(in srgb, var(--input) 70%, transparent); }
.chat-actions { display: flex; flex-direction: column; gap: 8px; }
.remember-history { display: flex; align-items: center; gap: 8px; color: var(--text3); font-size: 13px; }
.notice { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border)); border-radius: 12px; color: var(--text); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.notice.error { border-color: color-mix(in srgb, #ef4444 55%, var(--border)); background: color-mix(in srgb, #ef4444 12%, transparent); }
.primary, .ghost { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; color: var(--text); background: var(--input); cursor: pointer; }
.primary { background: color-mix(in srgb, var(--accent) 24%, var(--input)); }
button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 760px) {
  .panel-head, .section-head, .chat-box, .root-row { grid-template-columns: 1fr; display: grid; }
  .tool-row, .skill-row { grid-template-columns: 1fr; }
}
</style>
