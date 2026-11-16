<template>
  <div class="card participation-card">
    <h2>每群总开关</h2>
    <p class="participation-note">未配置的群默认关闭。首次开启后默认不主动回复，可搬运视频、复读、被动回复和使用集合；主动回复继续使用现有 AI 白名单控制。</p>
    <div class="participation-group-editor">
      <label for="participation-group-id">群号</label>
      <input id="participation-group-id" v-model.trim="groupId" inputmode="numeric" maxlength="20" placeholder="输入要管理的 QQ 群号" />
      <span v-if="groupNames[groupId]" class="participation-group-name">{{ groupNames[groupId] }}</span>
      <label class="participation-switch participation-abusive-switch">
        <span>嘴臭开关</span>
        <input type="checkbox" role="switch" aria-label="所填群号的嘴臭开关" :checked="selectedAbusiveEnabled" :disabled="loading || saving || loadFailed || !validGroupId" @change="changeAbusive(groupId, $event)" />
        <span class="participation-track" aria-hidden="true"></span>
        <span>{{ selectedAbusiveEnabled ? '已开启' : '已关闭' }}</span>
      </label>
      <label class="participation-switch participation-total-switch">
        <input type="checkbox" role="switch" aria-label="所填群号的总开关" :checked="selectedEnabled" :disabled="loading || saving || loadFailed || !validGroupId" @change="changeGroup(groupId, $event)" />
        <span class="participation-track" aria-hidden="true"></span>
        <span>{{ selectedEnabled ? '已开启' : '已关闭' }}</span>
      </label>
    </div>
    <div v-if="groups.length" class="participation-groups">
      <div v-for="group in groups" :key="group.id" class="participation-group-row">
        <div class="participation-group-identity">
          <span class="participation-group-number">{{ group.id }}</span>
          <input v-model="nameDrafts[group.id]" class="participation-name-input" :aria-label="`群 ${group.id} 名称`" maxlength="128" placeholder="填写群名" :disabled="loading || saving || loadFailed" @keydown.enter.prevent="saveName(group.id)" />
          <button v-if="nameDrafts[group.id] !== (groupNames[group.id] || '')" type="button" class="btn btn-sm btn-ghost" :aria-label="`保存群 ${group.id} 名称`" :disabled="loading || saving || loadFailed" @click="saveName(group.id)">保存</button>
        </div>
        <div class="participation-group-actions">
          <label class="participation-switch participation-abusive-switch">
            <span>嘴臭开关</span>
            <input type="checkbox" role="switch" :aria-label="`群 ${group.id} 嘴臭开关`" :checked="group.abusiveEnabled" :disabled="loading || saving || loadFailed" @change="changeAbusive(group.id, $event)" />
            <span class="participation-track" aria-hidden="true"></span>
            <span>{{ group.abusiveEnabled ? '已开启' : '已关闭' }}</span>
          </label>
          <label class="participation-switch participation-total-switch">
            <input type="checkbox" role="switch" :aria-label="`群 ${group.id} 总开关`" :checked="group.enabled" :disabled="loading || saving || loadFailed" @change="changeGroup(group.id, $event)" />
            <span class="participation-track" aria-hidden="true"></span>
            <span>{{ group.enabled ? '已开启' : '已关闭' }}</span>
          </label>
        </div>
      </div>
    </div>
    <p class="participation-note">群名仅在导入时读取一次，可修改后保存；不会修改 QQ 群名称。</p>
    <p class="participation-note">关闭后，本群消息、戳一戳、通知和排队任务后续发送均停止。重新开启保留已有功能设置。</p>
    <p class="participation-note">嘴臭开关默认关闭。开启后覆盖本群所有人格，正常聊天、道歉和主动插话也持续嘴臭；关闭后恢复原有人格与回复规则。</p>
    <div v-if="loading" class="participation-note" role="status">正在读取参与开关…</div>
    <div v-if="message" class="msg" :class="message.type" role="status">{{ message.text }}</div>
    <button v-if="loadFailed" type="button" class="btn btn-sm btn-ghost" @click="load">重新加载</button>
  </div>

  <div class="card participation-private">
    <div>
      <h2>全局私聊开关</h2>
      <p class="participation-note">默认关闭。关闭后不响应私聊，也不向私聊发送任务结果和通知。</p>
    </div>
    <label class="participation-switch">
      <input type="checkbox" role="switch" aria-label="全局私聊开关" :checked="policy.privateEnabled" :disabled="loading || saving || loadFailed" @change="changePrivate($event)" />
      <span class="participation-track" aria-hidden="true"></span>
      <span>{{ policy.privateEnabled ? '已开启' : '已关闭' }}</span>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { fetchParticipation, importGroupNames, saveGroupName, saveParticipation } from '../api'
import { errorMessage, messageFromData } from '../types'
import type { MessageState, ShowAdminDialog } from '../types'
import { isParticipationGroupId, listParticipationGroups } from '../services/participation-model'
import type { ParticipationChange, ParticipationPolicy } from '../services/participation-model'
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
const selectedEnabled = computed(() => policy.value.groups[groupId.value] === true)
const selectedAbusiveEnabled = computed(() => policy.value.abusiveGroups[groupId.value] === true)
const groups = computed(() => listParticipationGroups(policy.value))

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
    message.value = { type: 'ok', text: messageFromData(response.data, '参与开关已保存并生效') }
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

// 嘴臭独立于总开关保存，不改动该群原有的人格绑定或参与状态。
function changeAbusive(id: string, event: Event): void {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  input.checked = policy.value.abusiveGroups[id] === true
  void save({ kind: 'group-abusive', groupId: id, enabled })
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
.participation-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; font-size: 13px; }
.participation-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.participation-track { display: inline-block; position: relative; width: 42px; height: 24px; border-radius: 14px; background: var(--border); transition: background .2s; }
.participation-track::after { content: ''; position: absolute; width: 18px; height: 18px; top: 3px; left: 3px; border-radius: 50%; background: #fff; transition: transform .2s; }
input:checked + .participation-track { background: var(--success); }
input:checked + .participation-track::after { transform: translateX(18px); }
input:focus-visible + .participation-track { outline: 2px solid var(--accent); outline-offset: 3px; }
input:disabled + .participation-track { opacity: .5; cursor: not-allowed; }
@media (max-width: 560px) {
  .participation-group-row { flex-wrap: wrap; gap: 10px; }
  .participation-group-actions { width: 100%; gap: 16px; }
}
</style>
