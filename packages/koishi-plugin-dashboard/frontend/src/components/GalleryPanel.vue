<template>
  <div class="gallery-panel">
    <div class="card gallery-toolbar">
      <div>
        <h2>莲莲图集</h2>
        <div class="grp-desc">{{ images.length ? `${images.length} 张图片` : '暂无图片' }}</div>
      </div>
      <div class="gallery-actions">
        <div class="segmented gallery-aspect-tabs" role="tablist" aria-label="图片比例">
          <button v-for="item in aspectOptions" :key="item.id" type="button" :class="{ active: aspectMode === item.id }" @click="aspectMode = item.id">{{ item.label }}</button>
        </div>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple style="display:none" @change="onFileChange" />
        <button class="gallery-add" type="button" title="上传图片" aria-label="上传图片" @click="openUpload" :disabled="uploading">+</button>
      </div>
    </div>

    <div v-if="message" class="msg" :class="message.type">{{ message.text }}</div>

    <div v-if="!loading && !images.length" class="card gallery-empty">
      <button class="gallery-empty-add" type="button" title="上传图片" aria-label="上传图片" @click="openUpload" :disabled="uploading">+</button>
      <strong>暂无图片</strong>
    </div>

    <div v-else class="gallery-grid" :style="galleryStyle">
      <article v-for="image in images" :key="image.id" class="gallery-card" @pointermove="moveCard" @pointerleave="resetCard" @pointercancel="resetCard">
        <div class="gallery-card__rotator">
          <div class="gallery-card__front">
            <img :src="image.url" :alt="image.name" loading="lazy" />
            <div class="gallery-card__shine"></div>
            <div class="gallery-card__texture"></div>
            <div class="gallery-card__glare"></div>
            <button class="gallery-delete" type="button" title="删除图片" aria-label="删除图片" @click.stop="removeImage(image)" :disabled="deletingId === image.id">删除</button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<script>
import { computed, inject, onActivated, onMounted, ref } from 'vue'
import { deleteGalleryImage, fetchGalleryImages, uploadGalleryImage } from '../api'

const STOP_THRESHOLD = 0.001
const interactSettings = { stiffness: 0.066, damping: 0.25 }
const returnSettings = { stiffness: 0.01, damping: 0.06 }
const springs = new WeakMap()

function clamp(value, min = 0, max = 100) { return Math.min(Math.max(value, min), max) }
function round(value, precision = 3) { return Number(value.toFixed(precision)) }
function mapRange(value, fromMin, fromMax, toMin, toMax) { return round(toMin + ((value - fromMin) / (fromMax - fromMin)) * (toMax - toMin)) }
function createSpring(initialValue) {
  const axes = Object.keys(initialValue)
  return { axes, current: { ...initialValue }, target: { ...initialValue }, velocity: Object.fromEntries(axes.map(axis => [axis, 0])) }
}
function setSpringTarget(spring, value) { Object.assign(spring.target, value) }
function isCloseToTarget(spring) {
  return spring.axes.every(axis => Math.abs(spring.target[axis] - spring.current[axis]) < STOP_THRESHOLD && Math.abs(spring.velocity[axis]) < STOP_THRESHOLD)
}
function finishSpringAtTarget(spring) {
  spring.current = { ...spring.target }
  spring.axes.forEach(axis => { spring.velocity[axis] = 0 })
}
function getPointerDistanceFromCenter(x, y) { return round(clamp(Math.hypot(x - 50, y - 50) / 50, 0, 1)) }
function getCardState(rotator) {
  let state = springs.get(rotator)
  if (!state) {
    state = {
      rotation: createSpring({ x: 0, y: 0 }),
      pointer: createSpring({ x: 50, y: 50, effectIntensity: 0 }),
      background: createSpring({ x: 50, y: 50 }),
      frameId: null,
      lastTimestamp: 0,
      resetTimer: null,
      settings: interactSettings,
    }
    springs.set(rotator, state)
  }
  return state
}
function applyVisualState(rotator, state) {
  const pointer = state.pointer.current
  const background = state.background.current
  rotator.style.setProperty('--tilt-left-right', `${round(state.rotation.current.x)}deg`)
  rotator.style.setProperty('--tilt-up-down', `${round(state.rotation.current.y)}deg`)
  rotator.style.setProperty('--pointer-x', `${round(pointer.x)}%`)
  rotator.style.setProperty('--pointer-y', `${round(pointer.y)}%`)
  rotator.style.setProperty('--pointer-from-center', getPointerDistanceFromCenter(pointer.x, pointer.y))
  rotator.style.setProperty('--effect-intensity', round(pointer.effectIntensity))
  rotator.style.setProperty('--background-x', `${round(background.x)}%`)
  rotator.style.setProperty('--background-y', `${round(background.y)}%`)
}
function animateCard(rotator, state, timestamp) {
  if (!state.lastTimestamp) state.lastTimestamp = timestamp
  const deltaTime = Math.min((timestamp - state.lastTimestamp) / 16.666, 4)
  state.lastTimestamp = timestamp
  for (const spring of [state.rotation, state.pointer, state.background]) {
    spring.axes.forEach(axis => {
      const distance = spring.target[axis] - spring.current[axis]
      spring.velocity[axis] += distance * state.settings.stiffness * deltaTime
      spring.velocity[axis] *= Math.pow(1 - state.settings.damping, deltaTime)
      spring.current[axis] += spring.velocity[axis] * deltaTime
    })
  }
  if ([state.rotation, state.pointer, state.background].every(isCloseToTarget)) {
    const allSprings = [state.rotation, state.pointer, state.background]
    allSprings.forEach(finishSpringAtTarget)
    applyVisualState(rotator, state)
    state.frameId = null
    state.lastTimestamp = 0
    return
  }
  applyVisualState(rotator, state)
  state.frameId = requestAnimationFrame(next => animateCard(rotator, state, next))
}
function startAnimation(rotator, state) {
  if (state.frameId === null) state.frameId = requestAnimationFrame(timestamp => animateCard(rotator, state, timestamp))
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

export default {
  name: 'GalleryPanel',
  setup() {
    const showAdminDialog = inject('showAdminDialog')
    const images = ref([])
    const loading = ref(false)
    const uploading = ref(false)
    const deletingId = ref('')
    const message = ref(null)
    const fileInput = ref(null)
    const aspectMode = ref('auto')
    const aspectOptions = [
      { id: 'auto', label: '自适应' },
      { id: '16-9', label: '16:9' },
      { id: '4-3', label: '4:3' },
      { id: '9-16', label: '9:16' },
    ]
    const galleryStyle = computed(() => ({ '--gallery-aspect': ({ auto: '1 / 1', '16-9': '16 / 9', '4-3': '4 / 3', '9-16': '9 / 16' })[aspectMode.value] || '1 / 1' }))

    function withAdminRetry(res, retry) {
      if (res?.code !== 'ADMIN_REQUIRED') return false
      if (showAdminDialog) showAdminDialog('管理莲莲图集需要管理员密码', retry)
      return true
    }
    async function loadImages() {
      loading.value = true
      const res = await fetchGalleryImages()
      if (res.ok) images.value = res.data.images || []
      else message.value = { type: 'err', text: res.data?.message || '读取图集失败' }
      loading.value = false
    }
    function openUpload() { fileInput.value?.click() }
    async function uploadFile(file) {
      uploading.value = true
      message.value = null
      try {
        const dataUrl = await fileToDataUrl(file)
        const res = await uploadGalleryImage({ name: file.name, type: file.type, data: dataUrl })
        if (withAdminRetry(res, () => uploadFile(file))) { uploading.value = false; return }
        if (!res.ok) throw new Error(res.data?.message || '上传失败')
        images.value = [res.data.image].concat(images.value)
        message.value = { type: 'ok', text: '图片已加入莲莲图集' }
      } catch (error) {
        message.value = { type: 'err', text: error.message || '上传失败' }
      }
      uploading.value = false
    }
    async function onFileChange(event) {
      const files = Array.from(event.target.files || [])
      event.target.value = ''
      for (const file of files) await uploadFile(file)
    }
    async function removeImage(image) {
      deletingId.value = image.id
      const res = await deleteGalleryImage(image.id)
      if (withAdminRetry(res, () => removeImage(image))) { deletingId.value = ''; return }
      if (res.ok) {
        images.value = images.value.filter(item => item.id !== image.id)
        message.value = { type: 'ok', text: '图片已删除' }
      } else {
        message.value = { type: 'err', text: res.data?.message || '删除失败' }
      }
      deletingId.value = ''
    }
    function moveCard(event) {
      const card = event.currentTarget
      const rotator = card.querySelector('.gallery-card__rotator')
      if (!rotator) return
      const state = getCardState(rotator)
      clearTimeout(state.resetTimer)
      state.resetTimer = null
      state.settings = interactSettings
      const rect = card.getBoundingClientRect()
      const pointer = { x: round(clamp(((event.clientX - rect.left) / rect.width) * 100)), y: round(clamp(((event.clientY - rect.top) / rect.height) * 100)) }
      const center = { x: pointer.x - 50, y: pointer.y - 50 }
      setSpringTarget(state.rotation, { x: round(-(center.x / 4.2)), y: round(center.y / 4.2) })
      setSpringTarget(state.pointer, { x: pointer.x, y: pointer.y, effectIntensity: 1 })
      setSpringTarget(state.background, { x: mapRange(pointer.x, 0, 100, 37, 63), y: mapRange(pointer.y, 0, 100, 33, 67) })
      startAnimation(rotator, state)
    }
    function resetCard(event) {
      const rotator = event.currentTarget.querySelector('.gallery-card__rotator')
      if (!rotator) return
      const state = getCardState(rotator)
      clearTimeout(state.resetTimer)
      state.resetTimer = setTimeout(() => {
        state.settings = returnSettings
        setSpringTarget(state.rotation, { x: 0, y: 0 })
        setSpringTarget(state.pointer, { x: 50, y: 50, effectIntensity: 0 })
        setSpringTarget(state.background, { x: 50, y: 50 })
        state.resetTimer = null
        startAnimation(rotator, state)
      }, 360)
    }

    onMounted(loadImages)
    onActivated(loadImages)
    return { images, loading, uploading, deletingId, message, fileInput, aspectMode, aspectOptions, galleryStyle, openUpload, onFileChange, removeImage, moveCard, resetCard }
  },
}
</script>
