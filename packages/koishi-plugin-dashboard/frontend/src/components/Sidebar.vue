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
  background:
    linear-gradient(90deg, rgba(255, 255, 255, 0.034), rgba(255, 255, 255, 0.012) 52%, rgba(255, 255, 255, 0.004) 100%),
    rgba(255, 255, 255, 0.01);
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  box-shadow:
    7px 0 26px rgba(0, 0, 0, 0.12),
    inset 1px 0 0 rgba(255, 255, 255, 0.09),
    inset -1px 0 0 rgba(255, 255, 255, 0.028);
  backdrop-filter: blur(62px) saturate(1.78) contrast(1.01);
  -webkit-backdrop-filter: blur(62px) saturate(1.78) contrast(1.01);
  transition: width .32s cubic-bezier(.4, 0, .2, 1), height .32s cubic-bezier(.4, 0, .2, 1), border-color .2s, box-shadow .32s ease, background .2s;
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
  inset: -18%;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.023), transparent 30%, rgba(255, 255, 255, 0.008)),
    linear-gradient(90deg, rgba(255, 255, 255, 0.016), transparent 62%);
  opacity: .34;
  filter: blur(22px);
}

.dashboard-sidebar::after {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.014), transparent 18%);
  opacity: .22;
}

.dashboard-sidebar.collapsed {
  bottom: auto;
  width: 64px;
  height: 72px;
  background:
    linear-gradient(150deg, rgba(255, 255, 255, 0.052), rgba(255, 255, 255, 0.014) 54%, rgba(255, 255, 255, 0.006)),
    rgba(255, 255, 255, 0.012);
  border-right-color: rgba(255, 255, 255, 0.07);
  border-bottom: 1px solid rgba(255, 255, 255, 0.058);
  border-bottom-right-radius: 12px;
  box-shadow:
    10px 12px 26px rgba(0, 0, 0, 0.14),
    inset 1px 0 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(52px) saturate(1.52) contrast(1.01);
  -webkit-backdrop-filter: blur(52px) saturate(1.52) contrast(1.01);
}

.sidebar-head {
  min-height: 72px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.062);
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
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(255, 255, 255, 0.018);
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
  border-top: 1px solid rgba(255, 255, 255, 0.058);
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
  border-bottom: 1px solid rgba(255, 255, 255, 0.052);
}

.sidebar-item.active {
  color: var(--text);
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 11%, transparent), transparent 72%);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 48%, transparent);
}

.sidebar-item.active::before {
  content: '';
  position: absolute;
  inset: 4px 2px;
  border-radius: 999px;
  background:
    radial-gradient(80% 150% at 50% 50%, rgba(255, 255, 255, 0.085), rgba(255, 255, 255, 0.026) 46%, transparent 72%),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 9%, transparent), rgba(115, 215, 255, 0.02), transparent 82%);
  opacity: .28;
  transform: scaleX(.92) scaleY(.72);
  filter: blur(7px);
  box-shadow: none;
  transition: opacity .18s ease, transform .24s cubic-bezier(.18, .86, .28, 1), filter .2s ease, box-shadow .16s ease;
}

.sidebar-item.active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  top: 50%;
  height: 18px;
  border-radius: 999px;
  background: radial-gradient(closest-side, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.034) 56%, transparent 78%);
  opacity: 0;
  transform: translateY(-50%) scaleX(.46) scaleY(.45);
  filter: blur(9px);
  pointer-events: none;
  transition: opacity .18s ease, transform .22s cubic-bezier(.18, .9, .22, 1), filter .16s ease;
}

.sidebar-item:not(.active)::before,
.sidebar-item:not(.active)::after {
  content: '';
  position: absolute;
  pointer-events: none;
}

.sidebar-item:not(.active)::before {
  inset: 4px 2px;
  border-radius: 999px;
  background:
    radial-gradient(80% 150% at 50% 50%, rgba(255, 255, 255, 0.085), rgba(255, 255, 255, 0.026) 46%, transparent 72%),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 9%, transparent), rgba(115, 215, 255, 0.02), transparent 82%);
  opacity: 0;
  transform: scaleX(.88) scaleY(.72);
  filter: blur(7px);
  box-shadow: none;
  transition: opacity .18s ease, transform .24s cubic-bezier(.18, .86, .28, 1), filter .2s ease, box-shadow .16s ease;
}

.sidebar-item:not(.active)::after {
  left: 12px;
  right: 12px;
  top: 50%;
  height: 18px;
  border-radius: 999px;
  background: radial-gradient(closest-side, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.034) 56%, transparent 78%);
  opacity: 0;
  transform: translateY(-50%) scaleX(.46) scaleY(.45);
  filter: blur(9px);
  transition: opacity .18s ease, transform .22s cubic-bezier(.18, .9, .22, 1), filter .16s ease;
}

.sidebar-item:hover::before {
  opacity: .44;
  transform: scaleX(1.04) scaleY(.82);
  filter: blur(8px);
}

.sidebar-item:hover::after {
  opacity: .3;
  transform: translateY(-50%) scaleX(.86) scaleY(.62);
}

.sidebar-item:active::before {
  opacity: .9;
  transform: scaleX(1.12) scaleY(.5);
  filter: blur(12px);
  box-shadow:
    inset 0 10px 22px rgba(0, 0, 0, 0.24),
    inset 0 -4px 12px rgba(255, 255, 255, 0.052);
  transition-duration: .08s;
}

.sidebar-item:active::after {
  opacity: .74;
  transform: translateY(-50%) scaleX(1.18) scaleY(.92);
  filter: blur(13px);
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
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  position: relative;
  z-index: 1;
}

.sidebar-action {
  gap: 10px;
}

@media (max-width: 760px) {
  .dashboard-sidebar {
    width: min(57.4vw, 210px);
    box-shadow:
      8px 0 28px rgba(0, 0, 0, 0.18),
      inset 1px 0 0 rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(46px) saturate(1.48) contrast(1.01);
    -webkit-backdrop-filter: blur(46px) saturate(1.48) contrast(1.01);
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
