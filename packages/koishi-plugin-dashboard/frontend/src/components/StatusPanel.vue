<template>
  <section id="system-status" class="card model-status" tabindex="-1" aria-labelledby="system-status-title">
    <h2 id="system-status-title">系统状态</h2>
    <p v-if="loading" role="status">正在读取模型配置…</p>
    <p v-else-if="failed" class="msg err" role="alert">模型状态暂不可用 <button class="btn btn-sm" @click="load">重试</button></p>
    <dl v-else class="model-status-fields">
      <div><dt>当前供应商</dt><dd>{{ status.provider || '未配置' }}</dd></div>
      <div><dt>当前模型</dt><dd>{{ status.model || '未配置' }}</dd></div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fetchStatus } from '../api'
import type { StatusData } from '../types'

const status = ref<StatusData>({})
const loading = ref(true)
const failed = ref(false)

/** 模型状态独立读取一次，使引擎操作与此接口的可用性解耦。 */
async function load() {
  loading.value = true
  try {
    const response = await fetchStatus()
    failed.value = !response.ok || !response.data
    if (response.ok && response.data) status.value = response.data
  } catch { failed.value = true }
  finally { loading.value = false }
}

onMounted(load)
</script>
