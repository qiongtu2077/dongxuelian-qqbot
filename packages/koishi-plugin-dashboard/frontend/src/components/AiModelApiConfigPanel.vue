<template>
  <section class="ai-model-api" aria-labelledby="ai-model-api-title">
    <header class="card page-head">
      <div>
        <p class="eyebrow">AI RUNTIME</p>
        <h2 id="ai-model-api-title">AI模型与API配置</h2>
        <p>四项能力独立保存、独立调用、独立统计。模型进入优先级后才会实际使用。</p>
      </div>
      <button class="secondary-btn" type="button" :disabled="loading" @click="loadSharedConfig">刷新配置</button>
    </header>



    <p v-if="pageError" class="notice error" role="alert">{{ pageError }}</p>
    <p v-if="loading" class="card loading-state" aria-live="polite">正在读取统一配置…</p>

    <template v-else-if="config">
      <AiProviderManager :config="config" :catalog="catalog" @updated="applyProviderUpdate" />

      <section class="card section-card" aria-labelledby="priority-title">
        <div class="section-head">
          <div>
            <p class="step-index">02</p>
            <h3 id="priority-title">模型优先级调整</h3>
            <p>运行时严格从第 1 项开始，只在规定故障条件下依次降级。</p>
          </div>
          <button class="primary-btn" type="button" :disabled="savingPriority" @click="savePriority">
            {{ savingPriority ? '保存中…' : '保存优先级' }}
          </button>
        </div>

        <AiCapabilityTabs v-model="currentCapability" label="模型优先级能力" />
        <ol v-if="currentPriority.length" class="priority-list">
          <li v-for="(step, index) in currentPriority" :key="`${step.provider}:${step.model}`">
            <span class="rank" aria-hidden="true">{{ index + 1 }}</span>
            <div class="priority-copy">
              <strong>{{ modelDisplayName(step) }}</strong>
              <span>{{ providerDisplayName(step.provider) }} · {{ step.model }}</span>
            </div>
            <div class="row-actions" :aria-label="`${modelDisplayName(step)} 排序操作`">
              <button type="button" :disabled="index === 0" :aria-label="`上移 ${modelDisplayName(step)}`" @click="movePriority(index, -1)">↑</button>
              <button type="button" :disabled="index === currentPriority.length - 1" :aria-label="`下移 ${modelDisplayName(step)}`" @click="movePriority(index, 1)">↓</button>
              <button class="danger" type="button" :aria-label="`移除 ${modelDisplayName(step)}`" @click="removePriority(index)">移除</button>
            </div>
          </li>
        </ol>
        <p v-else class="empty-priority" role="status">该能力未配置模型</p>

        <div class="add-model-row">
          <label class="field">
            <span>从模型池加入</span>
            <select v-model="pendingModelKey" :disabled="!unusedModels.length" aria-label="选择要加入优先级的模型">
              <option value="">请选择模型</option>
              <option v-for="model in unusedModels" :key="`${model.provider}:${model.model}`" :value="`${model.provider}\u0000${model.model}`">
                {{ providerDisplayName(model.provider) }} · {{ model.name }}
              </option>
            </select>
          </label>
          <button class="secondary-btn" type="button" :disabled="!pendingModelKey" @click="addPriority">加入末尾</button>
        </div>
        <p v-if="priorityMessage" :class="['notice', priorityMessageType]" role="status">{{ priorityMessage }}</p>
      </section>

      <AiUsagePanel :catalog="catalog" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue'
import {
  fetchAiModelApiConfig,
  isAdminRequired,
  saveAiCapabilityPriority,
} from '../api'
import type { ShowAdminDialog } from '../types'
import { messageFromData } from '../types'
import AiUsagePanel from './AiUsagePanel.vue'
import AiProviderManager from './AiProviderManager.vue'
import AiCapabilityTabs from './AiCapabilityTabs.vue'
import {
  cloneCapabilityPriorities,
  listAvailableCapabilityModels,
} from '../services/ai-model-api-model'
import type {
  AiCapability,
  AiCapabilityConfigView,
  AiPriorityStep,
  AiProviderCatalogItem,
} from '../services/ai-model-api-model'

defineOptions({ name: 'AiModelApiConfigPanel' })

const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const capabilityLabels: Record<AiCapability, string> = { text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成' }
const currentCapability = ref<AiCapability>('text')
const loading = ref(false)
const loaded = ref(false)
const pageError = ref('')
const catalog = ref<AiProviderCatalogItem[]>([])
const config = ref<AiCapabilityConfigView | null>(null)
const priorities = ref<AiCapabilityConfigView['priorities'] | null>(null)

const pendingModelKey = ref('')
const savingPriority = ref(false)
const priorityMessage = ref('')
const priorityMessageType = ref<'success' | 'error'>('success')

const capabilityLabel = computed(() => capabilityLabels[currentCapability.value])
const currentPriority = computed(() => priorities.value?.[currentCapability.value] || [])
const availableModels = computed(() => config.value ? listAvailableCapabilityModels(config.value, currentCapability.value) : [])
const unusedModels = computed(() => {
  const used = new Set(currentPriority.value.map(step => `${step.provider}\u0000${step.model}`))
  return availableModels.value.filter(model => !used.has(`${model.provider}\u0000${model.model}`))
})


// --- 共享配置与供应商导入 ---

// 将管理员验证要求交给应用级弹窗，并在验证成功后重试原操作。
function requestAdmin(message: string, retry: () => void | Promise<void>): void {
  if (showAdminDialog) showAdminDialog(message, retry)
  else pageError.value = '该操作需要管理员验证'
}

// 用服务端配置替换页面快照和四条可编辑优先级。
function applyConfig(next: AiCapabilityConfigView): void {
  config.value = next
  priorities.value = cloneCapabilityPriorities(next.priorities)
  pendingModelKey.value = ''
}

// 首次读取共享目录和配置；KeepAlive 再激活不会重复触发 onMounted。
async function loadSharedConfig(): Promise<void> {
  loading.value = true
  pageError.value = ''
  const response = await fetchAiModelApiConfig()
  loading.value = false
  if (isAdminRequired(response)) return requestAdmin('查看 AI 模型与 API 配置需要管理员密码', loadSharedConfig)
  if (!response.ok || !response.data?.config) {
    pageError.value = messageFromData(response.data, '统一 AI 配置读取失败')
    return
  }
  catalog.value = Array.isArray(response.data.catalog) ? response.data.catalog : []
  applyConfig(response.data.config)
  loaded.value = true
}

// 合并连接操作后的服务端快照，保留其他能力尚未保存且仍然有效的编辑。
function applyProviderUpdate(next: AiCapabilityConfigView, nextCatalog?: AiProviderCatalogItem[]): void {
  if (nextCatalog) catalog.value = nextCatalog
  config.value = next
  if (!priorities.value) priorities.value = cloneCapabilityPriorities(next.priorities)
  for (const capability of next.capabilities) {
    priorities.value[capability] = priorities.value[capability].filter(step => next.providers[step.provider]?.key.configured && next.providers[step.provider].models.some(model => model.id === step.model && model.capabilities.includes(capability)))
  }
}

// --- 模型优先级 ---

// 返回供应商展示名。
function providerDisplayName(providerId: string): string {
  return catalog.value.find(item => item.id === providerId)?.name || providerId
}

// 返回优先级步骤的模型展示名。
function modelDisplayName(step: AiPriorityStep): string {
  return config.value?.providers[step.provider]?.models.find(model => model.id === step.model)?.name || step.model
}

// 上移或下移一个优先级步骤。
function movePriority(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= currentPriority.value.length) return
  const list = currentPriority.value
  const [step] = list.splice(index, 1)
  list.splice(target, 0, step)
  priorityMessage.value = ''
}

// 从当前能力优先级移除一个步骤。
function removePriority(index: number): void {
  currentPriority.value.splice(index, 1)
  priorityMessage.value = ''
}

// 把模型池中选择的模型加入当前能力链末尾。
function addPriority(): void {
  const [provider, model] = pendingModelKey.value.split('\u0000')
  if (!provider || !model) return
  currentPriority.value.push({ provider, model })
  pendingModelKey.value = ''
  priorityMessage.value = ''
}

// 独立保存当前能力优先级，其他能力保持页面中的未保存编辑状态。
async function savePriority(): Promise<void> {
  savingPriority.value = true
  priorityMessage.value = ''
  const capability = currentCapability.value
  const response = await saveAiCapabilityPriority(capability, currentPriority.value)
  savingPriority.value = false
  if (isAdminRequired(response)) return requestAdmin('保存模型优先级需要管理员密码', savePriority)
  if (!response.ok || !response.data?.config) {
    priorityMessageType.value = 'error'
    priorityMessage.value = messageFromData(response.data, '优先级保存失败')
    return
  }
  const saved = response.data.config.priorities[capability] || []
  if (priorities.value) priorities.value[capability] = saved.map(step => ({ ...step }))
  config.value = response.data.config
  priorityMessageType.value = 'success'
  priorityMessage.value = response.data.message || '模型优先级已保存'
}

// --- 页面生命周期 ---

watch(currentCapability, () => {
  pendingModelKey.value = ''
  priorityMessage.value = ''
})



onMounted(loadSharedConfig)
</script>

<style scoped>
.ai-model-api { display: grid; gap: 16px; min-width: 0; }
.card { min-width: 0; }
.page-head, .section-head { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
.page-head { padding: 24px; }
.page-head h2, .section-head h3 { margin: 2px 0 6px; color: var(--text); }
.page-head p, .section-head p, .empty-copy { color: var(--text3); line-height: 1.6; }
.eyebrow, .step-index { color: var(--accent) !important; font-size: 12px; font-weight: 900; letter-spacing: .16em; }
.capability-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 6px; gap: 6px; }
.capability-tabs button, .voice-tabs button { min-height: 42px; border: 1px solid transparent; border-radius: 8px; color: var(--text2); background: transparent; font: inherit; font-weight: 800; cursor: pointer; }
.capability-tabs button.active, .voice-tabs button.active { color: var(--text); border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: color-mix(in srgb, var(--accent) 17%, var(--card)); }
.voice-tabs { display: flex; gap: 8px; padding-left: 6px; }
.voice-tabs button { min-width: 120px; padding: 0 16px; border-color: var(--border); background: var(--card); }
.section-card { padding: 24px; }
.section-head { margin-bottom: 20px; }
.capability-badge, .status-dot { display: inline-flex; align-items: center; min-height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 850; white-space: nowrap; }
.capability-badge { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.provider-layout { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(0, 1.2fr); gap: 16px; align-items: end; }
.custom-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.discover-btn { margin-top: 14px; }
.field { display: grid; gap: 7px; min-width: 0; color: var(--text2); font-size: 13px; font-weight: 760; }
.field input, .field select { width: 100%; min-width: 0; min-height: 42px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; color: var(--text); background: var(--input); font: inherit; }
.field small { color: var(--text3); font-weight: 600; line-height: 1.5; }
.key-field { margin-top: 16px; }
.provider-summary { min-height: 42px; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--hoverLight); }
.provider-summary > div { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.provider-summary a { color: var(--accent); font-size: 13px; }
.status-dot.ready { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
.status-dot.manual { color: var(--accent); background: var(--accentDim); }
.blocked-reason, .field-error, .field-success, .notice, .token-unavailable { margin-top: 12px; padding: 11px 13px; border-radius: 8px; line-height: 1.5; }
.blocked-reason { color: var(--text2); background: var(--hoverLight); border: 1px solid var(--border); }
.field-error, .notice.error { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 38%, var(--border)); }
.field-success, .notice.success { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border)); }
.model-pool { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
.model-pool h4 { margin-bottom: 10px; color: var(--text); }
.model-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.model-chips span { max-width: 100%; overflow-wrap: anywhere; padding: 6px 9px; border-radius: 7px; color: var(--text2); background: var(--hover); font-size: 12px; font-weight: 750; }
.primary-btn, .secondary-btn, .row-actions button { min-height: 38px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 8px; padding: 0 14px; color: var(--text); background: color-mix(in srgb, var(--accent) 16%, var(--card)); font: inherit; font-weight: 800; cursor: pointer; }
.secondary-btn { background: var(--card); }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 65%, transparent); outline-offset: 2px; }
.priority-list { display: grid; gap: 9px; list-style: none; }
.priority-list li { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-width: 0; padding: 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--hoverLight); }
.rank { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: var(--accent); background: var(--accentDim); font-weight: 900; }
.priority-copy { display: grid; min-width: 0; }
.priority-copy strong, .priority-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.priority-copy span { color: var(--text3); font-size: 12px; }
.row-actions { display: flex; gap: 6px; }
.row-actions button { min-width: 38px; padding: 0 10px; }
.row-actions .danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 38%, var(--border)); background: color-mix(in srgb, var(--danger) 9%, var(--card)); }
.empty-priority, .token-unavailable, .loading-state { padding: 24px; text-align: center; color: var(--text3); border: 1px dashed var(--border); border-radius: 8px; }
.token-unavailable { color: var(--danger); }
.add-model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; margin-top: 16px; }

@media (max-width: 760px) {
  .page-head, .section-head { flex-direction: column; }
  .page-head, .section-card { padding: 18px; }
  .provider-layout, .custom-fields, .add-model-row { grid-template-columns: 1fr; }
  .priority-list li { grid-template-columns: 32px minmax(0, 1fr); }
  .row-actions { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .provider-summary { align-items: flex-start; }
  .voice-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding-left: 0; }
  .voice-tabs button { min-width: 0; }
}
</style>
