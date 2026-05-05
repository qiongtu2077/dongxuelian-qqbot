<template>
  <div>
    <div class="card">
      <h2>功能介绍</h2>
      <p style="color:var(--text2);font-size:14px;margin-bottom:12px">Bot 的各个功能模块，点击跳转查看详情</p>
      <input v-model="search" placeholder="搜索功能..." style="width:100%" />
    </div>

    <div v-if="search && !filtered.length" class="card" style="color:var(--text3);text-align:center">
      无匹配结果
    </div>

    <div v-for="f in filtered" :key="f.id" :id="'feat-' + f.id" class="card feature-card" :style="{borderLeft: '3px solid ' + (activeId === f.id ? '#39C5BB' : 'var(--border)')}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <h2 style="color:#39C5BB;margin-bottom:4px">{{ f.title }}</h2>
        <span v-if="activeId === f.id" style="font-size:12px;color:#39C5BB">▼ 展开中</span>
      </div>
      <div style="color:#94A3B8;font-size:14px;margin-bottom:12px">{{ f.summary }}</div>

      <div v-if="activeId === f.id" style="animation:fadeIn .2s">
        <div class="detail-box">
          <div class="detail-label">功能介绍</div>
          <div class="detail-text">{{ f.detail }}</div>
        </div>
        <div class="detail-box">
          <div class="detail-label">使用方法</div>
          <pre class="usage">{{ f.usage }}</pre>
        </div>
        <div v-if="f.related && f.related.length" class="detail-box">
          <div class="detail-label">关联功能</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <span v-for="rid in f.related" :key="rid" class="tag" style="cursor:pointer" @click="scrollTo(rid)">{{ getTitle(rid) }}</span>
          </div>
        </div>
      </div>

      <button v-if="activeId !== f.id" class="btn btn-sm" style="margin-top:8px" @click="activeId = f.id">展开介绍</button>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { fetchFeatures } from '../api'

export default {
  name: 'CommandBrowser',
  setup() {
    const features = ref([])
    const search = ref('')
    const activeId = ref(null)

    const filtered = computed(() => {
      const q = search.value.trim().toLowerCase()
      if (!q) return features.value
      return features.value.filter(f =>
        f.title.toLowerCase().includes(q) ||
        f.summary.toLowerCase().includes(q) ||
        f.detail.toLowerCase().includes(q)
      )
    })

    function getTitle(id) {
      const f = features.value.find(x => x.id === id)
      return f ? f.title : id
    }

    function scrollTo(id) {
      search.value = ''
      activeId.value = id
      setTimeout(() => {
        const el = document.getElementById('feat-' + id)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }

    onMounted(async () => {
      const res = await fetchFeatures()
      if (res.ok) features.value = res.data
    })

    return { features, search, filtered, activeId, getTitle, scrollTo }
  }
}
</script>

<style>
.feature-card { transition: border-color .2s }
.detail-box { margin-top: 12px; padding: 12px 16px; background: var(--input); border-radius: 8px }
.detail-label { font-size: 12px; font-weight: 700; color: var(--text3); text-transform: uppercase; margin-bottom: 6px }
.detail-text { font-size: 14px; line-height: 1.7; color: var(--text) }
.usage { font-size: 13px; line-height: 1.8; color: #39C5BB; font-family: monospace; white-space: pre-wrap; margin: 0 }
@keyframes fadeIn { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: translateY(0) } }
</style>
