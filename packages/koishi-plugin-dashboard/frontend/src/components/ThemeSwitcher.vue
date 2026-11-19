<template>
  <dialog ref="dialog" class="theme-modal themed-scrollbar" aria-labelledby="appearance-title" @cancel.prevent="$emit('close')" @click.self="backdropClose">
    <header class="modal-head"><h2 class="modal-title" id="appearance-title">界面风格</h2>
      <button class="icon-btn" type="button" aria-label="关闭主题" @click="$emit('close')">×</button></header>
    <div class="theme-grid">
      <button v-for="item in themes" :key="item.id" type="button" class="theme-card" :class="{active: item.id === current}"
        :aria-pressed="item.id === current" @click="$emit('select', item.id); $emit('close')">
        <span class="theme-sample" aria-hidden="true" :style="{background: item.colors[0], '--sample-panel': item.colors[1], '--sample-ink': item.colors[2], '--sample-accent': item.colors[3]}"><i></i><b><i></i><i></i></b></span>
        <span class="theme-name">{{ item.label }} <small v-if="item.id === current">已选</small></span>
      </button>
    </div>
  </dialog>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { themes } from '../shared/theme'
const props = defineProps<{ visible: boolean; current: string }>()
const emit = defineEmits<{ select: [string]; close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
watch(() => props.visible, open => {
  if (open) {
    dialog.value?.showModal()
    dialog.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
  } else dialog.value?.close()
}, { flush: 'post' })

/** 只在对话框外的遮罩点击时关闭。 */
function backdropClose(event: MouseEvent) {
  const bounds = dialog.value!.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('close')
}
</script>
