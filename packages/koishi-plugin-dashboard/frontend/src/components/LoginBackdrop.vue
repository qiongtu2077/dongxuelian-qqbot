<template>
  <div class="login-art" aria-hidden="true"><picture v-if="!failed" :key="current">
    <source media="(max-width: 760px)" :srcset="url('small')">
    <img :src="url('large')" alt="" fetchpriority="high" @error="failed = true">
  </picture></div>
</template>
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
const current = ref(1)
const failed = ref(false)
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
let timer: ReturnType<typeof setTimeout> | undefined

/** 只加载当前视口选中的一份插画。 */
function url(size: string) { return `${import.meta.env.BASE_URL}backgrounds/login-${current.value}-${size}.webp` }

/** 切出页面或请求减少动效时停止下载后续画面。 */
function schedule() {
  clearTimeout(timer)
  if (document.hidden || reduced.matches || failed.value) return
  timer = setTimeout(() => { current.value = current.value % 6 + 1; schedule() }, 16000)
}

onMounted(() => { schedule(); document.addEventListener('visibilitychange', schedule); reduced.addEventListener('change', schedule) })
onUnmounted(() => { clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); reduced.removeEventListener('change', schedule) })
</script>
