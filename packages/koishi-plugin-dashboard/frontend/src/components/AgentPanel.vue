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
        <select v-model="mode">
          <option value="config">跟随配置</option>
          <option value="confirm">危险工具需确认</option>
          <option value="block">禁用危险工具</option>
          <option value="auto">自动执行</option>
        </select>
      </label>
      <label class="field">
        <span>危险工具策略</span>
        <select v-model="config.dangerousPolicy">
          <option value="confirm">需确认</option>
          <option value="block">禁用</option>
          <option value="auto">自动执行</option>
        </select>
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
        <select v-model="persona.dashboardPersona" :disabled="savingPersona" @change="savePersona">
          <option value="">默认（东雪莲）</option>
          <option v-for="item in personas" :key="item.name" :value="item.name">{{ item.name }}</option>
        </select>
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
        <button class="ghost" type="button" :disabled="sending || !pendingId" @click="confirmPendingTool">确认工具</button>
        <button class="ghost" type="button" :disabled="sending || history.length === 0" @click="clearHistory">清空</button>
      </div>
    </div>
    <div v-if="history.length" class="history-list">
      <div v-for="(item, index) in history" :key="index" class="history-item" :class="item.role">
        <strong>{{ item.role === 'user' ? '你' : 'Agent' }}</strong>
        <pre>{{ item.content }}</pre>
      </div>
    </div>
  </section>
</template>

<script>
import { computed, inject, onMounted, reactive, ref } from 'vue'
import { fetchAgentConfig, saveAgentConfig, fetchAgentPersonas, saveAgentPersona, sendAgentMessage, confirmAgentTool, rejectAgentTool, fetchPendingAgentTools, fetchAgentSessions, fetchAgentSession } from '../api'

const defaultConfig = {
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
}

export default {
  name: 'AgentPanel',
  setup() {
    const showAdminDialog = inject('showAdminDialog')
    const loading = ref(false)
    const saving = ref(false)
    const savingPersona = ref(false)
    const sending = ref(false)
    const error = ref('')
    const message = ref('')
    const mode = ref('config')
    const tools = ref([])
    const skills = ref([])
    const personas = ref([])
    const stats = ref({ total: 0 })
    const prompt = ref('')
    const pendingId = ref('')
    const pendingTools = ref([])
    const sessions = ref([])
    const selectedSession = ref(null)
    const effectiveReadRoots = ref([])
    const history = ref([])
    const config = reactive(JSON.parse(JSON.stringify(defaultConfig)))
    const persona = reactive({ dashboardPersona: '', qqInheritChatPersona: true })
    const isBrowserToolEnabled = computed(() => !!config.channels.dashboard.tools.browser_action)
    const currentDashboardPersona = computed(() => persona.dashboardPersona || '')

    function applyConfig(next) {
      const merged = JSON.parse(JSON.stringify({ ...defaultConfig, ...(next || {}) }))
      config.dangerousPolicy = merged.dangerousPolicy || 'confirm'
      config.readFileRoots = Array.isArray(merged.readFileRoots) ? merged.readFileRoots : []
      for (const channel of ['qq', 'dashboard']) {
        config.channels[channel].enabled = !!merged.channels?.[channel]?.enabled
        config.channels[channel].tools = { ...(merged.channels?.[channel]?.tools || {}) }
        config.autoRoute[channel].enabled = !!merged.autoRoute?.[channel]?.enabled
      }
      config.enabledSkills = Array.isArray(merged.enabledSkills) ? merged.enabledSkills.slice() : []
      persona.dashboardPersona = String(merged.persona?.dashboardPersona || '')
      persona.qqInheritChatPersona = merged.persona?.qqInheritChatPersona !== false
    }

    function applyPersona(next) {
      const value = next && typeof next === 'object' ? next : {}
      persona.dashboardPersona = String(value.dashboardPersona || '')
      persona.qqInheritChatPersona = value.qqInheritChatPersona !== false
    }

    function formatTime(ts) {
      if (!ts) return '-'
      try { return new Date(ts).toLocaleTimeString() } catch { return '-' }
    }

    function isAdminRequired(res) {
      return res && (res.code === 'ADMIN_REQUIRED' || res.data?.code === 'ADMIN_REQUIRED')
    }

    function requestAdmin(messageText, retry) {
      if (showAdminDialog) showAdminDialog(messageText, retry)
      else error.value = '需要管理员密码验证'
    }

    function normalizePendingId(value = pendingId.value) {
      return typeof value === 'string' ? value : (pendingId.value || '')
    }

    function getAgentReply(data, fallback = '') {
      return String(data?.reply || data?.result || data?.message || fallback || '').trim()
    }

    function persistHistory() {
      history.value = history.value.slice(-30)
      localStorage.setItem('dashboard_agent_history', JSON.stringify(history.value))
    }

    function pushAssistant(content) {
      const text = String(content || '').trim()
      if (!text) return
      history.value.push({ role: 'assistant', content: text })
      persistHistory()
    }

    async function loadPendingTools() {
      try {
        const res = await fetchPendingAgentTools()
        if (res.ok && res.data?.ok) {
          pendingTools.value = Array.isArray(res.data.pending) ? res.data.pending : []
          pendingId.value = pendingTools.value[0]?.id || ''
        }
      } catch {}
    }

    async function loadSessions() {
      try {
        const res = await fetchAgentSessions()
        if (res.ok && res.data?.ok) sessions.value = Array.isArray(res.data.sessions) ? res.data.sessions : []
      } catch {}
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
        if (!res.ok || !res.data?.ok) throw new Error(res.data?.message || '加载失败')
        applyConfig(res.data.config)
        if (res.data.config?.persona) applyPersona(res.data.config.persona)
        mode.value = res.data.mode || 'config'
        tools.value = res.data.tools || []
        stats.value = res.data.stats || { total: 0 }
        skills.value = res.data.skills || []
        personas.value = Array.isArray(res.data.personas) ? res.data.personas : personas.value
        effectiveReadRoots.value = Array.isArray(res.data.effectiveReadRoots) ? res.data.effectiveReadRoots : []
        const personaRes = await fetchAgentPersonas()
        if (personaRes.ok && personaRes.data?.ok) {
          personas.value = Array.isArray(personaRes.data.personas) ? personaRes.data.personas : []
          applyPersona(personaRes.data.persona)
        }
        for (const tool of tools.value) {
          if (config.channels.qq.tools[tool.name] === undefined) config.channels.qq.tools[tool.name] = !!tool.qqEnabled
          if (config.channels.dashboard.tools[tool.name] === undefined) config.channels.dashboard.tools[tool.name] = !!tool.dashboardEnabled
        }
        await loadPendingTools()
        await loadSessions()
      } catch (e) {
        error.value = e.message || '加载失败'
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
        if (!res.ok || !res.data?.ok) throw new Error(res.data?.message || '人格更新失败')
        applyPersona(res.data.persona || payload)
        config.persona = JSON.parse(JSON.stringify(persona))
        history.value = []
        localStorage.removeItem('dashboard_agent_history')
        message.value = res.data.message || 'Agent 人格已更新'
      } catch (e) {
        error.value = e.message || '人格更新失败'
      } finally {
        savingPersona.value = false
      }
    }

    async function loadSessionDetail(id) {
      try {
        const res = await fetchAgentSession(id)
        if (res.ok && res.data?.ok) selectedSession.value = res.data.session || null
      } catch {}
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
        if (!res.ok || !res.data?.ok) throw new Error(res.data?.message || '保存失败')
        applyConfig(res.data.config)
        mode.value = res.data.mode || mode.value
        message.value = res.data.message || '已保存'
      } catch (e) {
        error.value = e.message || '保存失败'
      } finally {
        saving.value = false
      }
    }

    function addReadRoot() {
      config.readFileRoots.push('')
    }

    function removeReadRoot(index) {
      config.readFileRoots.splice(index, 1)
    }

    function loadHistory() {
      try {
        const saved = JSON.parse(localStorage.getItem('dashboard_agent_history') || '[]')
        history.value = Array.isArray(saved) ? saved.filter(item => item && ['user', 'assistant'].includes(item.role)).slice(-30) : []
      } catch {
        history.value = []
      }
    }

    function clearHistory() {
      history.value = []
      localStorage.removeItem('dashboard_agent_history')
    }

    async function confirmPendingTool(targetId = pendingId.value) {
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
        if (!res.ok || !res.data?.ok) throw new Error(res.data?.message || '确认失败')
        pushAssistant(getAgentReply(res.data))
        pendingId.value = ''
        await loadConfig()
      } catch (e) {
        error.value = e.message || '确认失败'
      } finally {
        sending.value = false
      }
    }

    async function rejectPendingTool(targetId = pendingId.value) {
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
        if (!res.ok || !res.data?.ok) throw new Error(res.data?.message || '拒绝失败')
        message.value = res.data.message || '已拒绝工具请求'
        pendingId.value = ''
        await loadConfig()
      } catch (e) {
        error.value = e.message || '拒绝失败'
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
        if (!res.ok || !res.data?.ok) throw new Error(res.data?.message || '发送失败')
        pushAssistant(getAgentReply(res.data, res.data?.pendingId ? '工具请求已进入审批队列，请确认后继续。' : '(无回复)'))
        pendingId.value = res.data.pendingId || ''
        persistHistory()
        await loadConfig()
      } catch (e) {
        pushAssistant(e.message || '发送失败')
        error.value = e.message || '发送失败'
      } finally {
        sending.value = false
      }
    }

    onMounted(() => { loadHistory(); loadConfig() })
    return { loading, saving, savingPersona, sending, error, message, mode, tools, skills, personas, persona, currentDashboardPersona, stats, prompt, pendingId, pendingTools, sessions, selectedSession, effectiveReadRoots, isBrowserToolEnabled, history, config, formatTime, loadConfig, saveConfig, savePersona, addReadRoot, removeReadRoot, clearHistory, confirmPendingTool, rejectPendingTool, loadSessionDetail, sendMessage }
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
select, textarea { width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--input); color: var(--text); padding: 10px; }
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
