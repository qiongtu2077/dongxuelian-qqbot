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
        <button class="gallery-remove-toggle" type="button" title="批量删除" aria-label="批量删除" :class="{ active: bulkDeleteMode }" @click="toggleBulkDelete">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/><path d="M10 10v7"/><path d="M14 10v7"/></svg>
        </button>
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
      <article v-for="(image, index) in images" :key="image.id" :class="['gallery-card', foilCardClass(image), { 'is-bulk': bulkDeleteMode, selected: isSelected(image.id) }]" @click="onCardClick(image, index)" @pointermove="moveCard" @pointerleave="resetCard" @pointercancel="resetCard">
        <div class="gallery-card__rotator">
          <div class="gallery-card__front">
            <img :src="image.url" :alt="image.name" loading="lazy" @error="onImageError(image)" />
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
        <div class="gallery-preview-stage">
          <article ref="previewCardRef" :class="['gallery-preview-card', 'gallery-card', foilCardClass(previewImage)]" @pointermove="previewPointerMove" @pointercancel="previewPointerLeave" @pointerleave="previewPointerLeave">
            <div class="gallery-card__rotator">
              <div class="gallery-card__front">
                <img :src="previewImage.url" :alt="previewImage.name" @error="onImageError(previewImage)" />
                <div class="gallery-card__shine"></div>
                <div class="gallery-card__texture"></div>
                <div class="gallery-card__glare"></div>
              </div>
            </div>
          </article>
          <aside class="gallery-foil-picker" aria-label="闪卡样式">
            <button v-for="option in foilOptions" :key="option.id" type="button" :class="{ active: currentFoilStyle === option.value }" :disabled="updatingStyle" :title="option.title" @click="setPreviewFoilStyle(option.value)">{{ option.label }}</button>
          </aside>
        </div>
      </section>
    </div>
  </div>
</template>

<script>
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { deleteGalleryImage, fetchGalleryImages, updateGalleryImageStyle, uploadGalleryImage } from '../api'

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

function preloadGalleryImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(true)
    image.onerror = () => reject(new Error('图片已上传，但浏览器无法读取图片文件'))
    image.src = url
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
    const updatingStyle = ref(false)
    const aspectOptions = [
      { id: 'auto', label: '自适应' },
      { id: '16-9', label: '16:9' },
      { id: '4-3', label: '4:3' },
      { id: '9-16', label: '9:16' },
    ]
    const foilOptions = [
      { id: 'none', value: null, label: '无', title: '无闪卡样式' },
      ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(id => ({ id, value: id, label: id, title: `闪卡样式 ${id}` })),
    ]
    const galleryStyle = computed(() => ({ '--gallery-aspect': ({ auto: '1 / 1', '16-9': '16 / 9', '4-3': '4 / 3', '9-16': '9 / 16' })[aspectMode.value] || '1 / 1' }))
    const selectedCount = computed(() => selectedIds.value.size)
    const previewImage = computed(() => images.value[previewIndex.value] || null)
    const currentFoilStyle = computed(() => previewImage.value?.foilStyle || null)

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
        if (!res.ok) throw new Error(res.data?.message || '上传失败')
        const image = res.data.image
        await preloadGalleryImage(image.url)
        images.value = [image].concat(images.value)
        message.value = { type: 'ok', text: '图片已加入莲莲图集' }
      } catch (error) {
        message.value = { type: 'err', text: error.message || '上传失败' }
        await loadImages()
      }
      uploading.value = false
    }
    function onImageError(image) {
      if (!image?.name) return
      message.value = { type: 'err', text: `图片无法显示：${image.name}` }
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
    }
    function foilCardClass(image) { return image?.foilStyle ? `gallery-card--foil-${String(image.foilStyle).toLowerCase()}` : '' }
    function replaceImage(updated) {
      images.value = images.value.map(item => item.id === updated.id ? { ...item, ...updated } : item)
    }
    async function setPreviewFoilStyle(foilStyle) {
      const image = previewImage.value
      if (!image || updatingStyle.value || image.foilStyle === foilStyle) return
      const previous = image.foilStyle || null
      replaceImage({ ...image, foilStyle })
      updatingStyle.value = true
      const res = await updateGalleryImageStyle(image.id, foilStyle)
      if (withAdminRetry(res, () => setPreviewFoilStyle(foilStyle))) { replaceImage({ ...image, foilStyle: previous }); updatingStyle.value = false; return }
      if (res.ok) replaceImage(res.data.image || { ...image, foilStyle })
      else {
        replaceImage({ ...image, foilStyle: previous })
        message.value = { type: 'err', text: res.data?.message || '保存闪卡样式失败' }
      }
      updatingStyle.value = false
    }
    function onCardClick(image, index) {
      if (bulkDeleteMode.value) { toggleSelected(image.id); return }
      openPreview(index)
    }
    function moveCard(event) {
      if (bulkDeleteMode.value) return
      applyPointerToCard(event, event.currentTarget, 3.5)
    }
    function resetCard(event) { resetCardTarget(event.currentTarget) }
    function previewPointerMove(event) {
      applyPointerToCard(event, event.currentTarget, 3.1)
    }
    function previewPointerLeave(event) {
      resetCardTarget(event.currentTarget, 500)
    }
    function onKeydown(event) {
      if (event.key === 'Escape' && previewImage.value) closePreview()
    }

    onMounted(() => { loadImages(); window.addEventListener('keydown', onKeydown) })
    onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
    return { images, loading, uploading, deletingId, message, fileInput, aspectMode, aspectOptions, galleryStyle, bulkDeleteMode, selectedCount, previewImage, previewCardRef, foilOptions, currentFoilStyle, updatingStyle, foilCardClass, setPreviewFoilStyle, openUpload, onFileChange, onImageError, toggleBulkDelete, isSelected, clearSelection, deleteSelectedImages, onCardClick, closePreview, moveCard, resetCard, previewPointerMove, previewPointerLeave }
  },
}
</script>