<template>
  <div class="tab-panel-root">
  <div class="card" style="display:flex;justify-content:space-between;align-items:center">
    <div>
      <h2 style="margin:0">黑白名单管理</h2>
      <div style="font-size:13px;color:var(--text3);margin-top:4px">每 3 秒自动同步，QQ 指令修改也会实时反映</div>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <span v-if="refreshMsg" style="font-size:12px;color:var(--success);animation:fadeIn .2s">{{ refreshMsg }}</span>
      <button class="btn btn-sm" @click="manualRefresh" :disabled="refreshing">
        {{ refreshing ? '刷新中...' : '刷新全部' }}
      </button>
    </div>
  </div>

  <div v-if="loadError" class="card" style="color:var(--error);font-size:13px">加载失败：{{ loadError }}</div>

  <div v-for="(wl, key) in lists" :key="key" class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">{{ wl.label }}</h2>
      <span style="font-size:12px;color:var(--text3)">{{ getCount(wl) }} 条</span>
    </div>

    <!-- 空状态 -->
    <div v-if="isEmpty(wl)" style="color:var(--text3);font-size:14px;margin-bottom:12px">暂无数据</div>

    <!-- 列表 -->
    <div v-for="(item, idx) in getItems(wl)" :key="idx" class="grp" style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-family:monospace;font-size:14px">{{ item }}</span>
      <button class="btn btn-sm" style="background:color-mix(in srgb, var(--error) 20%, transparent);color:var(--error)" @click="removeItem(key, idx)">删除</button>
    </div>

    <!-- 添加 -->
    <div style="display:flex;gap:8px;margin-top:12px">
      <SelectBox v-if="isObjectList(wl)" v-model="newTypes[key]" :options="typeOptions" style="flex:0 0 96px" />
      <input v-model="newValues[key]" :placeholder="inputPlaceholder(wl)" style="flex:1;font-family:monospace" @keyup.enter="addItem(key)" />
      <button class="btn btn-sm" @click="addItem(key)">添加</button>
    </div>

    <div v-if="msgs[key]" style="margin-top:8px;font-size:12px" :style="{color: msgs[key]?.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ msgs[key]?.text }}</div>
  </div>
  </div>
</template>

<script lang="ts">
import { ref, reactive, inject, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { fetchWhitelist, updateWhitelist } from '../api'
import type { MessageState, ShowAdminDialog, WhitelistBuckets, WhitelistData, WhitelistEntry, WhitelistMap } from '../types'
import { errorMessage, isRecord, messageFromData } from '../types'
import SelectBox from './SelectBox.vue'

export default {
  name: 'WhitelistPanel',
  components: { SelectBox },
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const lists = ref<WhitelistMap>({})
    const newValues = reactive<Record<string, string>>({})
    const newTypes = reactive<Record<string, 'groups' | 'users'>>({})
    const msgs = reactive<Record<string, MessageState | null>>({})
    const refreshing = ref(false)
    const refreshMsg = ref('')
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const loadError = ref('')
    const typeOptions = [
      { value: 'groups', label: '群' },
      { value: 'users', label: '用户' },
    ]

    async function load() {
      try {
        const res = await fetchWhitelist()
        if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('查看白名单需要管理员密码', load); return }
        if (res.ok && res.data) {
          lists.value = res.data
          loadError.value = ''
        } else {
          loadError.value = messageFromData(res.data, '加载失败')
        }
      } catch (e) {
        loadError.value = errorMessage(e)
      }
    }

    function startPoll() {
      stopPoll()
      pollTimer = setInterval(load, 3000)
    }
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    }

    async function manualRefresh() {
      refreshing.value = true
      await load()
      refreshing.value = false
      refreshMsg.value = '已刷新'
      setTimeout(() => refreshMsg.value = '', 2000)
    }

    onMounted(() => { load(); startPoll() })
    onUnmounted(stopPoll)
    onActivated(startPoll)
    onDeactivated(stopPoll)

    function isBuckets(data: WhitelistData): data is WhitelistBuckets {
      return isRecord(data) && !Array.isArray(data)
    }

    function isEmpty(wl: WhitelistEntry) {
      if (Array.isArray(wl.data)) return wl.data.length === 0
      if (isBuckets(wl.data)) return !wl.data.groups?.length && !wl.data.users?.length
      return true
    }

    function isObjectList(wl: WhitelistEntry) {
      return isBuckets(wl.data)
    }

    function getCount(wl: WhitelistEntry) {
      if (Array.isArray(wl.data)) return wl.data.length
      if (isBuckets(wl.data)) return (wl.data.groups?.length || 0) + (wl.data.users?.length || 0)
      return 0
    }

    function getItems(wl: WhitelistEntry): string[] {
      if (Array.isArray(wl.data)) return wl.data
      const items: string[] = []
      if (wl.data?.groups) wl.data.groups.forEach(g => items.push('[群] ' + g))
      if (wl.data?.users) wl.data.users.forEach(u => items.push('[用户] ' + u))
      return items
    }

    function inputPlaceholder(wl: WhitelistEntry) {
      if (isObjectList(wl)) return '群号或用户 QQ 号'
      if (wl.label.includes('用户')) return '用户 QQ 号'
      return '群号'
    }

    function getRawItems(wl: WhitelistEntry): string[] {
      if (Array.isArray(wl.data)) return wl.data
      const items: string[] = []
      if (wl.data?.groups) wl.data.groups.forEach(g => items.push(g))
      if (wl.data?.users) wl.data.users.forEach(u => items.push(u))
      return items
    }

    async function addItem(key: string) {
      const val = (newValues[key] || '').trim()
      if (!val) return
      const wl = lists.value[key]
      if (!wl) return

      let newData: WhitelistData
      if (Array.isArray(wl.data)) {
        if (wl.data.includes(val)) { msgs[key] = { type: 'err', text: '已存在' }; return }
        newData = [...wl.data, val]
      } else {
        newData = { ...wl.data }
        const bucket = newTypes[key] || 'groups'
        const exists = (newData[bucket] || []).includes(val)
        if (exists) { msgs[key] = { type: 'err', text: '已存在' }; return }
        newData[bucket] = [...(newData[bucket] || []), val]
      }

      const res = await updateWhitelist(key, newData)
      if (res.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog('修改白名单需要管理员密码', () => addItem(key))
        return
      }
      if (res.ok) {
        msgs[key] = { type: 'ok', text: '已添加' }
        newValues[key] = ''
        load()
      } else {
        msgs[key] = { type: 'err', text: messageFromData(res.data, '添加失败') }
      }
      setTimeout(() => msgs[key] = null, 2000)
    }

    async function removeItem(key: string, idx: number) {
      const wl = lists.value[key]
      if (!wl) return
      let newData: WhitelistData
      if (Array.isArray(wl.data)) {
        newData = wl.data.filter((_, i) => i !== idx)
      } else {
        const items = getItems(wl)
        const raw = items[idx].replace('[群] ', '').replace('[用户] ', '')
        const isGroup = items[idx].startsWith('[群]')
        newData = { ...wl.data }
        if (isGroup) newData.groups = (newData.groups || []).filter(g => g !== raw)
        else newData.users = (newData.users || []).filter(u => u !== raw)
      }
      const res = await updateWhitelist(key, newData)
      if (res.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog('修改白名单需要管理员密码', () => removeItem(key, idx))
        return
      }
      if (res.ok) { msgs[key] = { type: 'ok', text: '已删除' }; load() }
      else msgs[key] = { type: 'err', text: messageFromData(res.data, '删除失败') }
      setTimeout(() => msgs[key] = null, 2000)
    }

    return { lists, newValues, newTypes, typeOptions, msgs, loadError, refreshing, refreshMsg, manualRefresh, isEmpty, isObjectList, getCount, getItems, inputPlaceholder, getRawItems, addItem, removeItem }
  }
}
</script>
