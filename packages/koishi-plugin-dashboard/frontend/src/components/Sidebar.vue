<template>
  <aside ref="sidebar" :data-mobile="mobile ? true : undefined" class="dashboard-sidebar" :class="{collapsed: !expanded, 'mobile-open': mobile && expanded}"
    aria-label="主菜单" :role="mobile && expanded ? 'dialog' : undefined" :aria-modal="mobile && expanded || undefined" @keydown="handleKeys">
    <div class="sidebar-head">
      <span class="brand-mark" aria-hidden="true">莲</span>
      <div class="sidebar-brand"><strong>LianBoard</strong><span>控制台</span></div>
      <button class="sidebar-toggle" type="button" :aria-label="expanded ? '收起菜单' : '展开菜单'"
        :aria-expanded="expanded" aria-controls="dashboard-nav" @click="$emit('toggle')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="expanded" d="m14 6-6 6 6 6"/><path v-else d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
    </div>
    <nav v-if="expanded || !mobile" id="dashboard-nav" class="sidebar-nav themed-scrollbar" aria-label="功能导航">
      <button v-for="tab in tabs" :key="tab.id" type="button" class="sidebar-item" :class="{active: activeTab === tab.id}"
        :title="tab.label" :aria-label="tab.label" :aria-current="activeTab === tab.id ? 'page' : undefined" @click="$emit('switch-tab', tab.id)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[tab.id]"/></svg>
        <span class="sidebar-label">{{ tab.label }}</span>
      </button>
    </nav>
    <div v-if="expanded || !mobile" class="sidebar-foot">
      <button class="sidebar-item sidebar-action" type="button" :title="'界面风格：' + currentThemeLabel" aria-haspopup="dialog" @click="$emit('open-theme')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.5c-1-1 .2-3.5 2-3.5h2c2 0 3-2 3-3a9 9 0 0 0-9-8Z M7 11h.01M10 7h.01M15 7h.01M18 10h.01"/></svg>
        <span class="sidebar-label">主题：{{ currentThemeLabel }}</span>
      </button>
      <button v-if="!suppressLogout" class="sidebar-item sidebar-action" type="button" title="退出登录" @click="$emit('logout')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5m0-8h11m-4-4 4 4-4 4"/></svg><span class="sidebar-label">退出登录</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { DashboardTab } from '../types'
const props = defineProps<{ tabs: DashboardTab[]; activeTab: string; expanded: boolean; mobile: boolean; suppressLogout: boolean; currentThemeLabel: string }>()
const emit = defineEmits<{ toggle: []; 'switch-tab': [id: string]; 'open-theme': []; logout: [] }>()
const sidebar = ref<HTMLElement>()
const icons: Record<string, string> = {
  deploy: 'm4 14 5-1 8-9 4-1-1 5-8 8-1 5-3-4-4-3Z M4 20l3-3',
  control: 'M3 5h18v14H3z M7 9l3 3-3 3m6 0h4',
  'ai-model-api': 'M6 6h12v12H6z M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',
  persona: 'M16 20v-2c0-5-11-5-11 0v2 M14 8a4 4 0 1 1-8 0 4 4 0 1 1 8 0 M19 6v6m-3-3h6',
  features: 'M3 6c4-2 7-1 9 1 3-2 6-3 9-1v13c-3-1-6-1-9 2-3-3-6-3-9-2Zm9 1v14',
  whitelist: 'M8 6h13M8 12h13M8 18h13M3 6h1m-1 6h1m-1 6h1',
  settings: 'm12 3 7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6Zm-3 9 2 2 4-4',
  agent: 'M12 3c1 5 4 8 9 9-5 1-8 4-9 9-1-5-4-8-9-9 5-1 8-4 9-9Z',
  resource: 'M4 3v17h17M8 15l4-5 3 2 5-7',
  logs: 'M6 3h8l4 4v14H6z M14 3v5h4M9 12h6m-6 4h6',
  gallery: 'M3 4h18v16H3z M4 17l5-5 3 3 4-6 5 7 M7 8h1'
}

/** 手机抽屉开启后将焦点交给其关闭按钮。 */
watch(() => props.expanded && props.mobile, open => {
  if (open) sidebar.value?.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus()
}, { flush: 'post' })

/** 键盘循环停留在已展开的移动导航内。 */
function handleKeys(event: KeyboardEvent) {
  if (!props.mobile || !props.expanded) return
  if (event.key === 'Escape') { event.stopPropagation(); emit('toggle'); return }
  if (event.key !== 'Tab') return
  const buttons = sidebar.value?.querySelectorAll<HTMLButtonElement>('button')
  if (!buttons?.length) return
  const first = buttons[0], last = buttons[buttons.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
</script>

<style scoped>
.dashboard-sidebar { position:fixed; inset:0 auto 0 0; z-index:12; display:flex; flex-direction:column; width:var(--dashboard-sidebar-width); background:var(--surface); border-right:1px solid var(--border); }
.dashboard-sidebar.collapsed { width:64px; }
.sidebar-head { display:flex; align-items:center; gap:10px; min-height:76px; padding:12px 14px; }
.brand-mark { flex:0 0 34px; height:34px; display:grid; place-items:center; border-radius:10px; background:var(--accent); color:var(--on-accent); font-size:17px; font-weight:750; }
.sidebar-brand { flex:1; min-width:0; }
.sidebar-brand strong { display:block; color:var(--text); font-size:18px; line-height:1.25; }
.sidebar-brand span { color:var(--text3); font-size:12px; }
.sidebar-toggle { width:32px; height:32px; display:grid; place-items:center; flex-shrink:0; border:0; border-radius:7px; background:transparent; color:var(--text2); cursor:pointer; }
.sidebar-toggle:hover,.sidebar-item:hover { background:var(--raised); }
svg { flex:0 0 17px; width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
.sidebar-nav { flex:1; min-height:0; overflow:auto; padding:4px 10px; }
.sidebar-item { display:flex; align-items:center; gap:11px; width:100%; min-height:39px; margin:2px 0; padding:7px 12px; text-align:left; background:transparent; color:var(--text2); border:1px solid transparent; border-radius:8px; font-size:14px; font-weight:550; cursor:pointer; }
.sidebar-item.active { background:var(--accentDim); color:var(--accent); border-color:color-mix(in srgb,var(--accent) 40%,var(--card)); }
.sidebar-foot { padding:8px 10px; border-top:1px solid var(--border); }
.collapsed .sidebar-brand,.collapsed .brand-mark,.collapsed .sidebar-label { display:none; }
.collapsed .sidebar-item,.collapsed .sidebar-head { justify-content:center; }
@media(max-width:760px) {
  .dashboard-sidebar { max-width:calc(100vw - 52px); }
  .dashboard-sidebar.collapsed { width:52px; height:52px; bottom:auto; background:var(--surface); border-right:0; }
  .sidebar-head { min-height:52px; }
  .sidebar-item,.sidebar-toggle { min-height:44px; }
  .sidebar-toggle { min-width:44px; }
}
</style>
