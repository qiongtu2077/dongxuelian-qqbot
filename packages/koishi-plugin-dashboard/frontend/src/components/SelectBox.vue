<template>
  <div class="sb-wrap" :class="{ disabled }" tabindex="0" @blur="close" @keydown="onKeydown">
    <button class="sb-trigger" type="button" :disabled="disabled" @click="toggle">
      <span :class="{ placeholder: !selectedLabel }">{{ selectedLabel || placeholder }}</span>
      <svg class="sb-arrow" :class="{ open }" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Transition name="sb">
      <div v-if="open" class="sb-menu themed-scrollbar" role="listbox">
        <button
          v-for="option in normalizedOptions"
          :key="String(option.value)"
          class="sb-opt"
          :class="{ active: option.value === modelValue }"
          type="button"
          :disabled="option.disabled"
          @mousedown.prevent
          @click="pick(option)"
        >
          {{ option.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<script lang="ts">
import { computed, ref } from 'vue'
import type { PropType } from 'vue'
import type { SelectOption, SelectValue } from '../types'
import { isRecord } from '../types'

export default {
  name: 'SelectBox',
  props: {
    modelValue: { type: [String, Number, Boolean] as PropType<SelectValue>, default: null },
    options: { type: Array as PropType<Array<SelectOption | SelectValue>>, default: () => [] },
    placeholder: { type: String, default: '请选择' },
    disabled: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const open = ref(false)
    const normalizedOptions = computed<SelectOption[]>(() => props.options.map(option => {
      if (isRecord(option)) {
        return {
          value: option.value as SelectValue,
          label: String(option.label ?? option.value ?? ''),
          disabled: !!option.disabled,
        }
      }
      const value = option as SelectValue
      return { value, label: String(value), disabled: false }
    }))
    const selectedLabel = computed(() => normalizedOptions.value.find(option => option.value === props.modelValue)?.label || '')

    function toggle() {
      if (!props.disabled) open.value = !open.value
    }

    function close() {
      open.value = false
    }

    function pick(option: SelectOption) {
      if (option.disabled) return
      emit('update:modelValue', option.value)
      emit('change', option.value)
      close()
    }

    function onKeydown(event: KeyboardEvent) {
      if (props.disabled) return
      if (event.key === 'Escape') close()
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    }

    return { open, normalizedOptions, selectedLabel, toggle, close, pick, onKeydown }
  },
}
</script>

<style scoped>
.sb-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  width: 100%;
  outline: none;
  user-select: none;
}

.sb-wrap.disabled { opacity: .6; }

.sb-trigger { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; min-height:38px; padding:8px 11px; border:1px solid var(--control-border); border-radius:var(--radius-md); background:var(--input); color:var(--text); font:inherit; text-align:left; cursor:pointer; }
.sb-trigger:hover,.sb-wrap:focus-within .sb-trigger { border-color:var(--focus); outline:2px solid var(--focus); outline-offset:1px; }
.sb-trigger:disabled { cursor: not-allowed; }
.sb-trigger span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-trigger .placeholder { color: var(--text3); }

.sb-arrow {
  flex: 0 0 auto;
  color: var(--text2);
  transition: transform .18s ease, color .18s ease;
}

.sb-arrow.open {
  color: var(--accent);
  transform: rotate(180deg);
}

.sb-menu { position:absolute; top:calc(100% + 5px); inset-inline:0; z-index:1000; display:grid; gap:3px; padding:5px; max-height:280px; overflow-y:auto; border:1px solid var(--control-border); border-radius:9px; background:var(--card); box-shadow:0 12px 28px var(--shadow); }
.sb-opt {
  display: block;
  width: 100%;
  min-height: 34px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text2);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background .14s, border-color .14s, color .14s, transform .14s;
}

.sb-opt:hover,
.sb-opt.active {
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, transparent), color-mix(in srgb, var(--accent2) 10%, transparent)),
    var(--hover);
  color: var(--text);
}

.sb-opt.active {
  font-weight: 800;
  box-shadow: inset 3px 0 0 var(--accent);
}

.sb-opt:disabled {
  color: var(--text3);
  cursor: not-allowed;
  opacity: .55;
}

.sb-enter-active { transition: opacity .14s ease, transform .14s ease; }
.sb-leave-active { transition: opacity .1s ease, transform .1s ease; }
.sb-enter-from,
.sb-leave-to { opacity: 0; transform: translateY(-6px) scale(.98); }
</style>
