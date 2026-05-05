<template>
  <div class="card">
    <h2>当前状态</h2>
    <div class="row"><label>当前供应商</label><span>{{ status.provider }}</span></div>
    <div class="row"><label>当前模型</label><span>{{ status.model }}</span></div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { fetchStatus } from '../api'

export default {
  name: 'StatusPanel',
  setup() {
    const status = ref({})
    onMounted(async () => {
      const res = await fetchStatus()
      if (res.ok) status.value = res.data
    })
    return { status }
  }
}
</script>
