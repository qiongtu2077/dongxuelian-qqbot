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
      <div v-if="keyMsg" style="margin-top:8px;font-size:13px" :style="{color: keyMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ keyMsg.text }}</div>
    </div>
  </div>

  <div class="card">
    <h2>Token 用量</h2>
    <div v-if="!chartDays.length" style="color:var(--text3);font-size:13px">暂无用量数据</div>
    <div v-else>
      <div style="margin-bottom:8px;display:flex;gap:12px;flex-wrap:wrap">
        <div v-for="p in chartProviders" :key="p.key" style="display:flex;align-items:center;gap:4px;font-size:12px">
          <span :style="{width:10,height:10,borderRadius:2,background:p.color}"></span>
          <span style="color:var(--text2)">{{ p.label }}</span>
        </div>
      </div>
      <div style="display:flex;align-items:flex-end;gap:4px;height:140px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div v-for="d in chartDays" :key="d.date" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
          <div style="width:100%;display:flex;flex-direction:column-reverse;border-radius:4px 4px 0 0;overflow:hidden;transition:height .3s" :style="{height: d.pct + '%', minHeight: d.total ? 4 : 0}">
            <div v-for="s in d.segments" :key="s.provider"
              :style="{height: s.pct + '%', background: s.color, transition: 'height .3s'}"></div>
          </div>
          <span style="font-size:9px;color:var(--text3);margin-top:4px;white-space:nowrap">{{ d.date.slice(5) }}</span>
        </div>
      </div>
      <div v-if="totalStr" style="margin-top:8px;font-size:12px;color:var(--text2);text-align:center">近7天总用量：{{ totalStr }}</div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { fetchKeys, updateKey, fetchKeyUsage } from '../api'

const COLORS = ['#2dd4bf', '#fb923c', '#6366f1', '#f472b6', '#facc15']

export default {
  name: 'KeyManager',
  setup() {
    const keys = ref([])
    const editing = ref(null)
    const editValue = ref('')
    const saving = ref(false)
    const keyMsg = ref(null)

    const rawUsage = ref({ days: [], providers: [] })

    const chartProviders = computed(() => rawUsage.value.providers.map((p, i) => ({ ...p, color: COLORS[i % COLORS.length] })))

    const chartDays = computed(() => {
      const days = rawUsage.value.days.slice(-7)
      const maxTotal = Math.max(...days.map(d => {
        let t = 0
        for (const p of rawUsage.value.providers) t += d[p.key] || 0
        return t
      }), 1)
      return days.map(d => {
        const segments = []
        let total = 0
        for (const p of rawUsage.value.providers) {
          const v = d[p.key] || 0
          if (v > 0) {
            total += v
            segments.push({ provider: p.key, count: v, color: COLORS[rawUsage.value.providers.indexOf(p) % COLORS.length], pct: (v / maxTotal) * 100 })
          }
        }
        return { date: d.date, total, pct: (total / maxTotal) * 100, segments }
      })
    })

    const totalStr = computed(() => {
      const days = rawUsage.value.days.slice(-7)
      let t = 0
      for (const d of days) for (const p of rawUsage.value.providers) t += d[p.key] || 0
      return t > 0 ? t.toLocaleString() + ' tokens' : ''
    })

    onMounted(async () => {
      const [kRes, uRes] = await Promise.all([fetchKeys(), fetchKeyUsage()])
      if (kRes.ok) keys.value = kRes.data
      if (uRes.ok) rawUsage.value = uRes.data
    })

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
        if (res.code === 'ADMIN_REQUIRED') { window.showAdminDialog && window.showAdminDialog('修改 Key 需要管理员密码', saveKey); return }
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

    return { keys, editing, editValue, saving, keyMsg, chartProviders, chartDays, totalStr, editKey, saveKey }
  }
}
</script>
