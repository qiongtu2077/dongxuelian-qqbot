<template>
  <div>
    <div class="card">
      <h2>指令速查</h2>
      <input v-model="search" placeholder="搜索指令..." style="width:100%" />
    </div>

    <div v-for="group in filtered" :key="group.category" class="card">
      <h2>{{ group.category }}</h2>
      <div v-for="c in group.commands" :key="c.cmd" class="grp">
        <div class="grp-name" style="font-family:monospace;color:var(--accent)">{{ c.cmd }}</div>
        <div class="grp-desc">{{ c.desc }}</div>
      </div>
    </div>

    <div v-if="!filtered.length" class="card" style="color:var(--text3);text-align:center">
      无匹配结果
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { fetchCommands } from '../api'

export default {
  name: 'CommandList',
  setup() {
    const groups = ref([])
    const search = ref('')

    const filtered = computed(() => {
      const q = search.value.trim().toLowerCase()
      if (!q) return groups.value
      return groups.value.map(g => ({
        category: g.category,
        commands: g.commands.filter(c =>
          c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
        ),
      })).filter(g => g.commands.length > 0)
    })

    onMounted(async () => {
      const res = await fetchCommands()
      if (res.ok) groups.value = res.data
    })

    return { groups, search, filtered }
  }
}
</script>
