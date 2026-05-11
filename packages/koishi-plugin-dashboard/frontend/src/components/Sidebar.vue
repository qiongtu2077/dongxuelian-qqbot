<template>
  <aside class="dashboard-sidebar" :class="{ collapsed: !expanded }" aria-label="主菜单">
    <div class="sidebar-head">
      <button
        class="sidebar-toggle"
        type="button"
        :aria-label="expanded ? '收起菜单' : '展开菜单'"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click="$emit('toggle')"
      >
        <svg v-if="expanded" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>
      </button>
      <div class="sidebar-brand">
        <strong>LianBoard</strong>
        <span>控制中心</span>
      </div>
    </div>

    <nav v-if="expanded" class="sidebar-nav" aria-label="功能导航">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="sidebar-item"
        :class="{ active: activeTab === tab.id }"
        type="button"
        :title="tab.label"
        :aria-current="activeTab === tab.id ? 'page' : undefined"
        @click="$emit('switch-tab', tab.id)"
      >
        <span class="sidebar-label">{{ tab.label }}</span>
      </button>
    </nav>

    <div v-if="expanded" class="sidebar-foot">
      <button class="sidebar-item sidebar-action" type="button" :title="'界面风格：' + currentThemeLabel" @click="$emit('open-theme')">
        <span class="sidebar-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3 3h-1.5a2 2 0 0 0-1.5 3.32A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14" cy="7" r="1"/><circle cx="16.5" cy="10" r="1"/></svg>
        </span>
        <span class="sidebar-label">主题：{{ currentThemeLabel }}</span>
      </button>
      <button class="sidebar-item sidebar-action" type="button" title="退出登录" @click="$emit('logout')">
        <span class="sidebar-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
        </span>
        <span class="sidebar-label">退出登录</span>
      </button>
    </div>
  </aside>
</template>

<script>
export default {
  name: 'Sidebar',
  props: {
    tabs: { type: Array, required: true },
    activeTab: { type: String, required: true },
    expanded: { type: Boolean, required: true },
    currentThemeLabel: { type: String, required: true },
  },
  emits: ['toggle', 'switch-tab', 'open-theme', 'logout'],
}
</script>

<style scoped>
.dashboard-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: clamp(220px, 17vw, 320px);
  z-index: 12;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--card) 86%, transparent);
  border-right: 1px solid var(--border);
  box-shadow: 10px 0 32px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  transition: width .32s cubic-bezier(.4, 0, .2, 1), height .32s cubic-bezier(.4, 0, .2, 1), border-color .2s, box-shadow .32s ease, background .2s;
  overflow: hidden;
}

.dashboard-sidebar.collapsed {
  bottom: auto;
  width: 64px;
  height: 72px;
  background: transparent;
  border-right-color: transparent;
  border-bottom: 1px solid transparent;
  border-bottom-right-radius: 8px;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.sidebar-head {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 14px;
  border-bottom: 1px solid var(--border);
}

.collapsed .sidebar-head {
  justify-content: center;
  gap: 0;
  padding: 16px 14px;
  border-bottom-color: transparent;
}

.sidebar-toggle,
.sidebar-item {
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--text2);
  cursor: pointer;
  transition: color .2s, border-color .2s, background .2s, transform .18s, box-shadow .2s;
}

.sidebar-toggle {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sidebar-toggle:hover,
.sidebar-item:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--hoverLight);
  transform: translateY(-1px);
}

.sidebar-toggle svg,
.sidebar-item svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sidebar-brand {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: nowrap;
  transition: opacity .22s ease, transform .22s ease;
}

.sidebar-brand strong {
  color: var(--text);
  font-size: 18px;
  line-height: 1.1;
}

.sidebar-brand span {
  color: var(--text3);
  font-size: 12px;
}

.collapsed .sidebar-brand {
  display: none;
  opacity: 0;
  transform: translateX(-8px);
  pointer-events: none;
}

.sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 10px;
  overflow-y: auto;
  overflow-x: hidden;
}

.sidebar-item {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 800;
  text-align: left;
}

.sidebar-item.active {
  color: #11110d;
  border-color: transparent;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 8px 22px var(--shadow);
}

.sidebar-icon {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
}

.sidebar-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity .22s ease, transform .22s ease;
}

.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 10px 16px;
  border-top: 1px solid var(--border);
}

.sidebar-action {
  gap: 10px;
}

@media (max-width: 760px) {
  .dashboard-sidebar {
    width: min(82vw, 300px);
    box-shadow: 12px 0 34px rgba(0, 0, 0, 0.26);
  }
  .dashboard-sidebar.collapsed {
    width: 56px;
    height: 64px;
  }
  .sidebar-head,
  .collapsed .sidebar-head { padding: 14px 10px; }
  .sidebar-nav,
  .sidebar-foot { padding-left: 8px; padding-right: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  .dashboard-sidebar,
  .sidebar-brand,
  .sidebar-label,
  .sidebar-toggle,
  .sidebar-item {
    transition: none;
  }
}
</style>
