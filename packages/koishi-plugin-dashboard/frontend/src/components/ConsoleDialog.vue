<template>
    <dialog ref="element" :class="panelClass" :aria-label="label" :role="alert ? 'alertdialog' : undefined"
      @cancel.prevent="$emit('dismiss')" @click.self="outside"><slot /></dialog>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
defineProps<{ label: string; panelClass?: string; alert?: boolean }>()
const emit = defineEmits<{ dismiss: [] }>()
const element = ref<HTMLDialogElement>()
const opener = document.activeElement as HTMLElement | null

/** 在原生顶层打开弹窗，让键盘和读屏始终留在最上层。 */
onMounted(() => { element.value?.showModal() })
onBeforeUnmount(() => {
  element.value?.close()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})

/** 指针必须落在实际面板之外才视为遮罩点击。 */
function outside(event: MouseEvent) {
  const bounds = element.value!.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('dismiss')
}
</script>
