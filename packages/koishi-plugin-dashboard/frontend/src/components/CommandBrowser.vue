<template>
  <div class="directory-page">
    <div class="directory-tools">
      <label class="search-field"><span>搜索功能与指令</span><input v-model="search" type="search" placeholder="输入功能名、命令或关键词" /></label>
      <button type="button" class="btn btn-ghost" @click="focusSection('command-directory')">跳到指令列表</button>
    </div>
    <section aria-labelledby="feature-directory">
      <h2 id="feature-directory" class="section-heading" tabindex="-1">功能介绍</h2>
      <p v-if="loading" class="empty">正在读取功能…</p>
      <p v-else-if="failed" class="msg err" role="alert">功能目录暂不可用 <button class="btn btn-sm" @click="loadFeatures">重试</button></p>
      <p v-else-if="!filtered.length" class="empty">无匹配功能</p>
      <div v-else class="feature-grid">
        <article v-for="f in filtered" :id="'feat-' + f.id" :key="f.id" class="card feature-card" :class="{ expanded: activeId === f.id }">
          <h3>{{ f.title }}</h3><p class="feature-summary">{{ f.summary }}</p>
          <button type="button" class="btn btn-sm btn-ghost" :aria-expanded="activeId === f.id" @click="activeId = activeId === f.id ? '' : f.id">{{ activeId === f.id ? '收起介绍' : '展开介绍' }}</button>
          <div v-if="activeId === f.id" class="feature-details">
            <p>{{ f.detail }}</p>
            <template v-if="f.usage"><h4>使用方法</h4><pre class="usage">{{ f.usage }}</pre></template>
            <template v-if="f.related?.length"><h4>关联功能</h4><div class="related-features">
              <button v-for="id in f.related" :key="id" class="btn btn-sm" @click="openRelated(id)">{{ features.find(item => item.id === id)?.title || id }}</button>
            </div></template>
          </div>
        </article>
      </div>
    </section>
    <CommandList :query="search" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { fetchFeatures } from '../api'
import type { FeatureInfo } from '../types'
import CommandList from './CommandList.vue'

const features = ref<FeatureInfo[]>([])
const search = ref('')
const activeId = ref('')
const loading = ref(true)
const failed = ref(false)
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  return features.value.filter(item => [item.title, item.summary, item.detail].some(text => text.toLowerCase().includes(term)))
})

/** 只重试功能来源，指令列表独立加载及筛选。 */
async function loadFeatures() {
  loading.value = true
  try {
    const response = await fetchFeatures()
    failed.value = !response.ok || !response.data
    if (response.ok && response.data) features.value = response.data
  } catch { failed.value = true }
  finally { loading.value = false }
}

/** 导航到标题，并为键盘用户同步焦点。 */
function focusSection(id: string) {
  const target = document.getElementById(id)
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'start' })
}

/** 清掉可能隐藏关联卡片的筛选，再展开并定位原编号。 */
async function openRelated(id: string) {
  search.value = ''
  activeId.value = id
  await nextTick()
  const target = document.getElementById('feat-' + id)
  target?.querySelector('button')?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'start' })
}

onMounted(loadFeatures)
</script>
