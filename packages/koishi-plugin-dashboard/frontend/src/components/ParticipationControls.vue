<template>
  <div class="card participation-private">
    <div><h2>全局私聊开关</h2><p class="participation-note">默认关闭。关闭后不响应私聊，也不向私聊发送任务结果和通知。</p></div>
    <label class="participation-switch"><input type="checkbox" role="switch" aria-label="全局私聊开关" :checked="policy.privateEnabled" :disabled="loading || saving || loadFailed" @change="changePrivate($event)" /><span class="participation-track" aria-hidden="true"></span></label>
  </div>
  <div class="card participation-card">
    <h2>每群总开关</h2>
    <p class="participation-note">未配置的群默认关闭。首次开启保留已有的主动回复、复读、视频搬运和集合设置；没有旧配置的新群默认不主动回复，开启复读并允许视频搬运、被动回复和集合。主动回复继续使用现有 AI 白名单控制。</p>
    <form class="participation-group-editor" @submit.prevent="addGroup()">
      <label for="participation-group-id">群号</label>
      <input id="participation-group-id" v-model.trim="groupId" inputmode="numeric" maxlength="20" placeholder="输入要管理的 QQ 群号" :disabled="loading || saving || loadFailed" />
      <span v-if="groupNames[groupId]" class="participation-group-name">{{ groupNames[groupId] }}</span>
      <button type="submit" class="btn btn-sm" :disabled="loading || saving || loadFailed || !validGroupId">添加</button>
    </form>
    <div v-if="groups.length" class="participation-groups">
      <div v-for="group in groups" :key="group.id" class="participation-group-row">
        <div class="participation-group-identity">
          <span class="participation-group-number">{{ group.id }}</span>
          <input v-model="nameDrafts[group.id]" class="participation-name-input" :aria-label="`群 ${group.id} 名称`" maxlength="128" placeholder="填写群名" :disabled="loading || saving || loadFailed" @keydown.enter.prevent="saveName(group.id)" />
          <button v-if="nameDrafts[group.id] !== (groupNames[group.id] || '')" type="button" class="btn btn-sm btn-ghost" :aria-label="`保存群 ${group.id} 名称`" :disabled="loading || saving || loadFailed" @click="saveName(group.id)">保存</button>
        </div>
        <div class="participation-group-actions">
          <button type="button" class="btn btn-sm btn-ghost" :aria-label="`编辑群 ${group.id}`" :disabled="loading || saving || loadFailed" @click="editingGroup = group.id">编辑</button>
          <label class="participation-switch participation-total-switch">
            <input type="checkbox" role="switch" :aria-label="`群 ${group.id} 总开关`" :checked="group.enabled" :disabled="loading || saving || loadFailed" @change="changeGroup(group.id, $event)" />
            <span class="participation-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
    </div>
    <p v-else-if="!loading && !loadFailed" class="participation-note">暂无群，请输入群号后点击添加。</p>
    <p class="participation-note">群名仅在导入时读取一次，可修改后保存；不会修改 QQ 群名称。</p>
    <p class="participation-note">关闭后，本群消息、戳一戳、通知和排队任务后续发送均停止。重新开启保留已有功能设置。</p>
    <p class="participation-note">点击编辑可设置本群功能、人格和回复概率。新添加的群总开关默认关闭。</p>
    <div v-if="loading" class="participation-note" role="status">正在读取参与开关…</div>
    <div v-if="message" class="msg" :class="message.type" role="status">{{ message.text }}</div>
    <button v-if="loadFailed" type="button" class="btn btn-sm btn-ghost" @click="load">重新加载</button>
  </div>

  <GroupDetailsDialog v-if="editingGroup" :group-id="editingGroup" @close="editingGroup = ''" @saved="applyDetails" @removed="removeFromList" />
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { addManagedGroup, fetchParticipation, importGroupNames, saveGroupName, saveParticipation } from '../api'
import GroupDetailsDialog from './GroupDetailsDialog.vue'
import { errorMessage, messageFromData } from '../types'
import type { MessageState, ShowAdminDialog } from '../types'
import { isParticipationGroupId, listParticipationGroups } from '../services/participation-model'
import type { GroupSettingsResponse, ParticipationChange, ParticipationPolicy, ParticipationResponse } from '../services/participation-model'
import { useGroupNames } from '../services/group-names'

const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const { groupNames, refreshGroupNames } = useGroupNames()
const policy = ref<ParticipationPolicy>({ version: 1, privateEnabled: false, groups: {}, abusiveGroups: {} })
const groupId = ref('')
const nameDrafts = ref<Record<string, string>>({})
const loading = ref(true)
const saving = ref(false)
const loadFailed = ref(false)
const message = ref<MessageState | null>(null)
const validGroupId = computed(() => isParticipationGroupId(groupId.value))
const editingGroup = ref('')
const groups = computed(() => listParticipationGroups(policy.value))

// --- 列表添加与详情同步 ---

// 新增群独立于启用，重复添加不改变已有开关及配置。
async function addGroup(retried = false, id = groupId.value): Promise<void> {
  if (saving.value || !isParticipationGroupId(id)) return
  if (groups.value.some(group => group.id === id)) {
    message.value = { type: 'err', text: '该群已在列表中' }; return
  }
  saving.value = true
  message.value = null
  try {
    const response = await addManagedGroup(id)
    if (response.code === 'ADMIN_REQUIRED' && !retried && showAdminDialog) {
      showAdminDialog('添加群需要管理员密码', () => addGroup(true, id)); return
    }
    if (!response.ok || !response.data?.policy) throw new Error(messageFromData(response.data, '添加群失败'))
    policy.value = response.data.policy
    groupId.value = ''
    message.value = { type: 'ok', text: '群已添加，可点击编辑设置功能' }
    await loadNames()
  } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  finally { saving.value = false }
}

// 同步服务器确认的详情，保留其他群尚未保存的名称草稿。
function applyDetails(data: GroupSettingsResponse): void {
  if (!data.policy || !data.groups || !data.settings) return
  policy.value = data.policy
  groupNames.value = data.groups
  nameDrafts.value[data.settings.groupId] = data.settings.name
}

// 删除成功后移除该行、备注草稿和详情弹窗。
function removeFromList(data: ParticipationResponse): void {
  if (!data.policy || !data.groups) return
  policy.value = data.policy
  groupNames.value = data.groups
  delete nameDrafts.value[editingGroup.value]
  editingGroup.value = ''
  message.value = { type: 'ok', text: '群已从列表删除' }
}

// --- 群名读取与备注 ---

// 只为新加入的群导入名称；原有名称和其他行尚未保存的输入均保留。
async function loadNames(): Promise<void> {
  await refreshGroupNames(true)
  const missing = groups.value.map(group => group.id).filter(id => !Object.prototype.hasOwnProperty.call(groupNames.value, id))
  if (missing.length) {
    const response = await importGroupNames(missing)
    if (!response.ok || !response.data?.groups) throw new Error(messageFromData(response.data, '群名导入失败'))
    groupNames.value = response.data.groups
    if (response.data.message) message.value = { type: 'err', text: response.data.message }
  }
  for (const group of groups.value) {
    if (!(group.id in nameDrafts.value)) nameDrafts.value[group.id] = groupNames.value[group.id] || ''
  }
}

// 名称保存成功后才更新已保存值；失败保留输入，并支持管理员验证后重试。
async function saveName(id: string, retried = false): Promise<void> {
  const name = (nameDrafts.value[id] || '').trim()
  if (saving.value) return
  if (name === (groupNames.value[id] || '')) { nameDrafts.value[id] = name; return }
  saving.value = true
  message.value = null
  try {
    const response = await saveGroupName(id, name)
    if (response.code === 'ADMIN_REQUIRED' && !retried && showAdminDialog) {
      showAdminDialog('修改群名需要管理员密码', () => saveName(id, true))
      return
    }
    if (!response.ok || !response.data?.groups) throw new Error(messageFromData(response.data, '群名保存失败'))
    groupNames.value = response.data.groups
    nameDrafts.value[id] = response.data.groups[id] || ''
    message.value = { type: 'ok', text: '群名已保存' }
  } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  finally { saving.value = false }
}

// --- 总开关读取与切换 ---

// 读取真实配置；鉴权或读取失败时禁用开关，防止用默认值覆盖服务器。
async function load(): Promise<void> {
  loading.value = true
  loadFailed.value = false
  try {
    const response = await fetchParticipation()
    if (response.code === 'ADMIN_REQUIRED' && showAdminDialog) {
      loadFailed.value = true
      showAdminDialog('管理群聊和私聊总开关需要管理员密码', load)
      return
    }
    if (!response.ok || !response.data?.policy) throw new Error(messageFromData(response.data, '参与开关读取失败'))
    policy.value = response.data.policy
    message.value = null
    // 名称读取失败只影响备注，不禁用已经成功读取的总开关。
    try { await loadNames() } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  } catch (error) {
    loadFailed.value = true
    message.value = { type: 'err', text: errorMessage(error) }
  } finally { loading.value = false }
}

// 成功响应后更新界面；管理员重试保留原本要提交的精确开关值。
async function save(change: ParticipationChange, retried = false): Promise<void> {
  saving.value = true
  message.value = null
  try {
    const response = await saveParticipation(change)
    if (response.code === 'ADMIN_REQUIRED' && !retried && showAdminDialog) {
      showAdminDialog('修改参与开关需要管理员密码', () => save(change, true))
      return
    }
    if (!response.ok || !response.data?.policy) throw new Error(messageFromData(response.data, '参与开关保存失败'))
    policy.value = response.data.policy
    message.value = { type: 'ok', text: '开关设置已保存' }
    if (change.kind !== 'private' && groups.value.some(group => !(group.id in nameDrafts.value))) await loadNames()
  } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  finally { saving.value = false }
}

// 保留服务器确认的群开关状态，保存失败时界面不会假装已经成功。
function changeGroup(id: string, event: Event): void {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  input.checked = policy.value.groups[id] === true
  void save({ kind: 'group', groupId: id, enabled })
}

// 全局私聊变更与群开关独立保存。
function changePrivate(event: Event): void {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  input.checked = policy.value.privateEnabled
  void save({ kind: 'private', enabled })
}

onMounted(load)
</script>

<style src="./participation-switch.css"></style>
<style scoped>
.participation-note { margin: 8px 0 14px; color: var(--text3); font-size: 13px; line-height: 1.7; }
.participation-group-editor { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.participation-group-editor > input { flex: 1; min-width: 180px; max-width: 320px; }
.participation-groups { margin-top: 16px; border-top: 1px solid var(--border); }
.participation-group-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.participation-group-number { font-family: monospace; font-size: 14px; min-width: 0; overflow-wrap: anywhere; }
.participation-group-identity { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; flex: 1; }
.participation-name-input { width: 220px; max-width: 100%; min-width: 100px; padding: 6px 8px; font-family: var(--font-body, sans-serif); }
.participation-group-name { font-family: var(--font-body, sans-serif); color: var(--text3); }
.participation-group-actions { display: flex; align-items: center; justify-content: flex-end; gap: 24px; margin-left: auto; }
.participation-private { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.participation-private h2 { margin-bottom: 4px; }
.participation-private p { margin-bottom: 0; }
@media (max-width: 560px) {
  .participation-group-row { flex-wrap: wrap; gap: 10px; }
  .participation-group-actions { width: 100%; gap: 16px; }
}
</style>
