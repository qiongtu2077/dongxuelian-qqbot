<template>
  <div class="card">
    <h2>当前状态</h2>
    <div class="row"><label>当前供应商</label><span>{{ status.provider }}</span></div>
    <div class="row"><label>当前模型</label><span>{{ status.model }}</span></div>
  </div>

  <div class="card">
    <h2>Bot 活动日志</h2>
    <div style="margin-bottom:8px;display:flex;gap:8px;align-items:center">
      <button class="btn btn-sm" @click="loadActivity" :disabled="loading">{{ loading ? '刷新中...' : '刷新' }}</button>
      <span v-if="activityCount" style="font-size:12px;color:var(--text3)">{{ activityCount }} 条记录</span>
    </div>
    <div v-if="activityLines.length" style="background:var(--input);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:11px;font-family:monospace;max-height:500px;overflow:auto;white-space:pre-wrap;line-height:1.6;color:var(--text2)">
      <div v-for="(line, i) in activityLines" :key="i" :style="{color: line.includes('send') || line.includes('reply') ? '#39C5BB' : line.includes('repeat') ? '#FCD34D' : 'var(--text2)'}">{{ line }}</div>
    </div>
    <div v-else style="color:var(--text3);font-size:13px">暂无活动数据</div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { fetchStatus, fetchActivity } from '../api'

export default {
  name: 'StatusPanel',
  setup() {
    const status = ref({})
    const activityLines = ref([])
    const activityCount = ref(0)
    const loading = ref(false)

    async function loadActivity() {
      loading.value = true
      const res = await fetchActivity()
      if (res.ok && res.data?.lines) {
        activityLines.value = res.data.lines
        activityCount.value = res.data.total || res.data.lines.length
      }
      loading.value = false
    }

    onMounted(async () => {
      const res = await fetchStatus()
      if (res.ok) status.value = res.data
      await loadActivity()
    })

    return { status, activityLines, activityCount, loading, loadActivity }
  }
}
</script>
