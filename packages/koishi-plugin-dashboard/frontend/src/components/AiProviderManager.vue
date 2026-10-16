<template>
  <section class="card connections" aria-labelledby="connections-title">
    <div class="section-head"><div><p class="step-index">01</p><h3 id="connections-title">已导入的 API Key</h3><p>统一保存，文字、识图、语音识别和语音合成共用，无需重复导入。</p></div><button class="primary" :disabled="!!busyId" @click="openImport()">＋ 导入 API Key</button></div>
    <div class="table-scroll"><table><thead><tr><th>供应商 / 名称</th><th>API Key</th><th>已配置能力</th><th>模型</th><th>操作</th></tr></thead><tbody>
      <tr v-for="provider in connected" :key="provider.id"><td><strong>{{ provider.name }}</strong><small>{{ provider.note || (provider.custom ? '自定义供应商' : '内置供应商') }}</small></td><td class="key-mask">{{ config.providers[provider.id]?.key.prefix }}</td><td><div class="badges"><span v-for="cap in providerCapabilities(provider.id)" :key="cap">{{ labels[cap] }}</span><span v-if="!providerCapabilities(provider.id).length">待检测</span></div></td><td><button class="text-btn" @click="openModels(provider.id)">{{ config.providers[provider.id]?.models.length || 0 }} 个模型 ↗</button></td><td><div class="actions"><button class="text-btn" :disabled="!!busyId" @click="refreshProvider(provider.id)">刷新模型</button><button class="text-btn" @click="openModels(provider.id)">管理模型</button><button class="text-btn" :disabled="!!busyId" @click="openImport(provider.id)">替换 Key</button><button class="text-btn danger" :disabled="!!busyId" :aria-label="`删除 ${provider.name} 的 API Key`" @click="deleteId = provider.id; deleteDialog?.showModal()">删除</button></div></td></tr>
      <tr v-if="!connected.length"><td colspan="5" class="empty">尚未导入 API Key，点击右上角按钮添加。</td></tr>
    </tbody></table></div>
    <div v-if="busyId" class="progress" role="status"><span>{{ progress }}</span><button v-if="scanning" class="text-btn" @click="stopScan = true">{{ stopScan ? '当前模型完成后停止' : '停止检测' }}</button></div>
    <p v-if="message" class="notice success" role="status">{{ message }}</p><p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p class="help">自动检测四项能力；无法确认的标为「待检测」。内置供应商使用已验证的能力目录。</p>

    <dialog ref="importDialog" aria-labelledby="import-key-title" @close="keyDraft = ''">
      <form @submit.prevent="submitImport"><header><div><p class="step-index">NEW CONNECTION</p><h3 id="import-key-title">{{ editingId ? '替换 API Key' : '导入 API Key' }}</h3><p>导入一次，四项能力共用。</p></div><button type="button" class="close" aria-label="关闭导入窗口" @click="importDialog?.close()">×</button></header>
      <div class="dialog-body"><label class="field">供应商<select v-model="selectedId" :disabled="!!editingId || !!busyId"><option value="custom-new">自定义 OpenAI-compatible 供应商</option><option v-for="provider in catalog" :key="provider.id" :value="provider.id">{{ provider.name }}{{ config.providers[provider.id]?.key.configured ? '（已导入）' : '' }}</option></select></label>
        <template v-if="isCustom"><div class="form-grid"><label class="field">连接名称<input v-model="customName" required maxlength="96" placeholder="例如：MistEO" :disabled="!!busyId" /></label><label class="field">备注（可选）<input v-model="customNote" maxlength="256" :disabled="!!busyId" /></label></div><label class="field">请求地址<input v-model="customURL" required type="url" maxlength="2048" placeholder="https://example.com/v1" :disabled="!!busyId" /></label><p class="help">填写 API 基础地址（如 /v1），不要填 /chat/completions。支持 HTTP 和 HTTPS；HTTP 明文传输密钥和内容。</p></template>
        <p v-if="selectedProvider && !selectedProvider.discoveryAvailable" class="help">{{ selectedProvider.discoveryReason }}；将保存 Key 并使用已验证的参考模型目录，调用权限由实际请求验证。</p>
        <label class="field">API Key<input v-model="keyDraft" type="password" autocomplete="off" required maxlength="16384" placeholder="粘贴 API Key" :disabled="!!busyId" /></label>
        <div class="tip"><strong>自动获取模型与识别能力</strong><div class="badges"><span v-for="cap in capabilityIds" :key="cap">{{ labels[cap] }}</span></div><p>自定义供应商会逐个模型进行小请求检测，可能产生少量 API 用量。鉴权、限流或超时会标记待检测；不会按当前页面给所有模型贴标签。</p></div>
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      </div><footer><button type="button" @click="importDialog?.close()">取消</button><button type="submit" class="primary" :disabled="!!busyId">{{ busyId ? '正在导入…' : '导入并自动检测' }}</button></footer></form>
    </dialog>

    <dialog ref="modelsDialog" class="wide" aria-labelledby="managed-models-title"><header><div><p class="step-index">MODEL CAPABILITIES</p><h3 id="managed-models-title">{{ providerName(modelsId) }} · 管理模型</h3><p>四项能力复用已保存的 Key。</p></div><button class="close" aria-label="关闭模型窗口" @click="modelsDialog?.close()">×</button></header><div class="dialog-body"><div class="tip">✓ 已确认支持　— 明确不支持　? 待检测。暂时检测失败时保留已有配置能力；未检测的新模型不会自动进入优先级。</div><div class="table-scroll"><table><thead><tr><th>模型</th><th v-for="cap in capabilityIds" :key="cap">{{ labels[cap] }}</th></tr></thead><tbody><tr v-for="model in config.providers[modelsId]?.models || []" :key="model.id"><td>{{ model.name }}</td><td v-for="cap in capabilityIds" :key="cap" :title="model.capabilityChecks?.[cap]?.reason || '已有配置能力；自定义模型可重新检测'" :class="checkStatus(model, cap)">{{ checkStatus(model, cap) === 'supported' ? '✓' : checkStatus(model, cap) === 'unsupported' ? '—' : '?' }}</td></tr></tbody></table></div><p v-if="busyId === modelsId" class="help" role="status">{{ progress }}</p><p v-if="error" class="notice error" role="alert">{{ error }}</p></div><footer><button @click="modelsDialog?.close()">关闭</button><button v-if="catalog.find(item => item.id === modelsId)?.custom" class="primary" :disabled="!!busyId" @click="scanModels(modelsId)">重新检测全部能力</button><button v-if="scanning" @click="stopScan = true">停止检测</button></footer></dialog>

    <dialog ref="deleteDialog" aria-labelledby="delete-key-title"><header><div><p class="step-index">REMOVE CONNECTION</p><h3 id="delete-key-title">删除 API Key？</h3></div><button class="close" aria-label="关闭删除窗口" @click="deleteDialog?.close()">×</button></header><div class="dialog-body"><p>将移除「{{ providerName(deleteId) }}」在本系统保存的 Key 和模型，四项能力均停止使用此连接。</p><div class="tip"><p v-for="cap in capabilityIds" :key="cap">{{ labels[cap] }}：移除 {{ config.priorities[cap].filter(step => step.provider === deleteId).length }} 个已保存优先级步骤<span v-if="config.priorities[cap].some(step => step.provider === deleteId) && !config.priorities[cap].some(step => step.provider !== deleteId)" class="danger"> · 删除后未配置模型</span></p></div><p class="help">不会注销供应商平台的 Key。历史用量保留，可重新导入连接。</p><p v-if="error" class="notice error" role="alert">{{ error }}</p></div><footer><button @click="deleteDialog?.close()">取消</button><button class="danger-button" :disabled="!!busyId" @click="confirmDelete">确认删除</button></footer></dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { deleteAiProviderKey, detectAiModelCapabilities, discoverAiProviderModels, isAdminRequired, saveAiProviderKey } from '../api'
import type { AiCapability, AiCapabilityConfigView, AiCapabilityModel, AiProviderCatalogItem } from '../services/ai-model-api-model'
import type { ShowAdminDialog } from '../types'
import { messageFromData } from '../types'
const props = defineProps<{ config: AiCapabilityConfigView; catalog: AiProviderCatalogItem[] }>()
const emit = defineEmits<{ updated: [config: AiCapabilityConfigView, catalog?: AiProviderCatalogItem[]] }>()
const admin = inject<ShowAdminDialog>('showAdminDialog')
const capabilityIds: AiCapability[] = ['text', 'vision', 'voice-asr', 'voice-tts']
const labels: Record<AiCapability, string> = { text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成' }
const connected = computed(() => props.catalog.filter(provider => props.config.providers[provider.id]?.key.configured))
const selectedId = ref('custom-new'), editingId = ref(''), customName = ref(''), customURL = ref(''), customNote = ref(''), keyDraft = ref('')
const importDialog = ref<HTMLDialogElement>(), modelsDialog = ref<HTMLDialogElement>(), deleteDialog = ref<HTMLDialogElement>()
const busyId = ref(''), scanning = ref(false), stopScan = ref(false), progress = ref(''), message = ref(''), error = ref(''), modelsId = ref(''), deleteId = ref('')
const isCustom = computed(() => selectedId.value === 'custom-new' || !!props.catalog.find(provider => provider.id === selectedId.value)?.custom)
const selectedProvider = computed(() => props.catalog.find(provider => provider.id === selectedId.value))
let disposed = false

// --- 展示和表单 ---
// 返回目录中的供应商展示名。
function providerName(id: string): string { return props.catalog.find(provider => provider.id === id)?.name || id }
// 返回既有模型池中的配置能力，未检测的新模型不计入。
function providerCapabilities(id: string): AiCapability[] { return capabilityIds.filter(cap => props.config.providers[id]?.models.some(model => model.capabilities.includes(cap))) }
// 展示三态结果；旧自定义标签不是检测证据，需重新检测。
function checkStatus(model: AiCapabilityModel, cap: AiCapability): string {
  if (model.capabilityChecks) return model.capabilityChecks[cap].status
  if (props.catalog.find(item => item.id === modelsId.value)?.custom) return 'pending'
  return model.capabilities.includes(cap) ? 'supported' : 'pending'
}
// 打开新的或已存在连接的导入窗口；不读取旧 Key 明文。
function openImport(id = ''): void { editingId.value = id; selectedId.value = id || 'custom-new'; keyDraft.value = ''; error.value = ''; importDialog.value?.showModal() }
// 打开现有供应商的能力检测表。
function openModels(id: string): void { modelsId.value = id; error.value = ''; modelsDialog.value?.showModal() }
// 在应用级管理员验证成功后重试原操作。
function requireAdmin(message: string, retry: () => void | Promise<void>): void { if (admin) admin(message, retry); else error.value = '该操作需要管理员验证' }

// --- 导入、刷新和能力检测 ---
// 导入 Key 后直接保存统一模型池，自定义连接随后逐个模型检测全部能力。
async function submitImport(): Promise<void> {
  if (busyId.value || !keyDraft.value.trim()) return
  const id = selectedId.value, provider = props.catalog.find(item => item.id === id)
  busyId.value = id; error.value = ''; message.value = ''; progress.value = '正在导入 Key 并获取模型列表…'
  const response = isCustom.value
    ? await discoverAiProviderModels(id, keyDraft.value, { detectCapabilities: true, name: customName.value, baseURL: customURL.value, note: customNote.value })
    : provider?.discoveryAvailable ? await discoverAiProviderModels(id, keyDraft.value, { detectCapabilities: true }) : await saveAiProviderKey(id, keyDraft.value)
  busyId.value = ''
  if (isAdminRequired(response)) return requireAdmin('导入 API Key 需要管理员验证', submitImport)
  if (!response.ok || !response.data?.config) { error.value = messageFromData(response.data, 'API Key 导入失败'); return }
  const data = response.data
  emit('updated', data.config!, data.catalog); keyDraft.value = ''; importDialog.value?.close()
  message.value = 'Key 与模型已导入，四项能力共用；加入优先级后才会实际使用。'
  const importedId = 'providerId' in data ? String(data.providerId) : id
  await nextTick()
  if (isCustom.value) await scanModels(importedId, data.config!)
}
// 复用服务端 Key 刷新模型；内置受限供应商只刷新已验证的参考目录。
async function refreshProvider(id: string): Promise<void> {
  if (busyId.value) return
  const provider = props.catalog.find(item => item.id === id)!
  busyId.value = id; error.value = ''; message.value = ''; progress.value = '正在复用已保存 Key 刷新模型…'
  const response = provider.discoveryAvailable ? await discoverAiProviderModels(id, '', { detectCapabilities: true }) : await saveAiProviderKey(id, '')
  busyId.value = ''
  if (isAdminRequired(response)) return requireAdmin('刷新模型需要管理员验证', () => refreshProvider(id))
  if (!response.ok || !response.data?.config) { error.value = messageFromData(response.data, '模型刷新失败'); return }
  emit('updated', response.data.config, response.data.catalog)
  message.value = '模型列表已刷新，未要求重新输入 Key。'
  if (provider.custom) await scanModels(id, response.data.config)
}
// 串行检测模型，进度逐个更新；停止或组件销毁后不再发起后续请求。
async function scanModels(id: string, snapshot = props.config): Promise<void> {
  if (busyId.value || disposed) return
  const models = snapshot.providers[id]?.models || []
  busyId.value = id; scanning.value = true; stopScan.value = false; error.value = ''
  try {
    for (let index = 0; index < models.length && !stopScan.value && !disposed; index += 1) {
      progress.value = `${providerName(id)} · 正在检测 ${index + 1} / ${models.length}：${models[index].name}`
      const response = await detectAiModelCapabilities(id, models[index].id)
      if (disposed) return
      if (isAdminRequired(response)) { requireAdmin('检测模型需要管理员验证', () => scanModels(id)); return }
      if (!response.ok || !response.data?.config) { error.value = messageFromData(response.data, '检测失败，可重新检测'); return }
      emit('updated', response.data.config)
    }
    message.value = stopScan.value ? '已停止后续检测，已完成的结果已保存。' : '四项能力检测完成；待检测项可稍后重试，已有优先级未因暂时失败而清空。'
  } finally { busyId.value = ''; scanning.value = false }
}

// --- 删除和生命周期 ---
// 确认后移除服务端 Key 及四项能力引用，历史用量仍可查询。
async function confirmDelete(): Promise<void> {
  if (busyId.value) return
  busyId.value = deleteId.value; error.value = ''; progress.value = '正在移除 Key 和模型引用…'
  const response = await deleteAiProviderKey(deleteId.value)
  busyId.value = ''
  if (isAdminRequired(response)) return requireAdmin('删除 API Key 需要管理员验证', confirmDelete)
  if (!response.ok || !response.data?.config) { error.value = messageFromData(response.data, '删除失败，原配置已保留'); return }
  emit('updated', response.data.config, response.data.catalog); deleteDialog.value?.close(); message.value = response.data.message || 'Key 已删除，历史用量保留。'
}
// 切换供应商仅填充公开字段，任何已有 Key 均不返回表单。
watch(selectedId, id => { const provider = props.catalog.find(item => item.id === id); customName.value = provider?.custom ? provider.name : ''; customURL.value = provider?.baseURL || ''; customNote.value = provider?.note || ''; keyDraft.value = '' })
onBeforeUnmount(() => { disposed = true; stopScan.value = true; keyDraft.value = ''; importDialog.value?.close(); modelsDialog.value?.close(); deleteDialog.value?.close() })
</script>

<style scoped>
.connections { padding:24px; min-width:0; }.section-head,header { display:flex;justify-content:space-between;align-items:flex-start;gap:20px; }h3 { margin:2px 0 7px;color:var(--text); }.section-head p,header p,.help { color:var(--text3);font-size:13px;line-height:1.7; }.section-head { margin-bottom:20px; }.step-index { color:var(--accent)!important;font-size:11px!important;font-weight:900;letter-spacing:.16em; }.table-scroll { overflow:auto;border:1px solid var(--border);border-radius:11px; }table { width:100%;border-collapse:collapse;font-size:13px; }th,td { padding:16px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border);color:var(--text2); }th { font-size:12px;color:var(--text3);background:var(--hoverLight);font-weight:600; }tr:last-child td { border-bottom:0; }td small { display:block;font-size:11px;color:var(--text3);margin-top:4px; }.key-mask { font-family:monospace; }.actions,.badges { display:flex;gap:7px;align-items:center; }.badges { flex-wrap:wrap; }.badges span { color:var(--accent);background:var(--accentDim);padding:3px 7px;border-radius:5px;font-size:11px; }button { cursor:pointer;color:var(--text);background:var(--card);border:1px solid var(--border);padding:9px 14px;border-radius:8px;font:inherit;font-weight:700; }button:disabled { opacity:.45;cursor:not-allowed; }.primary { color:var(--accent);background:var(--accentDim);border-color:color-mix(in srgb,var(--accent) 45%,var(--border));white-space:nowrap; }.text-btn { padding:5px 3px;font-size:12px;border:0;background:transparent;color:var(--accent);white-space:nowrap; }.danger,.danger-button { color:var(--danger); }.danger-button { border-color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,var(--card)); }.empty { text-align:center;padding:30px;color:var(--text3); }.help { margin-top:14px; }.notice,.tip { padding:12px 14px;border-radius:8px;margin-top:14px;line-height:1.7;font-size:13px; }.tip { background:var(--hoverLight);border:1px solid var(--border);color:var(--text2); }.tip .badges { margin:10px 0; }.notice.error { color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,var(--card)); }.notice.success { color:var(--success); }.progress { display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:15px;color:var(--accent);font-size:12px;overflow-wrap:anywhere; }
dialog { width:min(640px,calc(100vw - 32px));max-height:calc(100dvh - 40px);padding:0;border:1px solid var(--border);border-radius:18px;color:var(--text);background:var(--card);box-shadow:0 25px 100px #0008; }dialog.wide { width:min(900px,calc(100vw - 32px)); }dialog[open],form { display:flex;flex-direction:column;min-height:0; }form { max-height:calc(100dvh - 42px); }dialog::backdrop { background:#000a;backdrop-filter:blur(5px); }header { padding:24px;border-bottom:1px solid var(--border);flex-shrink:0; }footer { padding:18px 24px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid var(--border);flex-shrink:0; }.dialog-body { overflow-y:auto;min-height:0;padding:22px 24px; }.close { font-size:20px;line-height:1;width:32px;height:32px;padding:0;flex-shrink:0; }.field { display:grid;gap:7px;margin-bottom:17px;color:var(--text2);font-size:13px;font-weight:700; }.field input,.field select { width:100%;min-width:0;min-height:42px;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:9px 11px;color:var(--text);font:inherit; }.form-grid { display:grid;grid-template-columns:1fr 1fr;gap:14px; }.supported { color:var(--success); }.unsupported { color:var(--text3); }.pending { color:var(--accent); }button:focus-visible,input:focus-visible,select:focus-visible { outline:2px solid var(--accent);outline-offset:3px; }
@media(max-width:760px) { .connections{padding:18px}.section-head{flex-direction:column}.form-grid{grid-template-columns:1fr;gap:0}th,td{padding:12px}.dialog-body,header{padding:18px}footer{padding:15px 18px} }
</style>
