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
        <button class="gallery-remove-toggle" type="button" title="批量删除" aria-label="批量删除" :class="{ active: bulkDeleteMode }" @click="toggleBulkDelete">-</button>
      </div>
    </div>

    <div v-if="bulkDeleteMode" class="gallery-bulk-bar">
      <span>{{ selectedCount ? `已选择 ${selectedCount} 张` : '点击图片选择要删除的项目' }}</span>
      <div>
        <button class="btn btn-sm btn-ghost" type="button" @click="clearSelection">取消</button>
        <button class="btn btn-sm btn-danger" type="button" @click="deleteSelectedImages" :disabled="!selectedCount || deletingId === 'bulk'">{{ deletingId === 'bulk' ? '删除中...' : '删除选中' }}</button>
      </div>
    </div>

    <div v-if="message" class="msg" :class="message.type">{{ message.text }}</div>

    <div v-if="!loading && !images.length" class="card gallery-empty">
      <button class="gallery-empty-add" type="button" title="上传图片" aria-label="上传图片" @click="openUpload" :disabled="uploading">+</button>
      <strong>暂无图片</strong>
    </div>

    <div v-else class="gallery-grid" :style="galleryStyle">
      <article v-for="(image, index) in images" :key="image.id" :class="['gallery-card', { 'is-bulk': bulkDeleteMode, selected: isSelected(image.id) }]" @click="onCardClick(image, index)" @pointermove="moveCard" @pointerleave="resetCard" @pointercancel="resetCard">
        <div class="gallery-card__rotator">
          <div class="gallery-card__front">
            <img :src="image.url" :alt="image.name" loading="lazy" />
            <div class="gallery-card__shine"></div>
            <div class="gallery-card__texture"></div>
            <div class="gallery-card__glare"></div>
            <span v-if="bulkDeleteMode" class="gallery-select-mark" aria-hidden="true">{{ isSelected(image.id) ? '✓' : '' }}</span>
          </div>
        </div>
      </article>
    </div>

    <div v-if="previewImage" class="gallery-preview-backdrop" @click.self="closePreview" @contextmenu.prevent="closePreview">
      <section class="gallery-preview-shell" aria-label="图片预览" @contextmenu.prevent="closePreview">
        <button class="gallery-preview-close" type="button" aria-label="关闭预览" title="关闭预览" @click="closePreview">×</button>
        <article ref="previewCardRef" class="gallery-preview-card gallery-card" @pointerdown="previewPointerDown" @pointermove="previewPointerMove" @pointerup="previewPointerUp" @pointercancel="previewPointerUp" @pointerleave="previewPointerUp">
          <div class="gallery-card__rotator">
            <div class="gallery-card__front">
              <img :src="previewImage.url" :alt="previewImage.name" />
              <div class="gallery-card__shine"></div>
              <div class="gallery-card__texture"></div>
              <div class="gallery-card__glare"></div>
            </div>
          </div>
        </article>
      </section>
    </div>
  </div>
</template>

<script>
import { computed, inject, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
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
function applyPointerToCard(event, card, divisor = 4.2) {
  const rotator = card.querySelector('.gallery-card__rotator')
  if (!rotator) return
  const state = getCardState(rotator)
  clearTimeout(state.resetTimer)
  state.resetTimer = null
  state.settings = interactSettings
  const rect = card.getBoundingClientRect()
  const pointer = { x: round(clamp(((event.clientX - rect.left) / rect.width) * 100)), y: round(clamp(((event.clientY - rect.top) / rect.height) * 100)) }
  const center = { x: pointer.x - 50, y: pointer.y - 50 }
  setSpringTarget(state.rotation, { x: round(-(center.x / divisor)), y: round(center.y / divisor) })
  setSpringTarget(state.pointer, { x: pointer.x, y: pointer.y, effectIntensity: 1 })
  setSpringTarget(state.background, { x: mapRange(pointer.x, 0, 100, 37, 63), y: mapRange(pointer.y, 0, 100, 33, 67) })
  startAnimation(rotator, state)
}
function resetCardTarget(card, delay = 360) {
  const rotator = card.querySelector('.gallery-card__rotator')
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
  }, delay)
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
    const bulkDeleteMode = ref(false)
    const selectedIds = ref(new Set())
    const previewIndex = ref(-1)
    const previewCardRef = ref(null)
    const previewDragging = ref(false)
    const aspectOptions = [
      { id: 'auto', label: '自适应' },
      { id: '16-9', label: '16:9' },
      { id: '4-3', label: '4:3' },
      { id: '9-16', label: '9:16' },
    ]
    const galleryStyle = computed(() => ({ '--gallery-aspect': ({ auto: '1 / 1', '16-9': '16 / 9', '4-3': '4 / 3', '9-16': '9 / 16' })[aspectMode.value] || '1 / 1' }))
    const selectedCount = computed(() => selectedIds.value.size)
    const previewImage = computed(() => images.value[previewIndex.value] || null)

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
    function toggleBulkDelete() {
      bulkDeleteMode.value = !bulkDeleteMode.value
      selectedIds.value = new Set()
      if (bulkDeleteMode.value) closePreview()
    }
    function isSelected(id) { return selectedIds.value.has(id) }
    function toggleSelected(id) {
      const next = new Set(selectedIds.value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      selectedIds.value = next
    }
    function clearSelection() {
      bulkDeleteMode.value = false
      selectedIds.value = new Set()
    }
    async function deleteSelectedImages() {
      const ids = Array.from(selectedIds.value)
      if (!ids.length) return
      if (!window.confirm(`确定删除选中的 ${ids.length} 张图片吗？`)) return
      deletingId.value = 'bulk'
      const res = await deleteGalleryImage(ids)
      if (withAdminRetry(res, deleteSelectedImages)) { deletingId.value = ''; return }
      const deletedIds = new Set((res.data?.deleted || []).map(item => item.id))
      if (deletedIds.size) images.value = images.value.filter(item => !deletedIds.has(item.id))
      if (res.ok) {
        selectedIds.value = new Set()
        bulkDeleteMode.value = false
        message.value = { type: 'ok', text: res.data?.message || `已删除 ${deletedIds.size} 张图片` }
      } else {
        message.value = { type: 'err', text: res.data?.message || '批量删除失败' }
      }
      deletingId.value = ''
    }
    function openPreview(index) { previewIndex.value = index }
    function closePreview() {
      if (previewCardRef.value) resetCardTarget(previewCardRef.value, 0)
      previewIndex.value = -1
      previewDragging.value = false
    }
    function onCardClick(image, index) {
      if (bulkDeleteMode.value) { toggleSelected(image.id); return }
      openPreview(index)
    }
    function moveCard(event) {
      if (bulkDeleteMode.value) return
      applyPointerToCard(event, event.currentTarget, 4.2)
    }
    function resetCard(event) { resetCardTarget(event.currentTarget) }
    function previewPointerDown(event) {
      if (event.button !== 0) return
      previewDragging.value = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
      applyPointerToCard(event, event.currentTarget, 7)
    }
    function previewPointerMove(event) {
      if (!previewDragging.value) return
      applyPointerToCard(event, event.currentTarget, 7)
    }
    function previewPointerUp(event) {
      if (!previewDragging.value) return
      previewDragging.value = false
      try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {}
      resetCardTarget(event.currentTarget, 220)
    }
    function onKeydown(event) {
      if (event.key === 'Escape' && previewImage.value) closePreview()
    }

    onMounted(() => { loadImages(); window.addEventListener('keydown', onKeydown) })
    onActivated(loadImages)
    onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
    return { images, loading, uploading, deletingId, message, fileInput, aspectMode, aspectOptions, galleryStyle, bulkDeleteMode, selectedCount, previewImage, previewCardRef, openUpload, onFileChange, toggleBulkDelete, isSelected, clearSelection, deleteSelectedImages, onCardClick, closePreview, moveCard, resetCard, previewPointerDown, previewPointerMove, previewPointerUp }
  },
}
</script>