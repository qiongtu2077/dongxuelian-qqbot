<template>
  <Teleport to="body">
    <div class="admin-modal-backdrop group-detail-backdrop" @click.self="close" @keydown="handleKeys">
      <section ref="dialog" class="group-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="group-detail-title" tabindex="-1" :inert="confirmDelete || undefined">
        <header class="group-detail-head">
          <div><h2 id="group-detail-title">群详情</h2><p>{{ groupId }}<span v-if="settings?.name"> · {{ settings.name }}</span></p></div>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="saving" @click="close">关闭</button>
        </header>
        <div v-if="loading" class="group-detail-body" role="status">正在读取群设置…</div>
        <form v-else-if="settings" @submit.prevent="save()">
          <div class="group-detail-body">
            <label class="group-detail-field">群名称<input v-model="settings.name" maxlength="128" :disabled="saving" :aria-label="`群 ${groupId} 详情名称`" placeholder="填写本地群备注" /></label>
            <p class="group-detail-note">群名仅作为控制台备注保存，不会修改 QQ 群名称。</p>
            <div v-for="field in switches" :key="field.key" class="group-detail-setting">
              <div><label :for="`group-detail-${field.key}`">{{ field.label }}</label><p>{{ field.description }}</p></div>
              <label class="participation-switch">
                <input :id="`group-detail-${field.key}`" v-model="settings[field.key]" type="checkbox" role="switch" :aria-label="`群 ${groupId} ${field.label}`" :disabled="saving" />
                <span class="participation-track" aria-hidden="true"></span>
              </label>
            </div>
            <div class="group-detail-options">
              <label class="group-detail-field">群人格<select v-model="settings.persona" :disabled="saving" aria-label="群人格"><option value="">使用默认人格</option><option v-if="settings.persona && !personas.includes(settings.persona)" :value="settings.persona" disabled>{{ settings.persona }}（已不存在，请重新选择）</option><option v-for="persona in personas" :key="persona" :value="persona">{{ persona }}</option></select></label>
              <p class="group-detail-note">嘴臭开关开启时优先使用嘴臭人格；关闭后恢复此处的人格设置。</p>
              <label class="group-detail-field">主动回复基础概率（%）<input type="number" min="0" max="100" step="0.01" :value="ratePercent(settings.randomRate)" :placeholder="`默认 ${ratePercent(defaults.randomRate)}%`" :disabled="saving" aria-label="主动回复基础概率（%）" @input="changeRate('randomRate', $event)" /></label>
              <label class="group-detail-field">随机语音概率（%）<input type="number" min="0" max="100" step="0.01" :value="ratePercent(settings.voiceRate)" :placeholder="`默认 ${ratePercent(defaults.voiceRate)}%`" :disabled="saving" aria-label="随机语音概率（%）" @input="changeRate('voiceRate', $event)" /></label>
              <p class="group-detail-note">概率留空使用默认值。随机语音概率表示触发回复后转为语音的比例。</p>
            </div>
            <div v-if="message" class="msg" :class="message.type" role="status">{{ message.text }}</div>
          </div>
          <footer class="group-detail-footer">
            <button type="submit" class="btn" :disabled="saving">{{ saving ? '保存中…' : '保存群设置' }}</button>
            <div class="group-detail-danger"><div><strong>删除这个群</strong><p>移出管理列表并停止该群参与；保留已有功能配置，重新添加后可继续使用。</p></div><button type="button" class="btn btn-sm btn-ghost danger-button" :disabled="saving" @click="askDelete">删除群</button></div>
          </footer>
        </form>
        <div v-else class="group-detail-body"><p class="msg err" role="alert">{{ message?.text }}</p><button type="button" class="btn btn-sm" @click="load()">重新加载</button></div>
      </section>
      <div v-if="confirmDelete" class="group-delete-backdrop">
      <section ref="confirmation" class="group-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="group-delete-title" aria-describedby="group-delete-description" tabindex="-1">
        <h2 id="group-delete-title">确认删除这个群？</h2>
        <p id="group-delete-description">{{ settings?.name || '未命名群' }}（{{ groupId }}）将从管理列表移除，该群消息和后续任务发送将停止。</p>
        <p v-if="message?.type === 'err'" class="msg err" role="alert">{{ message.text }}</p>
        <div class="group-delete-actions"><button ref="cancelDelete" type="button" class="btn btn-ghost" :disabled="saving" @click="cancelRemoval">取消</button><button type="button" class="btn danger-button" :disabled="saving" @click="remove()">{{ saving ? '删除中…' : '确认删除' }}</button></div>
      </section>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { inject, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { deleteManagedGroup, fetchGroupSettings, saveGroupSettings } from '../api'
import { errorMessage, messageFromData } from '../types'
import type { MessageState, ShowAdminDialog } from '../types'
import type { GroupSettings, GroupSettingsResponse, ParticipationResponse } from '../services/participation-model'

const props = defineProps<{ groupId: string }>()
const emit = defineEmits<{ close: []; saved: [data: GroupSettingsResponse]; removed: [data: ParticipationResponse] }>()
const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const settings = ref<GroupSettings | null>(null)
const personas = ref<string[]>([])
const defaults = ref({ randomRate: 0.008, voiceRate: 0.1 })
const loading = ref(true)
const saving = ref(false)
const message = ref<MessageState | null>(null)
const confirmDelete = ref(false)
const dialog = ref<HTMLElement | null>(null)
const confirmation = ref<HTMLElement | null>(null)
const cancelDelete = ref<HTMLButtonElement | null>(null)
const previousFocus = document.activeElement as HTMLElement | null
const switches = [
  { key: 'enabled', label: '总开关', description: '控制本群消息、戳一戳、通知和任务后续发送。' },
  { key: 'abusiveEnabled', label: '嘴臭开关', description: '覆盖本群所有人格，普通聊天和主动插话也使用嘴臭人格。' },
  { key: 'randomEnabled', label: '主动回复', description: '允许 AI 主动参与本群聊天；被动回复仍受总开关控制。' },
  { key: 'repeatEnabled', label: '复读', description: '允许在本群按复读规则跟随重复消息。' },
  { key: 'videoEnabled', label: '视频搬运', description: '允许本群使用视频解析与搬运功能。' },
  { key: 'collectionEnabled', label: '昵称与集合', description: '允许本群使用昵称、集合及相关 @ 功能。' },
  { key: 'politicalEnabled', label: '敏感内容检测', description: '使用项目已有的敏感内容检测与处理规则。' },
  { key: 'summaryUnlimited', label: '解除上限白名单', description: '将本群加入现有解除上限群白名单。' },
] as const

// --- 读取与保存 ---

// 加载真实群详情；验证管理员后可重试，读取失败不展示可提交的默认配置。
async function load(retried = false): Promise<void> {
  loading.value = true
  message.value = null
  try {
    const response = await fetchGroupSettings(props.groupId)
    if (response.code === 'ADMIN_REQUIRED' && !retried && showAdminDialog) {
      showAdminDialog('查看群详情需要管理员密码', () => load(true)); return
    }
    if (!response.ok || !response.data?.settings || !response.data.defaults || !response.data.personas) throw new Error(messageFromData(response.data, '群详情读取失败'))
    settings.value = { ...response.data.settings }
    personas.value = response.data.personas
    defaults.value = response.data.defaults
  } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  finally { loading.value = false }
}

// 界面使用百分数，空输入保留为默认值，避免把 0 误当成空值。
function changeRate(key: 'randomRate' | 'voiceRate', event: Event): void {
  if (!settings.value) return
  const value = (event.target as HTMLInputElement).value
  settings.value[key] = value === '' ? null : Number(value) / 100
}

// 把已保存的小数概率显示为百分数。
function ratePercent(rate: number | null): number | string {
  return rate === null ? '' : Number((rate * 100).toFixed(8))
}

// 保存整个群的草稿；失败保留所有输入，成功后同步列表中的名称和开关。
async function save(retried = false, draft: GroupSettings | null = settings.value): Promise<void> {
  if (saving.value || !draft) return
  const snapshot = { ...draft }
  if ([snapshot.randomRate, snapshot.voiceRate].some(rate => rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1))) {
    message.value = { type: 'err', text: '概率须在 0 到 100% 之间' }; return
  }
  saving.value = true
  message.value = null
  try {
    const response = await saveGroupSettings(snapshot)
    if (response.code === 'ADMIN_REQUIRED' && !retried && showAdminDialog) {
      showAdminDialog('修改群详情需要管理员密码', () => save(true, snapshot)); return
    }
    if (!response.ok || !response.data?.settings || !response.data.policy || !response.data.groups) throw new Error(messageFromData(response.data, '群详情保存失败'))
    settings.value = { ...response.data.settings }
    emit('saved', response.data)
    message.value = { type: 'ok', text: '群详情已保存' }
  } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  finally { saving.value = false }
}

// --- 删除确认与键盘操作 ---

// 删除前展示准确的群号和名称，并默认聚焦取消按钮。
async function askDelete(): Promise<void> {
  message.value = null
  confirmDelete.value = true
  await nextTick()
  cancelDelete.value?.focus()
}

// 取消删除并返回详情，保留尚未保存的草稿。
async function cancelRemoval(): Promise<void> {
  confirmDelete.value = false
  await nextTick()
  dialog.value?.querySelector<HTMLButtonElement>('.danger-button')?.focus()
}

// 仅在用户确认后发送删除请求，失败保持弹窗供重试。
async function remove(retried = false): Promise<void> {
  if (saving.value || !confirmDelete.value) return
  saving.value = true
  message.value = null
  try {
    const response = await deleteManagedGroup(props.groupId)
    if (response.code === 'ADMIN_REQUIRED' && !retried && showAdminDialog) {
      showAdminDialog('删除群需要管理员密码', () => remove(true)); return
    }
    if (!response.ok || !response.data?.policy || !response.data.groups) throw new Error(messageFromData(response.data, '删除群失败'))
    emit('removed', response.data)
  } catch (error) { message.value = { type: 'err', text: errorMessage(error) } }
  finally { saving.value = false }
}

// 提交期间保持弹窗，避免请求结果失去上下文。
function close(): void {
  if (!saving.value && !confirmDelete.value) emit('close')
}

// Escape 优先关闭删除确认；Tab 焦点始终留在当前弹窗。
function handleKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation(); event.preventDefault()
    if (saving.value) return
    if (confirmDelete.value) void cancelRemoval()
    else close()
  } else if (event.key === 'Tab') {
    const root = confirmDelete.value ? confirmation.value : dialog.value
    const elements = root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')
    if (!elements?.length) { event.preventDefault(); root?.focus(); return }
    const first = elements[0]; const last = elements[elements.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus() }
  }
}

// 打开时聚焦弹窗；关闭时把焦点还给列表入口。
onMounted(() => { dialog.value?.focus(); void load() })
onUnmounted(() => { if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<style src="./participation-switch.css"></style>
<style scoped>
.group-detail-backdrop { z-index: 45; }
.group-detail-dialog, .group-delete-dialog { width: min(680px, 100%); max-height: calc(100dvh - 48px); overflow-y: auto; border: 1px solid var(--border); border-radius: 16px; background: var(--card); color: var(--text); box-shadow: 0 22px 64px rgba(0,0,0,.36); }
.group-detail-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 24px; border-bottom: 1px solid var(--border); background: var(--bg); }
.group-detail-head h2 { margin: 0; font-size: 20px; }
.group-detail-head p { margin: 6px 0 0; color: var(--text3); font-size: 13px; overflow-wrap: anywhere; }
.group-detail-body { padding: 20px 24px; }
.group-detail-field { display: grid; gap: 8px; font-size: 14px; }
.group-detail-field input, .group-detail-field select { width: 100%; min-width: 0; box-sizing: border-box; }
.group-detail-note, .group-detail-setting p, .group-detail-danger p { color: var(--text3); font-size: 12px; line-height: 1.7; margin: 6px 0 0; }
.group-detail-note { margin-bottom: 14px; }
.group-detail-setting { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 0; border-bottom: 1px solid var(--border); }
.group-detail-setting > div > label { font-size: 14px; font-weight: 600; }
.group-detail-options { display: grid; gap: 12px; margin-top: 20px; }
.group-detail-footer { display: grid; gap: 22px; padding: 0 24px 24px; }
.group-detail-footer > .btn { justify-self: end; }
.group-detail-danger { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding-top: 20px; border-top: 1px solid var(--border); }
.group-detail-danger strong { font-size: 14px; }
.danger-button { border-color: var(--danger); color: var(--danger); background: transparent; flex-shrink: 0; }
.group-detail-dialog[inert] { pointer-events: none; opacity: .35; }
.group-delete-backdrop { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.5); backdrop-filter: blur(8px); }
.group-delete-dialog { width: min(440px, calc(100% - 48px)); padding: 24px; box-sizing: border-box; background: var(--bg); }
.group-delete-dialog h2 { margin: 0 0 12px; font-size: 18px; }
.group-delete-dialog p { font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.group-delete-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }
@media (max-width: 560px) { .group-detail-backdrop { padding: 12px; } .group-detail-dialog { max-height: calc(100dvh - 24px); } .group-detail-head, .group-detail-body { padding: 18px; } .group-detail-footer { padding: 0 18px 18px; } }
</style>
