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
  width: var(--dashboard-sidebar-width, clamp(154px, 11.9vw, 224px));
  z-index: 12;
  display: flex;
  flex-direction: column;
  isolation: isolate;
  background: transparent;
  border-right: 1px solid color-mix(in srgb, var(--border) 58%, rgba(255,255,255,0.08));
  box-shadow:
    0 20px 70px rgba(0, 0, 0, 0.1),
    inset 1px 0 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px) saturate(1.4) contrast(1.05);
  -webkit-backdrop-filter: blur(8px) saturate(1.4) contrast(1.05);
  transition: width 0.32s cubic-bezier(0.4, 0, 0.2, 1), height 0.32s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s, box-shadow 0.32s ease, background 0.2s;
  overflow: hidden;
}

.dashboard-sidebar::before,
.dashboard-sidebar::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

.dashboard-sidebar::before {
  inset: -1px;
  background:
    linear-gradient(105deg, rgba(255,255,255,0.03), rgba(255,255,255,0.002) 48%, color-mix(in srgb, var(--accent) 4%, transparent)),
    color-mix(in srgb, var(--card) 5%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--border) 48%, rgba(255,255,255,0.06));
  filter: none;
  opacity: 1;
  animation: none;
}

.dashboard-sidebar::after {
  content: none;
}

.dashboard-sidebar.collapsed {
  bottom: auto;
  width: 64px;
  height: 72px;
  background: transparent;
  border-right-color: color-mix(in srgb, var(--border) 58%, rgba(255,255,255,0.08));
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, rgba(255,255,255,0.06));
  border-bottom-right-radius: 12px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.1),
    inset 1px 0 0 rgba(255, 255, 255, 0.09);
  backdrop-filter: blur(8px) saturate(1.4) contrast(1.05);
  -webkit-backdrop-filter: blur(8px) saturate(1.4) contrast(1.05);
}

.sidebar-head {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 44%, rgba(255,255,255,0.06));
  position: relative;
  z-index: 1;
}

.collapsed .sidebar-head {
  justify-content: center;
  gap: 0;
  padding: 16px 14px;
  border-bottom-color: transparent;
}

.sidebar-toggle {
  border: 1px solid color-mix(in srgb, var(--border) 52%, rgba(255,255,255,0.08));
  background: color-mix(in srgb, var(--input) 18%, transparent);
  color: var(--text2);
  cursor: pointer;
  transition: color .18s, background .18s, transform .14s cubic-bezier(.2, .8, .2, 1), box-shadow .18s;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.sidebar-item {
  border: 0;
  background: transparent;
  color: var(--text2);
  cursor: pointer;
  transition: color .18s ease, transform .18s cubic-bezier(.15, .86, .26, 1), background .16s ease, box-shadow .16s ease;
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

.sidebar-toggle:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}

.sidebar-toggle:active {
  transform: scale(.94);
  background: rgba(255, 255, 255, 0.02);
  box-shadow:
    inset 0 3px 10px rgba(0, 0, 0, 0.2),
    inset 0 -1px 0 rgba(255, 255, 255, 0.06);
}

.sidebar-item:hover {
  color: var(--text);
}

.sidebar-item:active {
  color: var(--text);
  transform: translateY(2px) scaleX(.982) scaleY(.94);
  background: rgba(255, 255, 255, 0.014);
  box-shadow:
    inset 0 9px 22px rgba(0, 0, 0, 0.18),
    inset 0 -2px 0 rgba(255, 255, 255, 0.04);
  transition-duration: .06s;
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
  flex: 1;
  white-space: nowrap;
  text-align: center;
  font-family: KaiTi, STKaiti, '楷体', serif;
  transition: opacity .22s ease, transform .22s ease;
  position: relative;
  z-index: 1;
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
  gap: 0;
  padding: 14px 10px;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  z-index: 1;
}

.sidebar-item {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 8px 10px;
  border-top: 1px solid color-mix(in srgb, var(--border) 40%, rgba(255,255,255,0.06));
  border-radius: 0;
  font-size: 14px;
  font-weight: 700;
  text-align: center;
  font-family: KaiTi, STKaiti, '楷体', serif;
  position: relative;
  overflow: hidden;
}

.sidebar-nav .sidebar-item:last-child,
.sidebar-foot .sidebar-item:last-child {
  border-bottom: 1px solid color-mix(in srgb, var(--border) 38%, rgba(255,255,255,0.05));
}

.sidebar-item.active {
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 34%, transparent), inset 0 1px 0 rgba(255,255,255,0.08);
}

.sidebar-item.active::before {
  content: none;
}

.sidebar-item.active::after {
  content: none;
}

.sidebar-item:not(.active)::before,
.sidebar-item:not(.active)::after {
  content: none;
  pointer-events: none;
}

.sidebar-item:not(.active)::before {
  content: '';
  inset: 4px 2px;
  border-radius: 999px;
  background:
    radial-gradient(80% 150% at 50% 50%, rgba(255, 255, 255, 0.085), rgba(255, 255, 255, 0.026) 46%, transparent 72%),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 9%, transparent), rgba(115, 215, 255, 0.02), transparent 82%);
  opacity: 0;
  transform: scaleX(.88) scaleY(.72);
  filter: none;
  box-shadow: none;
  transition: opacity .14s ease, transform .16s ease;
}

.sidebar-item:hover::before {
  opacity: .44;
  transform: scaleX(1.04) scaleY(.82);
  filter: none;
}

.sidebar-item:active::before {
  opacity: .9;
  transform: scaleX(1.12) scaleY(.5);
  filter: none;
  box-shadow:
    inset 0 10px 22px rgba(0, 0, 0, 0.24),
    inset 0 -4px 12px rgba(255, 255, 255, 0.052);
  transition-duration: .08s;
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
  position: relative;
  z-index: 1;
  transition: transform .16s cubic-bezier(.18, .86, .28, 1);
}

.sidebar-label {
  min-width: 0;
  width: 100%;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity .22s ease, transform .16s cubic-bezier(.18, .86, .28, 1);
  position: relative;
  z-index: 1;
}

.sidebar-item:active .sidebar-label,
.sidebar-item:active .sidebar-icon {
  transform: translateY(2px) scale(.97);
}

.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 12px 10px 16px;
  border-top: 1px solid color-mix(in srgb, var(--border) 44%, rgba(255,255,255,0.06));
  position: relative;
  z-index: 1;
}

.sidebar-action {
  gap: 10px;
}

@keyframes waterRipple {
  0% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.3; }
  25% { transform: translate3d(8px, -4px, 0) scale(1.02); opacity: 0.4; }
  50% { transform: translate3d(-4px, 6px, 0) scale(0.98); opacity: 0.35; }
  75% { transform: translate3d(6px, -2px, 0) scale(1.01); opacity: 0.38; }
  100% { transform: translate3d(-2px, 0, 0) scale(1); opacity: 0.3; }
}

@media (max-width: 760px) {
  .dashboard-sidebar {
    width: min(57.4vw, 210px);
    box-shadow:
      0 14px 36px rgba(0, 0, 0, 0.08),
      inset 1px 0 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(4px) saturate(1.2);
    -webkit-backdrop-filter: blur(4px) saturate(1.2);
    transition: transform 0.2s ease, border-color 0.18s ease, box-shadow 0.18s ease;
  }
  .dashboard-sidebar::before,
  .dashboard-sidebar::after {
    content: none;
  }
  .dashboard-sidebar.collapsed {
    width: 56px;
    height: 64px;
  }
  .sidebar-item::before,
  .sidebar-item::after {
    content: none !important;
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
