<template>
  <div>
    <div class="card">
      <h2>供应商和模型</h2>
      <div class="row">
        <label>供应商</label>
        <SelectBox v-model="selectedProvider" :options="providerOptions" @change="onProviderChange" />
      </div>
      <div class="row">
        <label>模型</label>
        <SelectBox v-model="selectedModel" :options="currentModelOptions" />
      </div>
      <div class="row">
        <label>API 地址</label>
        <input v-model="baseUrl" placeholder="留空使用默认" />
      </div>
      <button class="btn" @click="saveConfig" :disabled="saving">{{ saving ? '保存中...' : '保存配置' }}</button>
      <div v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</div>
    </div>

    <div class="card">
      <h2>自定义供应商</h2>
      <div v-for="(cp, ci) in customProviders" :key="ci" class="grp" style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:8px">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <input v-model="cp.id" placeholder="标识" style="width:100px" />
          <input v-model="cp.name" placeholder="名称" style="width:120px" />
          <input v-model="cp.baseURL" placeholder="https://..." style="flex:1;min-width:140px" />
          <input v-model="cp.keyFile" placeholder="key文件(可选)" style="width:140px" />
          <button class="btn-sm" @click="removeCustomProvider(ci)" style="background:transparent;border:1px solid var(--danger);color:var(--danger)">✕</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <div v-for="(m, mi) in cp.models" :key="mi" style="display:flex;gap:4px;align-items:center">
            <input v-model="m.id" placeholder="模型ID" style="width:100px" />
            <label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:2px">
              <input type="checkbox" v-model="m.vision" /> 视觉
            </label>
            <button v-if="cp.models.length > 1" class="btn-sm" @click="cp.models.splice(mi,1)" style="background:transparent;border:1px solid var(--danger);color:var(--danger);font-size:11px;padding:0 4px">✕</button>
          </div>
          <button class="btn-sm" @click="cp.models.push({ id: '', vision: false })" style="background:transparent;border:1px solid var(--accent);color:var(--accent);font-size:11px">+模型</button>
        </div>
      </div>
      <button class="btn-sm" @click="addCustomProvider" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">+ 添加供应商</button>
      <button class="btn" @click="saveCustomProvidersAction" :disabled="savingCustom" style="margin-left:8px">{{ savingCustom ? '保存中...' : '保存自定义供应商' }}</button>
      <div v-if="customMsg" class="msg" :class="customMsg.type">{{ customMsg.text }}</div>
    </div>

    <div v-for="fc in fallbackCards" :key="fc.key" class="card">
      <h2>{{ fc.label }}</h2>
      <div style="font-size:13px;color:var(--text3);margin-bottom:8px">{{ fc.desc }}</div>

      <div v-if="fc.showMainFirst" style="font-size:12px;color:var(--text2);padding:4px 8px;background:var(--tabBg);border-radius:4px;margin-bottom:8px">
        优先使用 → 主模型（用户配置）
      </div>

      <div v-for="(step, si) in (fallbackChains[fc.key] || [])" :key="si" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <SelectBox v-model="step.provider" :options="allProviderOptions" style="width:120px" @change="onFbProviderChange(fc.key, si)" />
        <SelectBox v-model="step.model" :options="fallbackModelOptions(step.provider)" style="width:140px" />
        <button class="btn-sm" @click="removeFallbackStep(fc.key, si)" style="background:transparent;border:1px solid var(--danger);color:var(--danger);font-size:11px;padding:0 4px">✕</button>
      </div>
      <button class="btn-sm" @click="addFallbackStep(fc.key)" style="background:transparent;border:1px solid var(--accent);color:var(--accent);font-size:11px">+ 添加步骤</button>

      <div v-if="fc.showMainLast" style="font-size:12px;color:var(--text2);padding:4px 8px;background:var(--tabBg);border-radius:4px;margin-top:8px">
        最后兜底 → 主模型（不可编辑）
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-sm" @click="resetFallbackCard(fc.key)" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">重置为默认</button>
      </div>
    </div>

    <div class="card">
      <button class="btn" @click="saveFallback" :disabled="savingFallback">{{ savingFallback ? '保存中...' : '保存全部备用链' }}</button>
      <div v-if="fallbackMsg" class="msg" :class="fallbackMsg.type" style="margin-top:8px">{{ fallbackMsg.text }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted } from 'vue'
import { fetchConfig, fetchProviders, updateConfig, fetchFallbackChains, saveFallbackChains, fetchCustomProviders, saveCustomProviders } from '../api'
import type { CustomProvider, FallbackChains, MessageState, ProviderInfo, ProviderModel, ShowAdminDialog } from '../types'
import { errorMessage, messageFromData } from '../types'
import SelectBox from './SelectBox.vue'

type FallbackKey = 'chat' | 'vision' | 'lightweight'

interface FallbackCard {
  key: FallbackKey
  label: string
  desc: string
  showMainFirst: boolean
  showMainLast: boolean
}

const FALLBACK_CARDS: FallbackCard[] = [
  { key: 'chat', label: '聊天 Fallback', desc: '主聊天、吐槽我、帮我说话', showMainFirst: true, showMainLast: true },
  { key: 'vision', label: '视觉 Fallback', desc: '多模态 / 识图调用', showMainFirst: true, showMainLast: true },
  { key: 'lightweight', label: '轻量功能 Fallback', desc: '反击打分、摘要、敏感检测、话题切换、越狱回复、今日情绪、评价总结', showMainFirst: false, showMainLast: false },
]

defineOptions({ name: 'ConfigPanel' })

    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const providers = ref<Record<string, ProviderInfo>>({})
    const selectedProvider = ref('deepseek')
    const selectedModel = ref('')
    const baseUrl = ref('')
    const saving = ref(false)
    const msg = ref<MessageState | null>(null)

    const customProviders = ref<CustomProvider[]>([])
    const savingCustom = ref(false)
    const customMsg = ref<MessageState | null>(null)

    const fallbackChains = ref<FallbackChains>({})
    const defaultFallback = ref<FallbackChains>({})
    const allProviders = ref<Record<string, ProviderInfo>>({})
    const savingFallback = ref(false)
    const fallbackMsg = ref<MessageState | null>(null)

    const currentModels = computed(() => {
      const p = providers.value[selectedProvider.value]
      return p ? p.models : []
    })
    const providerOptions = computed(() => Object.entries(providers.value).map(([value, provider]) => ({ value, label: provider.name })))
    const currentModelOptions = computed(() => currentModels.value.map(model => ({ value: model.id, label: model.name || model.id })))
    const allProviderOptions = computed(() => [
      { value: '', label: '供应商', disabled: true },
      ...Object.entries(allProviders.value).map(([value, provider]) => ({ value, label: provider.name })),
    ])
    function fallbackModelOptions(provider: string) {
      return [
        { value: '', label: '模型', disabled: true },
        ...((allProviders.value[provider]?.models || []).map(model => ({ value: model.id, label: `${model.name || model.id}${model.vision ? ' 👁' : ''}` }))),
      ]
    }

    const fallbackCards = computed<FallbackCard[]>(() => FALLBACK_CARDS)

    function buildAllProviders() {
      const allP: Record<string, ProviderInfo> = Object.assign({}, providers.value)
      for (const cp of customProviders.value) {
        if (cp.id && cp.name) {
          const models = Array.isArray(cp.models)
            ? cp.models.map(function(m: ProviderModel | string) {
                if (typeof m === 'object' && m !== null) return m
                return { id: String(m).trim(), vision: false }
              }).filter(function(m) { return m.id })
            : []
          allP[cp.id] = { name: cp.name, baseURL: cp.baseURL, models: models }
        }
      }
      allProviders.value = allP
    }

    onMounted(async () => {
      try {
        const [pRes, cRes, fRes, cpRes] = await Promise.all([
          fetchProviders(), fetchConfig(), fetchFallbackChains(), fetchCustomProviders()
        ])
        if (pRes.ok && pRes.data) providers.value = pRes.data
        if (cRes.ok && cRes.data) {
          selectedProvider.value = cRes.data.provider || 'deepseek'
          selectedModel.value = cRes.data.model || ''
          baseUrl.value = cRes.data.baseUrl || ''
        }
        if (fRes.ok && fRes.data) {
          fallbackChains.value = fRes.data.chains || {}
          defaultFallback.value = fRes.data.defaults || {}
        }
        if (cpRes.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('查看自定义供应商需要管理员密码', () => loadCustomProviders()) }
        else if (cpRes.ok) {
          const raw = cpRes.data || []
          customProviders.value = raw.map(function(cp) {
            return Object.assign({}, cp, {
              models: Array.isArray(cp.models)
                ? cp.models.map(function(m: ProviderModel | string) {
                    if (typeof m === 'object' && m !== null) return Object.assign({}, m)
                    return { id: String(m).trim(), vision: false }
                  })
                : []
            })
        })
      }
      buildAllProviders()
      } catch (e) {
        console.error('[ConfigPanel] load failed:', e)
      }
    })

    async function loadCustomProviders() {
      const cpRes = await fetchCustomProviders()
      if (cpRes.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('查看自定义供应商需要管理员密码', loadCustomProviders); return }
      if (cpRes.ok) {
        customProviders.value = (cpRes.data || []).map(cp => Object.assign({}, cp, { models: Array.isArray(cp.models) ? cp.models.map((m: ProviderModel | string) => typeof m === 'object' && m !== null ? Object.assign({}, m) : { id: String(m), name: String(m), vision: false }) : [] }))
        buildAllProviders()
      }
    }

    function onProviderChange() {
      const models = currentModels.value
      if (models.length && !models.find(function(m) { return m.id === selectedModel.value })) {
        selectedModel.value = models[0].id
      }
    }

    async function saveConfig() {
      saving.value = true; msg.value = null
      try {
        const res = await updateConfig({
          provider: selectedProvider.value,
          model: selectedModel.value,
          baseUrl: baseUrl.value || undefined,
        })
        if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('修改配置需要管理员密码', saveConfig); saving.value = false; return }
        if (res.ok) msg.value = { type: 'ok', text: '配置已保存并热加载' }
        else msg.value = { type: 'err', text: res.data?.message || '保存失败' }
      } catch (e) { msg.value = { type: 'err', text: errorMessage(e) } }
      saving.value = false
    }

    function addCustomProvider() {
      customProviders.value.push({ id: '', name: '', baseURL: '', keyFile: '', models: [{ id: '', vision: false }] })
    }
    function removeCustomProvider(idx: number) {
      customProviders.value.splice(idx, 1)
    }

    function normalizeCustomProvider(cp: CustomProvider): CustomProvider {
      return {
        id: String(cp.id || '').trim(),
        name: String(cp.name || '').trim(),
        baseURL: String(cp.baseURL || '').trim(),
        keyFile: String(cp.keyFile || '').trim(),
        models: Array.isArray(cp.models)
          ? cp.models.map(function(m: ProviderModel | string) {
              const id = typeof m === 'object' && m !== null ? String(m.id || '').trim() : String(m).trim()
              const vision = typeof m === 'object' && m !== null ? !!m.vision : false
              return { id: id, vision: vision }
            }).filter(function(m) { return m.id })
          : []
      }
    }

    async function saveCustomProvidersAction() {
      savingCustom.value = true; customMsg.value = null
      const cleaned = customProviders.value.map(normalizeCustomProvider).filter(function(cp) { return cp.id && cp.name })
      const res = await saveCustomProviders(cleaned)
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('保存自定义供应商需要管理员密码', saveCustomProvidersAction); savingCustom.value = false; return }
      if (res.ok) {
        customProviders.value = cleaned.map(function(cp) {
          return Object.assign({}, cp, { models: cp.models.map(function(m) { return Object.assign({}, m) }) })
        })
        customMsg.value = { type: 'ok', text: '自定义供应商已保存' }
        buildAllProviders()
      } else {
        customMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
      }
      savingCustom.value = false
    }

    function onFbProviderChange(purpose: FallbackKey, idx: number) {
      const step = (fallbackChains.value[purpose] || [])[idx]
      if (!step) return
      step.model = ''
    }

    function addFallbackStep(purpose: FallbackKey) {
      if (!fallbackChains.value[purpose]) fallbackChains.value[purpose] = []
      fallbackChains.value[purpose].push({ provider: '', model: '', keyFile: '' })
    }

    function removeFallbackStep(purpose: FallbackKey, idx: number) {
      fallbackChains.value[purpose].splice(idx, 1)
    }

    function resetFallbackCard(key: FallbackKey) {
      fallbackChains.value[key] = JSON.parse(JSON.stringify(defaultFallback.value[key] || []))
      fallbackMsg.value = { type: 'warn', text: '已恢复默认，尚未保存' }
    }

    async function saveFallback() {
      savingFallback.value = true; fallbackMsg.value = null
      const chains: FallbackChains = {}
      for (let _i = 0; _i < FALLBACK_CARDS.length; _i++) {
        const fc = FALLBACK_CARDS[_i]
        chains[fc.key] = fallbackChains.value[fc.key] || []
      }
      const res = await saveFallbackChains(chains)
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('保存 Fallback 链需要管理员密码', saveFallback); savingFallback.value = false; return }
      if (res.ok) fallbackMsg.value = { type: 'ok', text: 'Fallback 链已保存' }
      else fallbackMsg.value = { type: 'err', text: messageFromData(res.data, '保存失败') }
      savingFallback.value = false
    }

</script>
