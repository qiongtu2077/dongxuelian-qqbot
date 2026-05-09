<template>
  <div class="password-field">
    <input
      :value="modelValue"
      :type="visible ? 'text' : 'password'"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :autofocus="autofocus"
      @input="$emit('update:modelValue', $event.target.value)"
      @keyup.enter="$emit('enter')"
    />
    <button class="icon-btn password-eye" type="button" :aria-label="visible ? '隐藏密码' : '显示密码'" @click="visible = !visible">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="3" />
        <path v-if="!visible" d="M4 20 20 4" class="eye-slash" />
      </svg>
    </button>
  </div>
</template>

<script>
import { ref } from 'vue'

export default {
  name: 'PasswordField',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    autocomplete: { type: String, default: 'current-password' },
    autofocus: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'enter'],
  setup() {
    const visible = ref(false)
    return { visible }
  },
}
</script>
