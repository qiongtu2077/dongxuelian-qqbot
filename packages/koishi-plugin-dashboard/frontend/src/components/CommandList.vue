<template>
  <section aria-labelledby="command-directory">
    <h2 id="command-directory" class="section-heading" tabindex="-1">指令速查</h2>
    <p v-if="loading" class="empty">正在读取指令…</p>
    <p v-else-if="failed" class="msg err" role="alert">指令列表暂不可用 <button class="btn btn-sm" @click="loadCommands">重试</button></p>
    <p v-else-if="!filtered.length" class="empty">无匹配指令</p>
    <div v-else class="command-groups">
      <section v-for="group in filtered" :key="group.category" class="card">
        <h3>{{ group.category }}</h3>
        <dl class="command-definitions">
          <div v-for="item in group.commands" :key="item.cmd"><dt><code>{{ item.cmd }}</code></dt><dd>{{ item.desc }}</dd></div>
        </dl>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchCommands } from '../api'
import type { CommandGroup } from '../types'

const props = defineProps<{ query: string }>()
const groups = ref<CommandGroup[]>([])
const loading = ref(true)
const failed = ref(false)
const filtered = computed(() => {
  const term = props.query.trim().toLowerCase()
  if (!term) return groups.value
  return groups.value.map(group => ({
    category: group.category,
    commands: group.commands.filter(item => item.cmd.toLowerCase().includes(term) || item.desc.toLowerCase().includes(term))
  })).filter(group => group.commands.length)
})

/** 各组保持服务端顺序，显式失败可单独重试。 */
async function loadCommands() {
  loading.value = true
  try {
    const response = await fetchCommands()
    failed.value = !response.ok || !response.data
    if (response.ok && response.data) groups.value = response.data
  } catch { failed.value = true }
  finally { loading.value = false }
}

onMounted(loadCommands)
</script>
