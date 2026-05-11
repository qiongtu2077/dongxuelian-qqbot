<template>
  <div>
    <div class="card log-toolbar">
      <div class="toolbar-head">
        <div>
          <h2>日志中心</h2>
          <div class="meta">{{ entries.length }} / {{ total }} 行<span v-if="refreshing" class="meta-dot">刷新中</span></div>
        </div>
        <div class="toolbar-actions">
          <button class="icon-btn" type="button" title="刷新" @click="resetAndLoadLogs" :disabled="refreshing">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.2 6.5"/><path d="M3 12A9 9 0 0 1 18.2 5.5"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/></svg>
          </button>
          <button class="icon-btn" type="button" :title="autoRefresh ? '暂停自动刷新' : '开启自动刷新'" @click="autoRefresh = !autoRefresh">
            <svg v-if="autoRefresh" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="icon-btn" type="button" title="复制当前结果" @click="copyResults">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>

      <div class="controls-grid">
        <label class="field">
          <span>最近行数</span>
          <select v-model.number="limit" @change="resetAndLoadLogs">
            <option v-for="n in limits" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label class="field">
          <span>模块</span>
          <select v-model="moduleFilter" @change="resetAndLoadLogs">
            <option value="all">全部</option>
            <option value="dongxuelian-ai">dongxuelian-ai</option>
            <option value="koishi">koishi</option>
            <option value="onebot">onebot</option>
            <option value="napcat">napcat</option>
            <option value="dashboard">dashboard</option>
          </select>
        </label>
        <label class="field field-wide">
          <span>搜索</span>
          <input v-model="query" @keyup.enter="resetAndLoadLogs" placeholder="关键词" />
        </label>
      </div>

      <div class="filter-row">
        <button v-for="item in levelOptions" :key="item.id" type="button" :class="['level-toggle', 'level-' + item.id.toLowerCase(), { active: levels.includes(item.id) }]" @click="toggleLevel(item.id)">
          {{ item.id }} {{ item.label }}
        </button>
        <label class="check-pill"><input type="checkbox" v-model="errorsOnly" @change="resetAndLoadLogs" /> 仅错误</label>
        <label class="check-pill"><input type="checkbox" v-model="debugEnabled" @change="saveDebugToggle" /> 调试日志</label>
      </div>
      <div v-if="message" class="msg" :class="message.type">{{ message.text }}</div>
    </div>

    <div class="card log-output">
      <div v-if="loading && !entries.length" class="empty">加载中...</div>
      <div v-else-if="!entries.length" class="empty">暂无匹配日志</div>
      <div v-else class="log-list">
        <div v-for="entry in entries" :key="entry.id" :class="['log-line', 'level-' + entry.level.toLowerCase()]">
          <span class="level-mark">{{ entry.level }}</span>
          <span class="log-time">{{ entry.time || '--:--:--' }}</span>
          <span class="log-module">{{ entry.module }}</span>
          <span class="log-text">{{ entry.message || entry.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { inject, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { fetchLogs, fetchLoggingConfig, saveLoggingConfig } from '../api'

export default {
  name: 'LogPanel',
  setup() {
    const showAdminDialog = inject('showAdminDialog')
    const entries = ref([])
    const total = ref(0)
    const loading = ref(false)
    const refreshing = ref(false)
    const message = ref(null)
    const limit = ref(200)
    const limits = [100, 200, 500, 1000, 3000, 6000]
    const moduleFilter = ref('all')
    const query = ref('')
    const errorsOnly = ref(false)
    const autoRefresh = ref(true)
    const debugEnabled = ref(false)
    const savingDebug = ref(false)
    const levels = ref(['I', 'W', 'E', 'D'])
    const lastId = ref(0)
    const lastFilterKey = ref('')
    const loaded = ref(false)
    const idleRefreshes = ref(0)
    const refreshDelay = ref(5000)
    const levelOptions = [
      { id: 'I', label: '信息' },
      { id: 'W', label: '警告' },
      { id: 'E', label: '错误' },
      { id: 'D', label: '调试' },
    ]
    let timer = null

    async function loadConfig() {
      const res = await fetchLoggingConfig()
      if (res.ok && res.data?.config) debugEnabled.value = !!res.data.config.enabled
    }

    async function loadLogs(options = {}) {
      const reset = !!options.reset
      const incremental = !reset && loaded.value && lastFilterKey.value
      loading.value = reset || !loaded.value
      refreshing.value = true
      try {
        const res = await fetchLogs({
          limit: limit.value,
          levels: levels.value,
          module: moduleFilter.value,
          q: query.value.trim(),
          errorsOnly: errorsOnly.value ? 1 : '',
          since: incremental ? lastId.value : '',
          filterKey: incremental ? lastFilterKey.value : '',
        })
        if (res.ok) {
          const data = res.data || {}
          const nextEntries = data.entries || []
          const canMerge = incremental && Array.isArray(data.newEntries) && !data.filterChanged
          if (canMerge) {
            if (data.newEntries.length) {
              const seen = new Set(entries.value.map(item => item.id))
              const merged = entries.value.concat(data.newEntries.filter(item => !seen.has(item.id)))
              entries.value = merged.slice(-limit.value)
            }
          } else {
            entries.value = nextEntries.slice(-limit.value)
          }
          total.value = data.total || entries.value.length
          lastId.value = Number(data.lastId) || entries.value[entries.value.length - 1]?.id || 0
          lastFilterKey.value = data.filterKey || ''
          loaded.value = true
          if (data.newCount > 0) { idleRefreshes.value = 0; refreshDelay.value = 5000 }
          else { idleRefreshes.value += 1; refreshDelay.value = idleRefreshes.value >= 3 ? 10000 : 5000 }
          if (data.config) debugEnabled.value = !!data.config.enabled
        } else {
          message.value = { type: 'err', text: res.data?.message || '日志读取失败' }
        }
      } finally {
        loading.value = false
        refreshing.value = false
      }
    }

    function resetLogCursor() {
      lastId.value = 0
      lastFilterKey.value = ''
      loaded.value = false
      idleRefreshes.value = 0
      refreshDelay.value = 5000
    }

    function resetAndLoadLogs() {
      resetLogCursor()
      loadLogs({ reset: true })
    }

    function toggleLevel(level) {
      if (levels.value.includes(level)) levels.value = levels.value.filter(item => item !== level)
      else levels.value = [...levels.value, level]
      resetAndLoadLogs()
    }

    async function saveDebugToggle() {
      if (savingDebug.value) return
      savingDebug.value = true
      const desired = !!debugEnabled.value
      const doSave = async () => {
        const res = await saveLoggingConfig({ enabled: desired })
        if (res.code === 'ADMIN_REQUIRED') {
          if (showAdminDialog) showAdminDialog('修改调试日志开关需要管理员密码', doSave)
          return
        }
        if (res.ok) {
          debugEnabled.value = !!res.data.config?.enabled
          message.value = { type: 'ok', text: res.data.message || '已保存' }
          resetAndLoadLogs()
        } else {
          debugEnabled.value = !desired
          message.value = { type: 'err', text: res.data?.message || '保存失败' }
        }
      }
      try { await doSave() } finally { savingDebug.value = false }
    }

    async function copyResults() {
      const text = entries.value.map(item => item.text).join('\n')
      try {
        await navigator.clipboard.writeText(text)
        message.value = { type: 'ok', text: '已复制当前日志' }
      } catch {
        message.value = { type: 'err', text: '复制失败' }
      }
    }

    function startTimer() {
      stopTimer()
      timer = setTimeout(async () => {
        if (autoRefresh.value) {
          await loadLogs()
          startTimer()
        }
      }, refreshDelay.value)
    }
    function stopTimer() { if (timer) clearTimeout(timer); timer = null }

    watch(autoRefresh, enabled => { if (enabled) { loadLogs(); startTimer() } else stopTimer() })
    onMounted(() => { loadConfig(); loadLogs({ reset: true }); startTimer() })
    onActivated(() => { loadConfig(); resetAndLoadLogs() })
    onUnmounted(stopTimer)

    return { entries, total, loading, refreshing, message, limit, limits, moduleFilter, query, errorsOnly, autoRefresh, debugEnabled, levels, levelOptions, loadLogs, resetAndLoadLogs, toggleLevel, saveDebugToggle, copyResults }
  }
}
</script>

<style scoped>
.log-toolbar { display: flex; flex-direction: column; gap: 16px; }
.toolbar-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.toolbar-actions { display: flex; gap: 8px; align-items: center; }
.meta { display: flex; gap: 8px; align-items: center; color: var(--text3); font-size: 13px; }
.meta-dot { color: var(--accent); font-weight: 800; }
.controls-grid { display: grid; grid-template-columns: 160px 180px minmax(220px, 1fr); gap: 12px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 6px; color: var(--text2); font-size: 13px; }
.field select, .field input { width: 100%; }
.filter-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.level-toggle, .check-pill {
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--text2);
  border-radius: 6px;
  padding: 6px 10px;
  font-weight: 700;
  font-size: 12px;
  cursor: pointer;
}
.level-toggle.active { border-color: var(--accent); color: var(--text); background: var(--accentDim); }
.check-pill { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.check-pill input { flex: 0 0 auto; width: auto; }
.log-output { min-height: 380px; }
.log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 64vh;
  overflow: auto;
  padding-right: 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--accent) var(--input);
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Microsoft YaHei Mono', monospace;
  font-size: 12px;
}
.log-list::-webkit-scrollbar { width: 10px; height: 10px; }
.log-list::-webkit-scrollbar-track { background: var(--input); border: 1px solid var(--border); border-radius: 999px; }
.log-list::-webkit-scrollbar-thumb { background: linear-gradient(180deg, var(--accent), var(--accent2)); border: 2px solid var(--input); border-radius: 999px; background-clip: padding-box; }
.log-list::-webkit-scrollbar-thumb:hover { box-shadow: 0 0 12px var(--shadow); border-color: var(--border); }
.log-list::-webkit-scrollbar-corner { background: var(--input); }
.log-line { display: grid; grid-template-columns: 34px minmax(20ch, 22ch) minmax(13ch, 16ch) minmax(0, 1fr); gap: 10px; align-items: start; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.03); border: 1px solid transparent; }
.level-mark { font-weight: 900; text-align: center; border-radius: 4px; color: #11110d; background: var(--accent); }
.level-w .level-mark { background: #f59e0b; }
.level-e .level-mark { background: var(--danger); color: #fff; }
.level-d .level-mark { background: var(--info); color: #041318; }
.log-time, .log-module, .log-text { min-width: 0; }
.log-time { color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-module { color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 800; }
.log-text { color: var(--text2); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.empty { color: var(--text3); text-align: center; padding: 80px 0; }
@media (max-width: 760px) {
  .toolbar-head { align-items: flex-start; flex-direction: column; }
  .controls-grid { grid-template-columns: 1fr; }
  .log-list { max-height: 52vh; }
  .log-line { grid-template-columns: 34px minmax(0, 1fr); }
  .log-time, .log-module { grid-column: 2; }
  .log-text { grid-column: 1 / -1; }
}

@media (min-width: 1800px) {
  .log-list::-webkit-scrollbar { width: 12px; height: 12px; }
}
</style>
