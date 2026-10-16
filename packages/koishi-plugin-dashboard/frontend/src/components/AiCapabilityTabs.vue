<template>
  <nav class="ability-tabs" :aria-label="label">
    <button v-for="tab in tabs" :key="tab.id" type="button" :class="{ active: modelValue === tab.id }" :aria-pressed="modelValue === tab.id" @click="$emit('update:modelValue', tab.id)">{{ tab.label }}</button>
  </nav>
</template>
<script setup lang="ts">
import type { AiCapability } from '../services/ai-model-api-model'
defineProps<{ modelValue: AiCapability; label: string }>()
defineEmits<{ 'update:modelValue': [value: AiCapability] }>()
const tabs: Array<{ id: AiCapability; label: string }> = [{ id: 'text', label: '文字' }, { id: 'vision', label: '识图' }, { id: 'voice-asr', label: '语音识别' }, { id: 'voice-tts', label: '语音合成' }]
</script>
<style scoped>
.ability-tabs { display: flex; flex-wrap: wrap; gap: 5px; padding: 5px; margin: 16px 0 20px; width: fit-content; border: 1px solid var(--border); border-radius: 10px; background: var(--input); }
button { padding: 9px 18px; min-height: 40px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text3); font: inherit; font-size: 13px; font-weight: 750; cursor: pointer; }
button.active { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accentDim); color: var(--accent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media(max-width:540px) { .ability-tabs { width: 100%; display: grid; grid-template-columns: repeat(2,1fr); } button { padding: 9px; } }
</style>
