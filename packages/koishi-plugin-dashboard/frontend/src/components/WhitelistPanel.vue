<template>
  <div class="tab-panel-root">
  <div class="card whitelist-head">
    <div>
      <h2 style="margin:0">黑白名单管理</h2>
      <div style="font-size:13px;color:var(--text3);margin-top:4px">每 3 秒自动同步，QQ 指令修改也会实时反映</div>
    </div>
    <div class="whitelist-toolbar">
      <input
        v-model="groupSearch"
        class="whitelist-search"
        type="search"
        placeholder="搜索群号"
      />
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
      <span style="font-size:12px;color:var(--text3)">{{ getVisibleCount(wl) }} / {{ getCount(wl) }} 条</span>
    </div>

    <!-- 空状态 -->
    <div v-if="isEmpty(wl)" style="color:var(--text3);font-size:14px;margin-bottom:12px">暂无数据</div>
    <div v-else-if="isFilteredEmpty(wl)" style="color:var(--text3);font-size:14px;margin-bottom:12px">没有匹配项</div>

    <!-- 列表 -->
    <div v-for="item in getVisibleItems(wl)" :key="item.key" class="grp" style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-family:monospace;font-size:14px">{{ item.label }}</span>
      <button class="btn btn-sm" style="background:color-mix(in srgb, var(--error) 20%, transparent);color:var(--error)" @click="removeDisplayItem(key, item)">删除</button>
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

interface WhitelistDisplayItem {
  key: string
  label: string
  raw: string
  index: number
  bucket: 'array' | 'groups' | 'users'
}

export default {
  name: 'WhitelistPanel',
  components: { SelectBox },
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const lists = ref<WhitelistMap>({})
    const groupSearch = ref('')
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

    // 构建带原始位置的显示项，搜索过滤后仍能准确删除原数据。
    function getDisplayItems(wl: WhitelistEntry): WhitelistDisplayItem[] {
      if (Array.isArray(wl.data)) {
        return wl.data.map((raw, index) => ({
          key: `array:${index}:${raw}`,
          label: raw,
          raw,
          index,
          bucket: 'array',
        }))
      }
      const items: WhitelistDisplayItem[] = []
      wl.data?.groups?.forEach((raw, index) => items.push({
        key: `groups:${index}:${raw}`,
        label: '[群] ' + raw,
        raw,
        index,
        bucket: 'groups',
      }))
      wl.data?.users?.forEach((raw, index) => items.push({
        key: `users:${index}:${raw}`,
        label: '[用户] ' + raw,
        raw,
        index,
        bucket: 'users',
      }))
      return items
    }

    // 返回当前搜索词下的可见项。
    function getVisibleItems(wl: WhitelistEntry): WhitelistDisplayItem[] {
      const query = groupSearch.value.trim().toLowerCase()
      const items = getDisplayItems(wl)
      if (!query) return items
      return items.filter(item => `${item.label} ${item.raw}`.toLowerCase().includes(query))
    }

    // 返回过滤后的计数。
    function getVisibleCount(wl: WhitelistEntry): number {
      return getVisibleItems(wl).length
    }

    // 判断当前搜索词是否把非空列表过滤为空。
    function isFilteredEmpty(wl: WhitelistEntry): boolean {
      return !isEmpty(wl) && getVisibleItems(wl).length === 0
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

    // 删除搜索结果中的显示项，按 bucket 和原始值更新对应列表。
    async function removeDisplayItem(key: string, item: WhitelistDisplayItem) {
      const wl = lists.value[key]
      if (!wl) return
      let newData: WhitelistData
      if (Array.isArray(wl.data)) {
        newData = wl.data[item.index] === item.raw
          ? wl.data.filter((_, i) => i !== item.index)
          : wl.data.filter(value => value !== item.raw)
      } else {
        newData = { ...wl.data }
        if (item.bucket === 'groups') newData.groups = (newData.groups || []).filter(value => value !== item.raw)
        else if (item.bucket === 'users') newData.users = (newData.users || []).filter(value => value !== item.raw)
        else return
      }
      const res = await updateWhitelist(key, newData)
      if (res.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog('修改白名单需要管理员密码', () => removeDisplayItem(key, item))
        return
      }
      if (res.ok) { msgs[key] = { type: 'ok', text: '已删除' }; load() }
      else msgs[key] = { type: 'err', text: messageFromData(res.data, '删除失败') }
      setTimeout(() => msgs[key] = null, 2000)
    }

    return { lists, groupSearch, newValues, newTypes, typeOptions, msgs, loadError, refreshing, refreshMsg, manualRefresh, isEmpty, isFilteredEmpty, isObjectList, getCount, getVisibleCount, getItems, getVisibleItems, inputPlaceholder, getRawItems, addItem, removeItem, removeDisplayItem }
  }
}
</script>

<style scoped>
.whitelist-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.whitelist-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.whitelist-search {
  width: min(260px, 42vw);
  font-family: monospace;
}

@media (max-width: 760px) {
  .whitelist-head {
    align-items: stretch;
    flex-direction: column;
  }

  .whitelist-toolbar {
    width: 100%;
    justify-content: flex-start;
  }

  .whitelist-search {
    width: 100%;
  }
}
</style>
