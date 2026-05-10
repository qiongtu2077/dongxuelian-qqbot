<template>
  <div>
    <div class="card">
      <h2>供应商和模型</h2>
      <div class="row">
        <label>供应商</label>
        <select v-model="selectedProvider" @change="onProviderChange">
          <option v-for="(v, k) in providers" :key="k" :value="k">{{ v.name }}</option>
        </select>
      </div>
      <div class="row">
        <label>模型</label>
        <select v-model="selectedModel">
          <option v-for="m in currentModels" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
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
          <button class="btn-sm" @click="removeCustomProvider(ci)" style="background:transparent;border:1px solid var(--danger);color:var(--danger)">✕</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <div v-for="(m, mi) in cp.models" :key="mi" style="display:flex;gap:4px;align-items:center">
            <input v-model="cp.models[mi]" placeholder="模型ID" style="width:100px" />
            <button v-if="cp.models.length > 1" class="btn-sm" @click="cp.models.splice(mi,1)" style="background:transparent;border:1px solid var(--danger);color:var(--danger);font-size:11px;padding:0 4px">✕</button>
          </div>
          <button class="btn-sm" @click="cp.models.push('')" style="background:transparent;border:1px solid var(--accent);color:var(--accent);font-size:11px">+模型</button>
        </div>
      </div>
      <button class="btn-sm" @click="addCustomProvider" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">+ 添加供应商</button>
      <button class="btn" @click="saveCustomProvidersAction" :disabled="savingCustom" style="margin-left:8px">{{ savingCustom ? '保存中...' : '保存自定义供应商' }}</button>
      <div v-if="customMsg" class="msg" :class="customMsg.type">{{ customMsg.text }}</div>
    </div>

    <div class="card">
      <h2>Fallback 链</h2>
      <div v-for="(chain, purpose) in fallbackChains" :key="purpose" style="margin-bottom:12px">
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">{{ purposeLabel(purpose) }}</div>
        <div v-for="(step, si) in chain" :key="si" style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input v-model="step.provider" placeholder="供应商" style="width:120px" />
          <input v-model="step.model" placeholder="模型" style="width:120px" />
          <input v-model="step.keyFile" placeholder="key文件(可选)" style="width:140px" />
          <button class="btn-sm" @click="removeFallbackStep(purpose, si)" style="background:transparent;border:1px solid var(--danger);color:var(--danger);font-size:11px;padding:0 4px">✕</button>
        </div>
        <button class="btn-sm" @click="addFallbackStep(purpose)" style="background:transparent;border:1px solid var(--accent);color:var(--accent);font-size:11px">+步骤</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" @click="saveFallback" :disabled="savingFallback">{{ savingFallback ? '保存中...' : '保存 Fallback 链' }}</button>
        <button class="btn" @click="resetAllFallback" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">全部重置为默认</button>
      </div>
      <div v-if="fallbackMsg" class="msg" :class="fallbackMsg.type">{{ fallbackMsg.text }}</div>
    </div>
  </div>
</template>

<script>
import { ref, computed, inject, onMounted } from 'vue'
import { fetchConfig, fetchProviders, updateConfig, fetchFallbackChains, saveFallbackChains, fetchCustomProviders, saveCustomProviders } from '../api'

export default {
  name: 'ConfigPanel',
  setup() {
    const showAdminDialog = inject('showAdminDialog')
    const providers = ref({})
    const selectedProvider = ref('deepseek')
    const selectedModel = ref('')
    const baseUrl = ref('')
    const saving = ref(false)
    const msg = ref(null)

    const customProviders = ref([])
    const savingCustom = ref(false)
    const customMsg = ref(null)

    const fallbackChains = ref({})
    const defaultFallback = ref({})
    const savingFallback = ref(false)
    const fallbackMsg = ref(null)

    const currentModels = computed(() => {
      const p = providers.value[selectedProvider.value]
      return p ? p.models : []
    })

    onMounted(async () => {
      const [pRes, cRes, fRes, cpRes] = await Promise.all([
        fetchProviders(), fetchConfig(), fetchFallbackChains(), fetchCustomProviders()
      ])
      if (pRes.ok) providers.value = pRes.data
      if (cRes.ok) {
        selectedProvider.value = cRes.data.provider || 'deepseek'
        selectedModel.value = cRes.data.model || ''
        baseUrl.value = cRes.data.baseUrl || ''
      }
      if (fRes.ok) {
        fallbackChains.value = fRes.data.chains || {}
        defaultFallback.value = fRes.data.default || {}
      }
      if (cpRes.ok) customProviders.value = cpRes.data || []
    })

    function onProviderChange() {
      const models = currentModels.value
      if (models.length && !models.find(m => m.id === selectedModel.value)) {
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
        if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('修改配置需要服务器密码', saveConfig); saving.value = false; return }
        if (res.ok) msg.value = { type: 'ok', text: '配置已保存并热加载' }
        else msg.value = { type: 'err', text: res.data?.message || '保存失败' }
      } catch (e) { msg.value = { type: 'err', text: e.message } }
      saving.value = false
    }

    function addCustomProvider() {
      customProviders.value.push({ id: '', name: '', baseURL: '', models: [''] })
    }
    function removeCustomProvider(idx) {
      customProviders.value.splice(idx, 1)
    }

    async function saveCustomProvidersAction() {
      savingCustom.value = true; customMsg.value = null
      const cleaned = customProviders.value.map(cp => ({
        ...cp,
        id: cp.id.trim(),
        name: cp.name.trim(),
        baseURL: cp.baseURL.trim(),
        models: cp.models.map(m => m.trim()).filter(Boolean)
      })).filter(cp => cp.id && cp.name)
      const res = await saveCustomProviders(cleaned)
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('保存自定义供应商需要服务器密码', saveCustomProvidersAction); savingCustom.value = false; return }
      if (res.ok) customMsg.value = { type: 'ok', text: '自定义供应商已保存' }
      else customMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
      savingCustom.value = false
    }

    function purposeLabel(p) {
      const labels = { chat: '聊天', vision: '视觉', analysis: '分析' }
      return labels[p] || p
    }

    function addFallbackStep(purpose) {
      if (!fallbackChains.value[purpose]) fallbackChains.value[purpose] = []
      fallbackChains.value[purpose].push({ provider: '', model: '', keyFile: '' })
    }

    function removeFallbackStep(purpose, idx) {
      fallbackChains.value[purpose].splice(idx, 1)
    }

    function resetAllFallback() {
      fallbackChains.value = JSON.parse(JSON.stringify(defaultFallback.value))
    }

    async function saveFallback() {
      savingFallback.value = true; fallbackMsg.value = null
      const res = await saveFallbackChains(fallbackChains.value)
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog('保存 Fallback 链需要服务器密码', saveFallback); savingFallback.value = false; return }
      if (res.ok) fallbackMsg.value = { type: 'ok', text: 'Fallback 链已保存' }
      else fallbackMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
      savingFallback.value = false
    }

    return {
      providers, selectedProvider, selectedModel, baseUrl, currentModels,
      saving, msg, onProviderChange, saveConfig,
      customProviders, savingCustom, customMsg,
      addCustomProvider, removeCustomProvider, saveCustomProvidersAction,
      fallbackChains, savingFallback, fallbackMsg,
      purposeLabel, addFallbackStep, removeFallbackStep, resetAllFallback, saveFallback,
    }
  }
}
</script>
