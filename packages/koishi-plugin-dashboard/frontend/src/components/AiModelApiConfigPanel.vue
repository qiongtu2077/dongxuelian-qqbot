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

    <nav class="capability-tabs card" aria-label="AI 能力">
      <button
        v-for="tab in topTabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeTopTab === tab.id }"
        :aria-current="activeTopTab === tab.id ? 'page' : undefined"
        @click="activeTopTab = tab.id"
      >{{ tab.label }}</button>
    </nav>

    <nav v-if="activeTopTab === 'voice'" class="voice-tabs" aria-label="语音能力">
      <button
        v-for="tab in voiceTabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeVoiceTab === tab.id }"
        :aria-pressed="activeVoiceTab === tab.id"
        @click="activeVoiceTab = tab.id"
      >{{ tab.label }}</button>
    </nav>

    <p v-if="pageError" class="notice error" role="alert">{{ pageError }}</p>
    <p v-if="loading" class="card loading-state" aria-live="polite">正在读取统一配置…</p>

    <template v-else-if="config">
      <section class="card section-card" aria-labelledby="provider-import-title">
        <div class="section-head">
          <div>
            <p class="step-index">01</p>
            <h3 id="provider-import-title">AI 供应商导入</h3>
            <p>选择固定目录中的供应商，在 Key 输入框失焦后自动发现并原子保存模型池。</p>
          </div>
          <span class="capability-badge">{{ capabilityLabel }}</span>
        </div>

        <div class="provider-layout">
          <label class="field">
            <span>供应商</span>
            <select v-model="selectedProviderId" aria-label="选择 AI 供应商">
              <option v-for="provider in catalog" :key="provider.id" :value="provider.id">
                {{ provider.name }}{{ provider.discoveryAvailable ? '' : '（暂不可发现）' }}
              </option>
            </select>
          </label>

          <div v-if="selectedProvider" class="provider-summary">
            <div>
              <strong>{{ selectedProvider.name }}</strong>
              <span :class="['status-dot', selectedProvider.discoveryAvailable ? 'ready' : 'blocked']">
                {{ selectedProvider.discoveryAvailable ? '可发现模型' : '发现受阻' }}
              </span>
            </div>
            <a :href="selectedProvider.documentationURL" target="_blank" rel="noreferrer">官方文档</a>
          </div>
        </div>

        <p v-if="selectedProvider && !selectedProvider.discoveryAvailable" class="blocked-reason" role="status">
          {{ selectedProvider.discoveryReason }}
        </p>

        <label class="field key-field">
          <span>API Key</span>
          <input
            v-model="keyDrafts[selectedProviderId]"
            type="password"
            autocomplete="off"
            :disabled="!selectedProvider?.discoveryAvailable || discoveringProvider === selectedProviderId"
            :placeholder="providerKeyPlaceholder"
            aria-describedby="provider-key-help"
            @blur="discoverSelectedProvider"
            @keydown.enter.prevent="discoverSelectedProvider"
          />
          <small id="provider-key-help">
            {{ discoveringProvider === selectedProviderId ? '正在调用已验证的官方枚举接口…' : '输入只在本次发现请求中使用；成功后前端立即清空。' }}
          </small>
        </label>

        <p v-if="providerErrors[selectedProviderId]" class="field-error" role="alert">{{ providerErrors[selectedProviderId] }}</p>
        <p v-if="providerMessages[selectedProviderId]" class="field-success" role="status">{{ providerMessages[selectedProviderId] }}</p>

        <div class="model-pool" aria-live="polite">
          <h4>{{ capabilityLabel }}可用模型池</h4>
          <div v-if="selectedProviderCapabilityModels.length" class="model-chips">
            <span v-for="model in selectedProviderCapabilityModels" :key="model.id">{{ model.name || model.id }}</span>
          </div>
          <p v-else class="empty-copy">当前供应商尚无兼容模型。发现成功后，模型会先进入这里。</p>
        </div>
      </section>

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

      <section class="card section-card" aria-labelledby="usage-title">
        <div class="section-head">
          <div>
            <p class="step-index">03</p>
            <h3 id="usage-title">模型用量</h3>
            <p>这里只展示 {{ capabilityLabel }} 的新记录；无能力标识的历史数据不会推断归类。</p>
          </div>
          <button class="secondary-btn" type="button" :disabled="loadingUsage" @click="loadUsage">
            {{ loadingUsage ? '加载中…' : '刷新用量' }}
          </button>
        </div>

        <p v-if="usageError" class="notice error" role="alert">{{ usageError }}</p>
        <p v-else-if="usage?.unavailable" class="token-unavailable" role="status">无法读取模型 Token 用量</p>
        <template v-else-if="usage">
          <div class="usage-metrics">
            <div><span>请求次数</span><strong>{{ formatNumber(usageRequests) }}</strong></div>
            <div><span>Token 总量</span><strong>{{ usage.readable ? formatNumber(usageTotal) : '—' }}</strong></div>
            <div><span>供应商</span><strong>{{ usage.providers.length }}</strong></div>
            <div><span>模型</span><strong>{{ usage.models.length }}</strong></div>
          </div>

          <div v-if="usage.providers.length || usage.models.length" class="usage-tables">
            <div>
              <h4>供应商分布</h4>
              <table>
                <thead><tr><th>供应商</th><th>请求</th><th>Token</th></tr></thead>
                <tbody>
                  <tr v-for="row in usage.providers" :key="row.key">
                    <td>{{ providerDisplayName(row.key) }}</td><td>{{ formatNumber(row.requests) }}</td><td>{{ formatNumber(row.total) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4>模型分布</h4>
              <table>
                <thead><tr><th>模型</th><th>请求</th><th>Token</th></tr></thead>
                <tbody>
                  <tr v-for="row in usage.models" :key="row.key">
                    <td>{{ row.label || row.key }}</td><td>{{ formatNumber(row.requests) }}</td><td>{{ formatNumber(row.total) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <p v-else class="empty-copy">当前能力还没有新的用量记录。</p>
        </template>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, watch } from 'vue'
import {
  discoverAiProviderModels,
  fetchAiCapabilityUsage,
  fetchAiModelApiConfig,
  isAdminRequired,
  saveAiCapabilityPriority,
} from '../api'
import type { ShowAdminDialog } from '../types'
import { messageFromData } from '../types'
import {
  cloneCapabilityPriorities,
  listAvailableCapabilityModels,
} from '../services/ai-model-api-model'
import type {
  AiCapability,
  AiCapabilityConfigView,
  AiPriorityStep,
  AiProviderCatalogItem,
  CapabilityUsageResponse,
} from '../services/ai-model-api-model'

defineOptions({ name: 'AiModelApiConfigPanel' })

type TopTab = 'text' | 'vision' | 'voice'

const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const topTabs: Array<{ id: TopTab; label: string }> = [
  { id: 'text', label: '文字' },
  { id: 'vision', label: '识图' },
  { id: 'voice', label: '语音' },
]
const voiceTabs: Array<{ id: 'voice-asr' | 'voice-tts'; label: string }> = [
  { id: 'voice-asr', label: '语音识别' },
  { id: 'voice-tts', label: '语音合成' },
]
const capabilityLabels: Record<AiCapability, string> = {
  text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成',
}

const activeTopTab = ref<TopTab>('text')
const activeVoiceTab = ref<'voice-asr' | 'voice-tts'>('voice-asr')
const loading = ref(false)
const loaded = ref(false)
const pageError = ref('')
const catalog = ref<AiProviderCatalogItem[]>([])
const config = ref<AiCapabilityConfigView | null>(null)
const priorities = ref<AiCapabilityConfigView['priorities'] | null>(null)
const selectedProviderId = ref('')
const keyDrafts = reactive<Record<string, string>>({})
const providerErrors = reactive<Record<string, string>>({})
const providerMessages = reactive<Record<string, string>>({})
const discoveringProvider = ref('')
const pendingModelKey = ref('')
const savingPriority = ref(false)
const priorityMessage = ref('')
const priorityMessageType = ref<'success' | 'error'>('success')
const usage = ref<CapabilityUsageResponse | null>(null)
const usageError = ref('')
const loadingUsage = ref(false)
let usageRequestId = 0

const currentCapability = computed<AiCapability>(() => activeTopTab.value === 'voice' ? activeVoiceTab.value : activeTopTab.value)
const capabilityLabel = computed(() => capabilityLabels[currentCapability.value])
const selectedProvider = computed(() => catalog.value.find(item => item.id === selectedProviderId.value) || null)
const currentPriority = computed(() => priorities.value?.[currentCapability.value] || [])
const availableModels = computed(() => config.value ? listAvailableCapabilityModels(config.value, currentCapability.value) : [])
const unusedModels = computed(() => {
  const used = new Set(currentPriority.value.map(step => `${step.provider}\u0000${step.model}`))
  return availableModels.value.filter(model => !used.has(`${model.provider}\u0000${model.model}`))
})
const selectedProviderCapabilityModels = computed(() => {
  const state = config.value?.providers[selectedProviderId.value]
  return (state?.models || []).filter(model => model.capabilities.includes(currentCapability.value))
})
const providerKeyPlaceholder = computed(() => {
  const state = config.value?.providers[selectedProviderId.value]
  return state?.key?.configured ? `已保存 ${state.key.prefix}，输入新 Key 可替换` : '输入 API Key，失焦后自动发现'
})
const usageTotal = computed(() => (usage.value?.days || []).reduce((sum, day) => sum + Number(day.total || 0), 0))
const usageRequests = computed(() => (usage.value?.days || []).reduce((sum, day) => sum + Number(day.requests || 0), 0))

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
  if (!selectedProviderId.value || !catalog.value.some(item => item.id === selectedProviderId.value)) selectedProviderId.value = catalog.value[0]?.id || ''
  loaded.value = true
  await loadUsage()
}

// 在 Key 失焦或回车时调用发现接口；失败保留输入，成功立即清空明文。
async function discoverSelectedProvider(): Promise<void> {
  const providerId = selectedProviderId.value
  const provider = selectedProvider.value
  const apiKey = String(keyDrafts[providerId] || '').trim()
  if (!provider?.discoveryAvailable || !apiKey || discoveringProvider.value) return
  providerErrors[providerId] = ''
  providerMessages[providerId] = ''
  discoveringProvider.value = providerId
  const response = await discoverAiProviderModels(providerId, apiKey)
  discoveringProvider.value = ''
  if (isAdminRequired(response)) return requestAdmin('发现并保存模型需要管理员密码', discoverSelectedProvider)
  if (!response.ok || !response.data?.config) {
    providerErrors[providerId] = messageFromData(response.data, '模型发现失败')
    return
  }
  keyDrafts[providerId] = ''
  applyConfig(response.data.config)
  providerMessages[providerId] = `${response.data.message || '模型池已保存'}；移除 ${response.data.removedModels || 0} 个旧模型、${response.data.removedSteps || 0} 个失效优先级步骤。`
}

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

// 读取当前能力用量，并用请求序号丢弃快速切换产生的过期响应。
async function loadUsage(): Promise<void> {
  if (!loaded.value) return
  const capability = currentCapability.value
  const requestId = ++usageRequestId
  loadingUsage.value = true
  usageError.value = ''
  usage.value = null
  const response = await fetchAiCapabilityUsage(capability)
  if (requestId !== usageRequestId) return
  loadingUsage.value = false
  if (isAdminRequired(response)) return requestAdmin('查看模型用量需要管理员密码', loadUsage)
  if (!response.ok || !response.data) {
    usageError.value = messageFromData(response.data, '模型用量读取失败')
    return
  }
  usage.value = response.data
}

// 格式化非负统计数值。
function formatNumber(value: unknown): string {
  const number = Number(value || 0)
  return Number.isFinite(number) ? Math.max(0, number).toLocaleString('zh-CN') : '0'
}

watch(currentCapability, () => {
  pendingModelKey.value = ''
  priorityMessage.value = ''
  if (loaded.value) void loadUsage()
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
.field { display: grid; gap: 7px; min-width: 0; color: var(--text2); font-size: 13px; font-weight: 760; }
.field input, .field select { width: 100%; min-width: 0; min-height: 42px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; color: var(--text); background: var(--input); font: inherit; }
.field small { color: var(--text3); font-weight: 600; line-height: 1.5; }
.key-field { margin-top: 16px; }
.provider-summary { min-height: 42px; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--hoverLight); }
.provider-summary > div { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.provider-summary a { color: var(--accent); font-size: 13px; }
.status-dot.ready { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
.status-dot.blocked { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.blocked-reason, .field-error, .field-success, .notice, .token-unavailable { margin-top: 12px; padding: 11px 13px; border-radius: 8px; line-height: 1.5; }
.blocked-reason { color: var(--text2); background: var(--hoverLight); border: 1px solid var(--border); }
.field-error, .notice.error { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 38%, var(--border)); }
.field-success, .notice.success { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border)); }
.model-pool { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
.model-pool h4, .usage-tables h4 { margin-bottom: 10px; color: var(--text); }
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
.usage-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.usage-metrics div { display: grid; gap: 4px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--hoverLight); }
.usage-metrics span { color: var(--text3); font-size: 12px; }
.usage-metrics strong { color: var(--text); font-size: 20px; }
.usage-tables { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 20px; min-width: 0; }
.usage-tables > div { min-width: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; color: var(--text2); font-size: 13px; }
th, td { padding: 9px 7px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }

@media (max-width: 760px) {
  .page-head, .section-head { flex-direction: column; }
  .page-head, .section-card { padding: 18px; }
  .provider-layout, .usage-tables, .add-model-row { grid-template-columns: 1fr; }
  .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .priority-list li { grid-template-columns: 32px minmax(0, 1fr); }
  .row-actions { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .provider-summary { align-items: flex-start; }
  .voice-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding-left: 0; }
  .voice-tabs button { min-width: 0; }
}
</style>
