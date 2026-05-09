<template>
  <div class="page-backdrop" aria-hidden="true">
    <div class="login-bg active" :style="{ backgroundImage: `url(${activeBackground})` }"></div>
    <div v-if="previousBackground" class="login-bg leaving" :style="{ backgroundImage: `url(${previousBackground})` }"></div>
    <div class="login-vignette"></div>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref } from 'vue'

export default {
  name: 'LoginBackdrop',
  setup() {
    const base = import.meta.env.BASE_URL || '/dashboard/'
    const backgrounds = Array.from({ length: 6 }, (_, index) => `${base}backgrounds/login-bg-${index + 1}.png`)
    const activeIndex = ref(Math.floor(Math.random() * backgrounds.length))
    const previousIndex = ref(null)
    let timer = null

    const activeBackground = computed(() => backgrounds[activeIndex.value])
    const previousBackground = computed(() => previousIndex.value === null ? '' : backgrounds[previousIndex.value])

    function rotateBackground() {
      previousIndex.value = activeIndex.value
      activeIndex.value = (activeIndex.value + 1) % backgrounds.length
      setTimeout(() => { previousIndex.value = null }, 1300)
    }

    onMounted(() => { timer = setInterval(rotateBackground, 5000) })
    onUnmounted(() => { if (timer) clearInterval(timer) })

    return { activeBackground, previousBackground }
  },
}
</script>
