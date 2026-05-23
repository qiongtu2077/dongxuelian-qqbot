<template>
  <div class="card">
    <h2>API Key 管理</h2>
    <div style="color:var(--text3);font-size:13px;margin-bottom:16px">
      修改后自动热加载，无需重启
    </div>
    <div v-for="k in keys" :key="k.file" class="grp">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="grp-name">{{ k.label }}</div>
          <div style="font-size:12px;color:var(--text3);font-family:monospace">{{ k.exists ? k.prefix : '（未设置）' }}</div>
        </div>
        <button class="btn btn-sm" @click="editKey(k)">编辑</button>
      </div>
    </div>

    <div v-if="editing" class="msg ok" style="margin-top:16px">
      <div style="margin-bottom:8px;font-weight:700">编辑 {{ editing.label }}</div>
      <input v-model="editValue" style="width:100%;font-family:monospace" :placeholder="'输入新的 ' + editing.file" />
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-sm" @click="saveKey" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
        <button class="btn btn-sm" style="background:var(--border);color:var(--text2)" @click="editing=null">取消</button>
      </div>
      <div v-if="keyMsg" style="margin-top:8px;font-size:13px" :style="{color: keyMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ keyMsg.text }}</div>
    </div>
    <div v-else-if="keyMsg" class="msg" :class="keyMsg.type" style="margin-top:16px">{{ keyMsg.text }}</div>
  </div>

  <div class="card token-usage-card">
    <div class="token-usage-head">
      <div>
        <h2>Token 用量</h2>
        <div class="token-subtitle">{{ usageDays.length ? '最近 ' + usageDays.length + ' 天' : 'API 调用后自动记录' }}</div>
      </div>
      <button class="btn btn-sm token-refresh" @click="loadUsage" :disabled="loadingUsage">{{ loadingUsage ? '加载中...' : '刷新' }}</button>
    </div>
    <div v-if="usageDays.length" class="token-summary">
      <div class="token-summary-item">
        <span>合计</span>
        <strong>{{ formatTokens(usageTotal) }}</strong>
      </div>
      <div class="token-summary-item">
        <span>峰值</span>
        <strong>{{ formatTokens(usageMax) }}</strong>
      </div>
      <div class="token-summary-item">
        <span>日均</span>
        <strong>{{ formatTokens(usageAverage) }}</strong>
      </div>
    </div>
    <div v-if="usageProviders.length" class="token-legend">
      <span v-for="p in usageProviders" :key="p.key" class="token-legend-item">
        <span class="token-legend-dot" :style="{ background: p.color }"></span>
        {{ p.label }}
      </span>
    </div>
    <div v-if="usageDays.length" class="token-bars">
      <div class="token-bar-row" v-for="day in usageDays" :key="day.date">
        <span class="token-date">{{ day.date.slice(5) }}</span>
        <div class="token-bars-track">
          <div class="token-bars-stack" :style="{ width: barWidth(day) + '%' }">
            <div v-for="p in nonZeroSegments(day)" :key="p.key" class="token-bar-seg"
              :style="{ flexGrow: p.value, background: p.color }"
              :title="p.label + ': ' + formatTokens(p.value)">
            </div>
          </div>
        </div>
        <span class="token-count">{{ formatTokens(dayTotal(day)) }}</span>
      </div>
    </div>
    <div v-else class="token-empty">暂无用量数据</div>
  </div>
</template>

<script>
import { inject, ref, onMounted } from 'vue'
import { fetchKeys, updateKey, fetchKeysUsage } from '../api'

const providerColors = {
  opencode: '#f7c948', openai: '#f7c948', dashscope: '#38bdf8', deepseek: '#a78bfa',
  glm: '#34d399', mimorium: '#f472b6', unknown: '#94a3b8'
}

function formatTokens(n) {
  const value = Number(n || 0)
  if (value >= 1000000000) return (value / 1000000000).toFixed(2) + 'B'
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 1 : 2) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 1 : 2) + 'K'
  return String(Math.round(value))
}

function normalizeProvider(raw) {
  if (raw && typeof raw === 'object') {
    const key = String(raw.key || raw.provider || raw.name || '').trim()
    const label = String(raw.label || raw.name || key || 'unknown').trim()
    return { key: key || label || 'unknown', label: label || key || 'unknown' }
  }
  const key = String(raw || '').trim()
  return { key: key || 'unknown', label: key || 'unknown' }
}

function toNumber(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export default {
  name: 'KeyManager',
  setup() {
    const showAdminDialog = inject('showAdminDialog')
    const keys = ref([])
    const editing = ref(null)
    const editValue = ref('')
    const saving = ref(false)
    const keyMsg = ref(null)
    const usageDays = ref([])
    const usageProviders = ref([])
    const usageMax = ref(1)
    const usageTotal = ref(0)
    const usageAverage = ref(0)
    const loadingUsage = ref(false)

    async function loadKeys() {
      const res = await fetchKeys()
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('查看 Key 需要管理员密码', loadKeys); return }
      if (res.ok) keys.value = res.data
    }
    onMounted(() => { loadKeys(); loadUsage() })

    function editKey(k) {
      editing.value = k
      editValue.value = ''
      keyMsg.value = null
    }

    async function saveKey() {
      if (!editValue.value.trim()) return
      saving.value = true
      keyMsg.value = null
      try {
        const res = await updateKey(editing.value.file, editValue.value.trim())
        if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('修改 Key 需要管理员密码', saveKey); saving.value = false; return }
        if (res.ok) {
          keyMsg.value = { type: 'ok', text: 'Key 已更新并热加载' }
          const reload = await fetchKeys()
          if (reload.ok) keys.value = reload.data
          editing.value = null
        } else {
          keyMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
        }
      } catch (e) { keyMsg.value = { type: 'err', text: e.message } }
      saving.value = false
    }

    async function loadUsage() {
      loadingUsage.value = true
      const res = await fetchKeysUsage()
      if (res.ok && res.data) {
        const normalizedProviders = (res.data.providers || []).map(normalizeProvider)
        const providerMap = new Map()
        for (const provider of normalizedProviders) {
          if (!provider.key || providerMap.has(provider.key)) continue
          providerMap.set(provider.key, {
            ...provider,
            color: providerColors[provider.key] || providerColors.unknown,
          })
        }
        usageDays.value = (res.data.days || []).map(function(day) {
          const normalized = { date: String(day.date || '') }
          for (const [key, value] of Object.entries(day || {})) {
            if (key === 'date') continue
            normalized[key] = toNumber(value)
            if (!providerMap.has(key)) {
              providerMap.set(key, { key, label: key, color: providerColors[key] || providerColors.unknown })
            }
          }
          return normalized
        })
        usageProviders.value = Array.from(providerMap.values())
        let max = 1
        let total = 0
        for (const d of usageDays.value) {
          let daySum = 0
          for (const p of usageProviders.value) {
            daySum += toNumber(d[p.key])
          }
          if (daySum > max) max = daySum
          total += daySum
        }
        usageMax.value = max
        usageTotal.value = total
        usageAverage.value = usageDays.value.length ? Math.round(total / usageDays.value.length) : 0
      }
      loadingUsage.value = false
    }

    function dayTotal(day) {
      let sum = 0
      for (const p of usageProviders.value) sum += toNumber(day[p.key])
      return sum
    }

    function nonZeroSegments(day) {
      return usageProviders.value
        .map(p => ({ ...p, value: toNumber(day[p.key]) }))
        .filter(p => p.value > 0)
    }

    function barWidth(day) {
      if (!usageMax.value) return 0
      return Math.max(dayTotal(day) / usageMax.value * 100, dayTotal(day) > 0 ? 0.7 : 0)
    }

    return { keys, editing, editValue, saving, keyMsg, editKey, saveKey, usageDays, usageProviders, usageMax, usageTotal, usageAverage, loadingUsage, loadUsage, formatTokens, dayTotal, nonZeroSegments, barWidth }
  }
}
</script>

<style scoped>
.token-usage-card {
  margin-top: 16px;
  padding: 24px 28px 26px;
  background:
    radial-gradient(circle at 14% 0%, rgba(89, 128, 255, 0.18), transparent 38%),
    linear-gradient(145deg, rgba(20, 32, 60, 0.96), rgba(31, 27, 76, 0.98) 50%, rgba(18, 42, 78, 0.97));
  border-color: rgba(142, 173, 255, 0.28);
  box-shadow:
    0 22px 70px rgba(3, 7, 18, 0.28),
    inset 0 1px 0 rgba(255,255,255,0.16),
    inset 0 0 0 1px rgba(125, 211, 252, 0.05);
}

.token-usage-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  position: relative;
  z-index: 1;
}

.token-usage-head h2 {
  display: inline-flex;
  margin: 0 0 8px;
  padding: 4px 10px 5px;
  border-radius: 6px;
  color: #f8fbff;
  font-size: 22px;
  font-weight: 900;
  line-height: 1.15;
  background: linear-gradient(180deg, rgba(67, 112, 248, 0.88), rgba(45, 88, 218, 0.72));
  box-shadow: 0 8px 24px rgba(59, 130, 246, 0.24);
}

.token-subtitle {
  color: rgba(223, 234, 255, 0.78);
  font-size: 13px;
  font-weight: 700;
}

.token-refresh {
  border-radius: 12px;
  min-width: 72px;
  background: rgba(148, 185, 255, 0.18);
  border-color: rgba(190, 214, 255, 0.26);
  color: rgba(246, 249, 255, 0.94);
}

.token-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
  position: relative;
  z-index: 1;
}

.token-summary-item {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(190, 214, 255, 0.12);
  border-radius: 8px;
  background: rgba(255,255,255,0.07);
}

.token-summary-item span {
  display: block;
  color: rgba(222, 233, 255, 0.78);
  font-size: 11px;
  font-weight: 800;
  margin-bottom: 4px;
}

.token-summary-item strong {
  color: #f8fbff;
  font-size: 18px;
  line-height: 1.15;
}

.token-legend {
  display:flex;
  gap:14px;
  margin-bottom:14px;
  flex-wrap:wrap;
  position: relative;
  z-index: 1;
}

.token-legend-item {
  display:flex;
  align-items:center;
  gap:6px;
  font-size:13px;
  color:rgba(231, 238, 255, 0.86);
  font-weight: 800;
}

.token-legend-dot {
  width:12px;
  height:12px;
  border-radius:3px;
  flex-shrink:0;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.18), 0 6px 16px rgba(0,0,0,0.24);
}

.token-bars {
  display:flex;
  flex-direction:column;
  gap:10px;
  position: relative;
  z-index: 1;
}

.token-bar-row {
  display:grid;
  grid-template-columns: 56px minmax(0, 1fr) 70px;
  align-items:center;
  gap:12px;
}

.token-date {
  color:rgba(225, 236, 255, 0.72);
  font-size:13px;
  text-align:right;
  flex-shrink:0;
  font-family:monospace;
  font-weight: 800;
}

.token-bars-track {
  min-width: 0;
  height:28px;
  border-radius:6px;
  background:linear-gradient(90deg, rgba(125, 211, 252, 0.12), rgba(139, 92, 246, 0.10));
  overflow:hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
}

.token-bars-stack {
  height:100%;
  display:flex;
  border-radius:6px;
  overflow:hidden;
  transition: width .28s ease;
}

.token-bar-seg {
  height:100%;
  min-width:3px;
  transition: flex-grow .28s ease;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.26);
}

.token-count {
  font-size:12px;
  color:rgba(232, 239, 255, 0.88);
  text-align:right;
  flex-shrink:0;
  font-family:monospace;
  font-weight: 800;
}

.token-empty {
  color:rgba(226, 236, 255, 0.76);
  font-size:13px;
  position: relative;
  z-index: 1;
}

@media (max-width: 760px) {
  .token-usage-card { padding: 20px }
  .token-summary { grid-template-columns: 1fr }
  .token-bar-row { grid-template-columns: 46px minmax(0, 1fr) 56px; gap:8px }
  .token-usage-head { flex-direction: column }
}
</style>
