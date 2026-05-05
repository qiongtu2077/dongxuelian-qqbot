<template>
  <div class="card">
    <h2>自定义人格</h2>
    <div v-if="!personas.length" style="color:#64748B;font-size:14px">无自定义人格</div>
    <div v-for="p in personas" :key="p.name" class="grp">
      <div class="grp-name">{{ p.name }}</div>
      <div class="grp-desc">{{ p.description || '无描述' }}</div>
    </div>
  </div>

  <div class="card">
    <h2>模式文件</h2>
    <div v-for="m in modes" :key="m.name" class="grp">
      <div class="grp-name">{{ m.name }}</div>
      <div class="grp-desc">{{ m.description || '无描述' }}</div>
      <div style="margin-top:4px"><span class="tag">{{ m.file }}</span></div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { fetchPersonas, fetchModes } from '../api'

export default {
  name: 'PersonaPanel',
  setup() {
    const personas = ref([])
    const modes = ref([])

    onMounted(async () => {
      const [pRes, mRes] = await Promise.all([fetchPersonas(), fetchModes()])
      if (pRes.ok) personas.value = pRes.data
      if (mRes.ok) modes.value = mRes.data
    })

    return { personas, modes }
  }
}
</script>
