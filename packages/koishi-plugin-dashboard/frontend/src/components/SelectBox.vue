<template>
  <div class="sb-wrap" ref="wrapRef" tabindex="0" @blur="close">
    <div class="sb-trigger" @click="toggle">
      <span :style="{color: selected ? 'var(--text)' : 'var(--text3)'}">{{ selected || placeholder }}</span>
      <svg class="sb-arrow" :class="{ open: open }" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <Transition name="sb">
      <div v-if="open" class="sb-menu">
        <div v-for="o in options" :key="o.value"
          class="sb-opt"
          :class="{ active: o.value === modelValue }"
          @mousedown.prevent
          @click="pick(o.value)">{{ o.label }}</div>
      </div>
    </Transition>
  </div>
</template>

<script>
import { ref, computed } from 'vue'

export default {
  name: 'SelectBox',
  props: {
    modelValue: [String, Number],
    options: { type: Array, default: () => [] },
    placeholder: { type: String, default: '请选择' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const open = ref(false)
    const wrapRef = ref(null)
    const selected = computed(() => {
      const o = props.options.find(o => o.value === props.modelValue)
      return o ? o.label : ''
    })
    function toggle() { open.value = !open.value }
    function close() { open.value = false }
    function pick(value) {
      emit('update:modelValue', value)
      open.value = false
    }
    return { open, wrapRef, selected, toggle, close, pick }
  }
}
</script>

<style scoped>
.sb-wrap {
  position: relative;
  user-select: none; outline: none;
  flex: 1;
}
.sb-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: var(--input); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; font-size: 14px; cursor: pointer;
  transition: border-color .2s, box-shadow .2s;
}
.sb-wrap:focus-within .sb-trigger { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(57,197,187,0.15) }
.sb-arrow { flex-shrink: 0; transition: transform .2s ease; color: var(--text3) }
.sb-arrow.open { transform: rotate(180deg) }
.sb-menu {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 100;
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  padding: 4px; max-height: 260px; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
.sb-opt {
  padding: 8px 12px; font-size: 14px; border-radius: 6px; cursor: pointer;
  transition: background .15s, color .15s;
  color: var(--text2);
}
.sb-opt:hover { background: var(--hover) }
.sb-opt.active { color: var(--text); background: var(--accentDim); font-weight: 600 }
.sb-enter-active { transition: opacity .15s ease, transform .12s ease }
.sb-leave-active { transition: opacity .1s ease, transform .1s ease }
.sb-enter-from { opacity: 0; transform: translateY(-6px) }
.sb-leave-to { opacity: 0; transform: translateY(-4px) }
</style>
