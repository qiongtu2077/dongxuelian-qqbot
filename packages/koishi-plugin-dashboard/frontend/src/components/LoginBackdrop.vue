<template>
  <div class="page-backdrop" aria-hidden="true">
    <div
      v-for="layer in layers"
      :key="layer.key"
      class="login-bg"
      :class="{ active: layer.active, ready: layer.loaded }"
      :style="{ backgroundImage: layer.url ? `url(${layer.url})` : 'none' }"
    ></div>
    <div class="login-vignette"></div>
  </div>
</template>

<script>
import { onMounted, onUnmounted, reactive, ref } from 'vue'

export default {
  name: 'LoginBackdrop',
  setup() {
    const base = import.meta.env.BASE_URL || '/dashboard/'
    const backgrounds = Array.from({ length: 6 }, (_, index) => `${base}backgrounds/login-bg-${index + 1}.png`)
    const activeIndex = ref(Math.floor(Math.random() * backgrounds.length))
    const layers = reactive([
      { key: 'a', url: '', active: true, loaded: false },
      { key: 'b', url: '', active: false, loaded: false },
    ])
    let activeLayer = 0
    let timer = null
    let stopped = false
    let failCount = 0

    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = async () => {
          try {
            if (typeof image.decode === 'function') await image.decode()
          } catch {}
          resolve(url)
        }
        image.onerror = reject
        image.src = url
      })
    }

    function preloadAll() {
      backgrounds.forEach(url => loadImage(url).catch(() => {}))
    }

    async function initFirstImage() {
      try {
        await loadImage(backgrounds[activeIndex.value])
        layers[0].url = backgrounds[activeIndex.value]
        layers[0].loaded = true
      } catch {
        for (let i = 1; i < backgrounds.length; i++) {
          const idx = (activeIndex.value + i) % backgrounds.length
          try {
            await loadImage(backgrounds[idx])
            activeIndex.value = idx
            layers[0].url = backgrounds[idx]
            layers[0].loaded = true
            return
          } catch { continue }
        }
      }
    }

    async function rotateBackground() {
      if (failCount >= backgrounds.length) return
      const nextIndex = (activeIndex.value + 1) % backgrounds.length
      const nextUrl = backgrounds[nextIndex]

      try {
        await loadImage(nextUrl)
        failCount = 0
      } catch {
        failCount++
        activeIndex.value = nextIndex
        return
      }
      if (stopped) return

      const nextLayer = activeLayer === 0 ? 1 : 0
      layers[nextLayer].url = nextUrl
      layers[nextLayer].loaded = true
      requestAnimationFrame(() => {
        layers[nextLayer].active = true
        layers[activeLayer].active = false
        activeLayer = nextLayer
        activeIndex.value = nextIndex
      })
    }

    onMounted(() => {
      initFirstImage()
      preloadAll()
      timer = setInterval(rotateBackground, 8000)
    })
    onUnmounted(() => {
      stopped = true
      if (timer) clearInterval(timer)
    })

    return { layers }
  },
}
</script>
