<template>
  <div v-for="(wl, key) in lists" :key="key" class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">{{ wl.label }}</h2>
      <span style="font-size:12px;color:var(--text3)">{{ loading[key] ? '同步中...' : getCount(wl) + ' 条' }}</span>
    </div>

    <!-- 空状态 -->
    <div v-if="isEmpty(wl)" style="color:var(--text3);font-size:14px;margin-bottom:12px">当前列表为空</div>

    <!-- 列表 -->
    <div v-for="(item, idx) in getItems(wl)" :key="idx" class="grp" style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-family:monospace;font-size:14px">{{ item }}</span>
      <button class="btn btn-sm" style="background:rgba(244,114,182,0.2);color:#F472B6" :disabled="loading[key]" @click="removeItem(key, idx)">删除</button>
    </div>

    <!-- 添加 -->
    <div style="display:flex;gap:8px;margin-top:12px">
      <input v-model="newValues[key]" :placeholder="inputPlaceholder(wl)" :disabled="loading[key]" style="flex:1;font-family:monospace" @keyup.enter="addItem(key)" />
      <button class="btn btn-sm" :disabled="loading[key]" @click="addItem(key)">{{ loading[key] ? '保存中...' : '添加' }}</button>
    </div>

    <div v-if="msgs[key]" style="margin-top:8px;font-size:12px" :style="{color: msgs[key]?.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ msgs[key]?.text }}</div>
  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue'
import { fetchWhitelist, updateWhitelist } from '../api'

export default {
  name: 'WhitelistPanel',
  components: { },
  setup() {
    const lists = ref({})
    const newValues = reactive({})
    const msgs = reactive({})
    const loading = reactive({})

    async function load() {
      const res = await fetchWhitelist()
      if (res.ok) lists.value = res.data
    }
    onMounted(load)

    function isEmpty(wl) {
      if (Array.isArray(wl.data)) return wl.data.length === 0
      if (typeof wl.data === 'object') return !wl.data.groups?.length && !wl.data.users?.length
      return true
    }

    function getCount(wl) {
      if (Array.isArray(wl.data)) return wl.data.length
      if (typeof wl.data === 'object') return (wl.data.groups?.length || 0) + (wl.data.users?.length || 0)
      return 0
    }

    function getItems(wl) {
      if (Array.isArray(wl.data)) return wl.data
      const items = []
      if (wl.data?.groups) wl.data.groups.forEach(g => items.push('[群] ' + g))
      if (wl.data?.users) wl.data.users.forEach(u => items.push('[用户] ' + u))
      return items
    }

    function inputPlaceholder(wl) {
      if (wl.label.includes('视频')) return '群号 或 用户QQ号'
      if (wl.label.includes('用户')) return '用户 QQ 号'
      return '群号'
    }

    function cloneData(data) {
      if (Array.isArray(data)) return [...data]
      return {
        groups: [...(data?.groups || [])],
        users: [...(data?.users || [])],
      }
    }

    function setListData(key, data) {
      const current = lists.value[key]
      lists.value = { ...lists.value, [key]: { ...current, data } }
    }

    function finishMessage(key, type, text) {
      msgs[key] = { type, text }
      setTimeout(() => { msgs[key] = null }, 2000)
    }

    async function saveList(key, newData, previousData, successText, retryFn) {
      loading[key] = true
      setListData(key, newData)
      const res = await updateWhitelist(key, newData)
      loading[key] = false
      if (res.code === 'ADMIN_REQUIRED') {
        setListData(key, previousData)
        window.showAdminDialog && window.showAdminDialog('修改白名单需要管理员密码', retryFn)
        return false
      }
      if (!res.ok) {
        setListData(key, previousData)
        finishMessage(key, 'err', res.data?.message || '保存失败')
        return false
      }
      finishMessage(key, 'ok', successText)
      return true
    }

    async function addItem(key) {
      const val = (newValues[key] || '').trim()
      if (!val) return
      const wl = lists.value[key]
      if (!wl) return

      let newData
      const previousData = cloneData(wl.data)
      if (Array.isArray(wl.data)) {
        if (wl.data.includes(val)) { msgs[key] = { type: 'err', text: '已存在' }; return }
        newData = [...wl.data, val]
      } else {
        const isGroup = /^\d+$/.test(val)
        newData = cloneData(wl.data)
        if (isGroup && newData.groups.includes(val)) { finishMessage(key, 'err', '已存在'); return }
        if (!isGroup && newData.users.includes(val)) { finishMessage(key, 'err', '已存在'); return }
        if (isGroup) newData.groups = [...(newData.groups || []), val]
        else newData.users = [...(newData.users || []), val]
      }

      const ok = await saveList(key, newData, previousData, '已添加', () => addItem(key))
      if (ok) newValues[key] = ''
    }

    async function removeItem(key, idx) {
      const wl = lists.value[key]
      if (!wl) return
      let newData
      const previousData = cloneData(wl.data)
      if (Array.isArray(wl.data)) {
        newData = wl.data.filter((_, i) => i !== idx)
      } else {
        const items = getItems(wl)
        const raw = items[idx].replace('[群] ', '').replace('[用户] ', '')
        const isGroup = items[idx].startsWith('[群]')
        newData = cloneData(wl.data)
        if (isGroup) newData.groups = (newData.groups || []).filter(g => g !== raw)
        else newData.users = (newData.users || []).filter(u => u !== raw)
      }
      await saveList(key, newData, previousData, '已删除', () => removeItem(key, idx))
    }

    return { lists, newValues, msgs, loading, isEmpty, getCount, getItems, inputPlaceholder, addItem, removeItem }
  }
}
</script>
