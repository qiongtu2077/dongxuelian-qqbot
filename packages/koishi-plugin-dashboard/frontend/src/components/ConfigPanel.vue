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
      <div v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { fetchConfig, fetchProviders, updateConfig } from '../api'
import SelectBox from './SelectBox.vue'

export default {
  name: 'ConfigPanel',
  components: { SelectBox },
  setup() {
    const providers = ref({})
    const selectedProvider = ref('deepseek')
    const selectedModel = ref('')
    const baseUrl = ref('')
    const saving = ref(false)
    const msg = ref(null)

    const currentModels = computed(() => {
      const p = providers.value[selectedProvider.value]
      return p ? p.models : []
    })
    const providerOpts = computed(() => Object.keys(providers.value).map(k => ({ value: k, label: providers.value[k].name })))
    const modelOpts = computed(() => currentModels.value.map(m => ({ value: m.id, label: m.name })))

    onMounted(async () => {
      const [pRes, cRes] = await Promise.all([
        fetchProviders(), fetchConfig()
      ])
      if (pRes.ok) providers.value = pRes.data
      if (cRes.ok) {
        selectedProvider.value = cRes.data.provider || 'deepseek'
        selectedModel.value = cRes.data.model || ''
        baseUrl.value = cRes.data.baseUrl || ''
      }
    })

    function onProviderChange() {
      const models = currentModels.value
      if (models.length && !models.find(m => m.id === selectedModel.value)) {
        selectedModel.value = models[0].id
      }
    }

    async function saveConfig() {
      saving.value = true
      msg.value = null
      try {
        const res = await updateConfig({
          provider: selectedProvider.value,
          model: selectedModel.value,
          baseUrl: baseUrl.value || undefined,
        })
        if (res.code === 'ADMIN_REQUIRED') { window.showAdminDialog && window.showAdminDialog('修改配置需要管理员密码', saveConfig); saving.value = false; return }
        if (res.ok) msg.value = { type: 'ok', text: '配置已保存并热加载' }
        else msg.value = { type: 'err', text: res.data?.message || '保存失败' }
      } catch (e) {
        msg.value = { type: 'err', text: e.message }
      }
      saving.value = false
    }

    return { providers, selectedProvider, selectedModel, baseUrl, currentModels, providerOpts, modelOpts, saving, msg, onProviderChange, saveConfig }
  }
}
</script>
