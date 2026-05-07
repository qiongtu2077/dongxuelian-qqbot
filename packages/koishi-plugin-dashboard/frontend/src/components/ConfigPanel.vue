<template>
  <div>
    <div class="card">
      <h2>供应商和模型</h2>
      <div class="row">
        <label>供应商</label>
        <SelectBox v-model="selectedProvider" :options="providerOpts" @update:modelValue="onProviderChange" />
      </div>
      <div class="row">
        <label>模型</label>
        <SelectBox v-model="selectedModel" :options="modelOpts" />
      </div>
      <div class="row">
        <label>API 地址</label>
        <input v-model="baseUrl" placeholder="留空使用默认" />
      </div>
      <button class="btn" @click="saveConfig" :disabled="saving">{{ saving ? '保存中...' : '保存配置' }}</button>
      <div v-if="configMsg" class="msg" :class="configMsg.type">{{ configMsg.text }}</div>
    </div>

    <div class="card">
      <h2>自定义供应商</h2>
      <div style="font-size:13px;color:var(--text3);margin-bottom:12px">添加自定义 AI 供应商，保存后可在上方的供应商列表中选择</div>
      <div v-for="(p, i) in customProviders" :key="i" class="grp">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input v-model="p.id" placeholder="标识（如 my-ai）" style="width:180px;font-family:monospace" />
          <input v-model="p.name" placeholder="显示名称" style="width:140px" />
          <input v-model="p.baseURL" placeholder="API 地址" style="flex:1;font-family:monospace" />
          <button class="btn btn-sm" style="background:rgba(244,114,182,0.2);color:#F472B6" @click="removeCustomProvider(i)">删除</button>
        </div>
        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
          <div v-for="(m, mi) in p.models" :key="mi" style="display:flex;gap:4px;align-items:center">
            <input v-model="m.id" placeholder="模型 ID" style="width:140px;font-size:12px;font-family:monospace" />
            <input v-model="m.name" placeholder="显示名" style="width:100px;font-size:12px" />
            <button class="btn-sm" style="background:transparent;color:var(--danger);border:none;font-size:10px" @click="removeModel(p, mi)">✕</button>
          </div>
          <button class="btn-sm" style="background:transparent;border:1px dashed var(--border);color:var(--text3);font-size:11px" @click="addModel(p)">+ 模型</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-sm" @click="addCustomProvider" style="background:transparent;border:1px dashed var(--accent);color:var(--accent)">+ 添加供应商</button>
        <button class="btn btn-sm" @click="saveCustomProviders" :disabled="savingCustom">{{ savingCustom ? '保存中...' : '保存自定义供应商' }}</button>
      </div>
      <div v-if="customMsg" style="margin-top:8px;font-size:12px" :style="{color: customMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ customMsg.text }}</div>
    </div>

    <div class="card">
      <h2>Fallback 链</h2>
      <div style="font-size:13px;color:var(--text3);margin-bottom:12px">
        配置 AI 调用失败时的备用方案顺序。支持多个用途：<span style="color:var(--accent)">chat</span>（聊天）、<span style="color:var(--accent)">vision</span>（识图）、<span style="color:var(--accent)">analysis</span>（分析）
      </div>
      <div v-for="(chain, purpose) in fallbackChains" :key="purpose" style="margin-bottom:16px;padding:12px;background:var(--input);border:1px solid var(--border);border-radius:8px">
        <div style="font-weight:700;font-size:14px;color:var(--accent);margin-bottom:8px">{{ purposeLabel(purpose) }}</div>
        <div style="display:flex;gap:4px;margin-bottom:6px;font-size:11px;color:var(--text3)">
          <span style="width:26px">#</span>
          <span style="flex:1">供应商</span>
          <span style="width:130px">模型</span>
          <span style="width:120px">Key 文件</span>
          <span style="width:30px"></span>
        </div>
        <div v-for="(step, si) in chain" :key="si" style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
          <span style="width:26px;font-size:11px;color:var(--text3)">{{ si + 1 }}</span>
          <SelectBox v-model="step.provider" :options="allProviderOpts" style="flex:1" />
          <input v-model="step.model" placeholder="模型 ID" style="width:130px;font-size:12px;font-family:monospace" />
          <input v-model="step.keyFile" placeholder="key 文件" style="width:120px;font-size:11px;font-family:monospace" />
          <button class="btn-sm" style="background:transparent;color:var(--danger);border:none" @click="removeFallbackStep(purpose, si)">✕</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="btn-sm" style="background:transparent;border:1px dashed var(--border);color:var(--text3);font-size:11px" @click="addFallbackStep(purpose)">+ 步骤</button>
          <button class="btn-sm" style="background:transparent;border:1px dashed var(--accent);color:var(--accent);font-size:11px" @click="resetFallbackChain(purpose)">重置为默认</button>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" @click="saveFallback" :disabled="savingFallback">{{ savingFallback ? '保存中...' : '保存 Fallback 链' }}</button>
        <button class="btn btn-sm" style="background:transparent;border:1px solid var(--accent);color:var(--accent)" @click="resetAllFallback">全部重置为默认</button>
      </div>
      <div v-if="fallbackMsg" style="margin-top:8px;font-size:12px" :style="{color: fallbackMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ fallbackMsg.text }}</div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { fetchConfig, fetchProviders, updateConfig, fetchCustomProviders, saveCustomProviders, fetchFallbackChains, saveFallbackChains } from '../api'
import SelectBox from './SelectBox.vue'

const PURPOSE_LABELS = { chat: '聊天 AI', vision: '识图 AI', analysis: '分析 AI' }

export default {
  name: 'ConfigPanel',
  components: { SelectBox },
  setup() {
    const providers = ref({})
    const selectedProvider = ref('deepseek')
    const selectedModel = ref('')
    const baseUrl = ref('')
    const saving = ref(false)
    const configMsg = ref(null)

    // 自定义供应商
    const customProviders = ref([])
    const savingCustom = ref(false)
    const customMsg = ref(null)

    // Fallback 链
    const fallbackChains = ref({})
    const defaultFallback = ref({})
    const savingFallback = ref(false)
    const fallbackMsg = ref(null)

    const currentModels = computed(() => {
      const p = providers.value[selectedProvider.value]
      return p ? p.models : []
    })
    const providerOpts = computed(() => Object.keys(providers.value).map(k => ({ value: k, label: providers.value[k].name })))
    const modelOpts = computed(() => currentModels.value.map(m => ({ value: m.id, label: m.name })))

    // 合并内置 + 自定义供应商为选项
    const allProviderOpts = computed(() => {
      const opts = Object.keys(providers.value).map(k => ({ value: k, label: providers.value[k].name }))
      for (const p of customProviders.value) {
        if (!opts.find(o => o.value === p.id)) opts.push({ value: p.id, label: p.name })
      }
      return opts
    })

    function purposeLabel(p) { return PURPOSE_LABELS[p] || p }

    onMounted(async () => {
      const [pRes, cRes, cpRes, fbRes] = await Promise.all([
        fetchProviders(), fetchConfig(), fetchCustomProviders(), fetchFallbackChains()
      ])
      if (pRes.ok) providers.value = pRes.data
      if (cRes.ok) {
        selectedProvider.value = cRes.data.provider || 'deepseek'
        selectedModel.value = cRes.data.model || ''
        baseUrl.value = cRes.data.baseUrl || ''
      }
      if (cpRes.ok && Array.isArray(cpRes.data)) customProviders.value = cpRes.data
      if (fbRes.ok) {
        if (fbRes.data.chains && Object.keys(fbRes.data.chains).length) fallbackChains.value = JSON.parse(JSON.stringify(fbRes.data.chains))
        if (fbRes.data.defaults) defaultFallback.value = fbRes.data.defaults
      }
    })

    function onProviderChange() {
      const models = currentModels.value
      if (models.length && !models.find(m => m.id === selectedModel.value)) {
        selectedModel.value = models[0].id
      }
    }

    async function saveConfig() {
      saving.value = true; configMsg.value = null
      try {
        const res = await updateConfig({ provider: selectedProvider.value, model: selectedModel.value, baseUrl: baseUrl.value || undefined })
        if (res.code === 'ADMIN_REQUIRED') { window.showAdminDialog && window.showAdminDialog('修改配置需要管理员密码', saveConfig); saving.value = false; return }
        configMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已保存' : '保存失败') }
      } catch (e) { configMsg.value = { type: 'err', text: e.message } }
      saving.value = false
    }

    // 自定义供应商操作
    function addCustomProvider() {
      customProviders.value.push({ id: '', name: '', baseURL: '', models: [{ id: '', name: '' }] })
    }
    function removeCustomProvider(i) { customProviders.value.splice(i, 1) }
    function addModel(p) { p.models.push({ id: '', name: '' }) }
    function removeModel(p, mi) { p.models.splice(mi, 1) }
    async function saveCustomProviders() {
      savingCustom.value = true; customMsg.value = null
      const cleaned = customProviders.value.filter(p => p.id.trim()).map(p => ({ ...p, id: p.id.trim(), models: p.models.filter(m => m.id.trim()) }))
      const res = await saveCustomProviders(cleaned)
      if (res.code === 'ADMIN_REQUIRED') { savingCustom.value = false; window.showAdminDialog && window.showAdminDialog('保存自定义供应商需要管理员密码', saveCustomProviders); return }
      customMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已保存' : '保存失败') }
      if (res.ok) customProviders.value = cleaned
      savingCustom.value = false
    }

    // Fallback 链操作
    function addFallbackStep(purpose) {
      if (!fallbackChains.value[purpose]) fallbackChains.value[purpose] = []
      fallbackChains.value[purpose].push({ provider: 'opencode', model: '', keyFile: '' })
    }
    function removeFallbackStep(purpose, si) { fallbackChains.value[purpose].splice(si, 1) }
    function resetFallbackChain(purpose) {
      if (defaultFallback.value[purpose]) {
        fallbackChains.value[purpose] = JSON.parse(JSON.stringify(defaultFallback.value[purpose]))
      }
    }
    function resetAllFallback() { fallbackChains.value = JSON.parse(JSON.stringify(defaultFallback.value)) }
    async function saveFallback() {
      savingFallback.value = true; fallbackMsg.value = null
      const res = await saveFallbackChains(fallbackChains.value)
      if (res.code === 'ADMIN_REQUIRED') { savingFallback.value = false; window.showAdminDialog && window.showAdminDialog('保存 Fallback 链需要管理员密码', saveFallback); return }
      fallbackMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已保存' : '保存失败') }
      savingFallback.value = false
    }

    return {
      providers, selectedProvider, selectedModel, baseUrl, currentModels, providerOpts, modelOpts, saving, configMsg,
      onProviderChange, saveConfig,
      customProviders, savingCustom, customMsg, addCustomProvider, removeCustomProvider, addModel, removeModel, saveCustomProviders,
      fallbackChains, savingFallback, fallbackMsg, purposeLabel, allProviderOpts,
      addFallbackStep, removeFallbackStep, resetFallbackChain, resetAllFallback, saveFallback,
    }
  }
}
</script>
