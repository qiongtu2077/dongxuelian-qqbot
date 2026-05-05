<template>
  <div class="card">
    <h2>解除上限群白名单</h2>
    <div v-if="!list.length" style="color:#64748B;font-size:14px">白名单为空</div>
    <div v-for="id in list" :key="id" class="grp">
      <span style="font-family:monospace;font-size:14px">{{ id }}</span>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { fetchWhitelist } from '../api'

export default {
  name: 'WhitelistPanel',
  setup() {
    const list = ref([])
    onMounted(async () => {
      const res = await fetchWhitelist()
      if (res.ok) list.value = res.data
    })
    return { list }
  }
}
</script>
