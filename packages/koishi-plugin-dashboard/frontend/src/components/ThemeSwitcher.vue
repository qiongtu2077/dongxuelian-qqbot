<template>
  <div v-if="visible" class="modal-backdrop" @click.self="$emit('close')">
    <div class="theme-modal">
      <div class="modal-head">
        <div>
          <div class="gate-kicker">Appearance</div>
          <h2 class="modal-title">界面风格</h2>
        </div>
        <button class="icon-btn" type="button" aria-label="关闭" @click="$emit('close')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div class="theme-grid">
        <button
          v-for="item in themes"
          :key="item.id"
          type="button"
          :class="['theme-card', { active: item.id === current }]"
          @click="selectTheme(item.id)"
        >
          <span class="theme-swatches">
            <span v-for="color in item.colors" :key="color" :style="{ backgroundColor: color }"></span>
          </span>
          <span class="theme-name">{{ item.label }}</span>
          <span class="theme-desc">{{ item.desc }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'ThemeSwitcher',
  props: {
    visible: { type: Boolean, default: false },
    themes: { type: Array, default: () => [] },
    current: { type: String, default: 'dark-gold' },
  },
  emits: ['select', 'close'],
  setup(props, { emit }) {
    function selectTheme(themeId) {
      emit('select', themeId)
      emit('close')
    }

    return { selectTheme }
  },
}
</script>
