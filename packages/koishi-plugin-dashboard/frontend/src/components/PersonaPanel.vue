<template>
  <div class="tab-panel-root">
  <div v-if="corePersona" class="card">
    <h2>核心规则 <span style="margin-left:6px;font-size:11px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 5px;vertical-align:middle">核心</span></h2>
    <div class="grp" style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div class="grp-name">{{ corePersona.name }}</div>
        <div class="grp-desc">{{ corePersona.description || '无描述' }}</div>
      </div>
      <button class="btn-sm" @click="startPersonaEdit(corePersona.name)"
        style="background:transparent;border:1px solid var(--accent);color:var(--accent);flex-shrink:0">{{ personaEditing === corePersona.name ? '加载中...' : '编辑' }}</button>
    </div>
  </div>

  <div v-if="defaultModes.length" class="card">
    <h2>默认人格</h2>
    <div v-for="p in defaultModes" :key="p.name" class="grp" style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div class="grp-name">{{ p.name }}</div>
        <div class="grp-desc">{{ p.description || '无描述' }}</div>
      </div>
      <button class="btn-sm" @click="startPersonaEdit(p.name)"
        style="background:transparent;border:1px solid var(--accent);color:var(--accent);flex-shrink:0">{{ personaEditing === p.name ? '加载中...' : '编辑' }}</button>
    </div>
  </div>

  <div class="card">
    <h2>自定义人格</h2>
    <div v-if="!regularPersonas.length" style="color:var(--text3);font-size:14px">无自定义人格</div>
    <div v-for="p in regularPersonas" :key="p.name" class="grp" style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div class="grp-name">{{ p.name }}</div>
        <div class="grp-desc">{{ p.description || '无描述' }}</div>
      </div>
      <button class="btn-sm" @click="startPersonaEdit(p.name)"
        style="background:transparent;border:1px solid var(--accent);color:var(--accent);flex-shrink:0">{{ personaEditing === p.name ? '加载中...' : '编辑' }}</button>
      <button class="btn-sm" @click="doPersonaDelete(p.name)"
        :style="{ background: personaDeleting === p.name ? 'var(--tabBg)' : 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', flexShrink: 0 }"
        :disabled="personaDeleting === p.name">{{ personaDeleting === p.name ? '删除中' : '删除' }}</button>
    </div>
  </div>

  <div class="card" ref="personaEditSection">
    <h2>创建/修改人格</h2>
    <div style="display:grid;gap:12px">
      <div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">名称</div>
          <input v-model="newName" placeholder="人格名称，如：新角色" style="width:100%" />
        </div>
        <div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">描述</div>
          <input v-model="newDesc" placeholder="一句话描述" style="width:100%" />
        </div>
        <div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">世界观绑定</div>
          <select v-model="newLore" style="width:100%">
            <option v-for="l in loreList" :key="l.id" :value="l.id">{{ l.description ? l.id + ' - ' + l.description : l.id }}</option>
          </select>
        </div>
        <div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">Will 值（影响随机回复触发率）</div>
          <div style="display:flex;align-items:center;gap:10px">
            <input type="range" v-model.number="newWill" min="0.1" max="2.0" step="0.1" style="flex:1;accent-color:var(--accent)" />
            <span style="font-size:13px;color:var(--text);min-width:30px;text-align:right">{{ newWill }}</span>
          </div>
        </div>
        <div v-if="editingType === 'persona'">
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">NSFW 策略</div>
          <select v-model="newNsfw" style="width:100%">
            <option value="none">不参与（默认）</option>
            <option value="reply">可以接话</option>
          </select>
        </div>
        <div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">人格内容（提示词）</div>
          <textarea v-model="newContent" rows="10" placeholder="在此编写人格的提示词..." style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:13px;font-family:monospace;resize:vertical"></textarea>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" @click="doCreate" :disabled="creating">{{ creating ? '保存中...' : (editingName ? '保存修改' : '创建人格') }}</button>
        <button v-if="editingName" class="btn btn-sm" @click="cancelEdit" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">取消</button>
        <div v-if="createMsg" style="font-size:13px" :style="{color: createMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ createMsg.text }}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>语音合成配置</h2>
    <div style="display:grid;gap:12px">
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">选择人格</div>
        <select v-model="voicePersona" style="width:100%">
          <option value="">-- 选择人格 --</option>
          <option v-for="p in personas" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">音色</div>
        <select v-model="voiceId" style="width:100%">
          <option value="">默认（冰糖）</option>
          <option value="__cloned__" v-if="personaVoiceMap[voicePersona]?.hasSample">克隆音色</option>
          <option v-for="v in voiceList" :key="v" :value="v">{{ v }}</option>
        </select>
      </div>
      <div v-if="voiceId === '__cloned__'">
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">具体克隆音色</div>
        <select v-model="selectedVoiceAssetId" style="width:100%">
          <option value="">-- 选择克隆音色 --</option>
          <option v-for="asset in clonedVoices" :key="asset.id" :value="asset.id" :disabled="asset.missing">
            {{ assetOptionLabel(asset) }}
          </option>
        </select>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">说话风格</div>
        <input v-model="voiceStyle" placeholder="活泼可爱、温柔知性..." style="width:100%" />
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" @click="doSaveVoice" :disabled="voiceSaving || !voicePersona">{{ voiceSaving ? '保存中...' : '保存配置' }}</button>
        <button class="btn" @click="doPreview" :disabled="voicePreviewing" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">{{ voicePreviewing ? '合成中...' : '试听' }}</button>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">试听文本</div>
        <input v-model="previewText" placeholder="你好，这是一段语音测试。" style="width:100%" />
      </div>
      <audio v-if="previewAudioSrc" controls :src="previewAudioSrc" style="width:100%;height:36px;border-radius:8px"></audio>
      <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:12px">
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px">音色克隆样本（上传音频样本，MP3/WAV/OGG/M4A，30s 以内，7MB 以内）</div>
        <div style="display:grid;gap:8px">
          <input v-model="cloneDisplayName" placeholder="显示名，默认使用人格名或文件名" style="width:100%" />
          <input v-model="cloneDescription" placeholder="备注，例如样本来源、版本或音质说明" style="width:100%" />
          <input v-model="cloneSampleText" placeholder="试听文本，默认：你好，这是一段语音测试。" style="width:100%" />
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="file" accept=".mp3,.wav,.ogg,.m4a" @change="onCloneFileChange" style="font-size:13px" />
            <button class="btn btn-sm" @click="doClone" :disabled="voiceCloning || !cloneFile || !voicePersona" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">{{ voiceCloning ? '克隆中...' : '测试克隆' }}</button>
            <span v-if="cloneStatus" style="font-size:12px" :style="{color: cloneStatus.includes('成功') ? 'var(--success)' : 'var(--error)'}">{{ cloneStatus }}</span>
          </div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:12px">
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px">已克隆音色</div>
        <div v-if="!clonedVoices.length" style="font-size:13px;color:var(--text3)">暂无克隆音色</div>
        <div v-for="asset in clonedVoices" :key="asset.id + asset.filename" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start;border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--input)">
          <div style="min-width:0;display:grid;gap:6px">
            <input v-model="asset.displayName" placeholder="显示名" style="width:100%" />
            <input v-model="asset.description" placeholder="备注" style="width:100%" />
            <input v-model="asset.sampleText" placeholder="试听文本" style="width:100%" />
            <div style="font-size:12px;color:var(--text3);display:flex;gap:10px;flex-wrap:wrap">
              <span>{{ asset.personaName }}</span>
              <span>{{ formatBytes(asset.size) }}</span>
              <span>{{ formatTime(asset.mtime) }}</span>
              <span v-if="asset.referencedBy?.length">使用：{{ asset.referencedBy.join('、') }}</span>
              <span v-if="asset.isCurrent" style="color:var(--success)">当前启用</span>
              <span v-if="asset.missing" style="color:var(--error)">文件缺失</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn-sm" @click="doPreviewAsset(asset)" :disabled="voicePreviewing || asset.missing" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">试听</button>
            <button class="btn-sm" @click="doUseAsset(asset)" :disabled="voiceSaving || asset.missing" style="background:transparent;border:1px solid var(--success);color:var(--success)">启用</button>
            <button class="btn-sm" @click="doUpdateAsset(asset)" :disabled="assetSaving === asset.id" style="background:transparent;border:1px solid var(--border);color:var(--text2)">{{ assetSaving === asset.id ? '保存中' : '保存' }}</button>
            <button class="btn-sm" @click="doDeleteAsset(asset)" :disabled="assetDeleting === asset.id" style="background:transparent;border:1px solid var(--danger);color:var(--danger)">{{ assetDeleting === asset.id ? '删除中' : '删除' }}</button>
          </div>
        </div>
      </div>
      <div v-if="voiceMsg" style="font-size:13px" :style="{color: voiceMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ voiceMsg.text }}</div>
    </div>
  </div>

  <div class="card">
    <h2>世界观管理</h2>
    <div v-if="!lores.length" style="color:var(--text3);font-size:14px">无世界观定义</div>
    <div v-for="l in lores" :key="l.name" class="grp" style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div class="grp-name">{{ l.name }}</div>
        <div class="grp-desc">{{ l.description || '无描述' }}</div>
      </div>
      <button class="btn-sm" @click="startLoreEdit(l)"
        style="background:transparent;border:1px solid var(--accent);color:var(--accent);flex-shrink:0">{{ loreEditing === l.name ? '加载中...' : '编辑' }}</button>
      <button class="btn-sm" @click="doLoreDelete(l.name)"
        :style="{ background: loreDeleting === l.name ? 'var(--tabBg)' : 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', flexShrink: 0 }"
        :disabled="loreDeleting === l.name">{{ loreDeleting === l.name ? '删除中' : '删除' }}</button>
    </div>

    <div ref="loreEditSection" style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px">{{ loreEditing ? '编辑世界观' : '创建世界观' }}</div>
      <div style="display:grid;gap:8px">
        <input v-model="loreFormName" placeholder="世界观标识（如：my-lore）" style="width:100%" :disabled="!!loreEditing" />
        <input v-model="loreFormDesc" placeholder="一句话描述" style="width:100%" />
        <textarea v-model="loreFormContent" rows="12" placeholder="世界观设定内容..." style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:13px;font-family:monospace;resize:vertical"></textarea>
        <div style="display:flex;gap:8px">
          <button class="btn" @click="doLoreSave" :disabled="loreSaving">{{ loreSaving ? '保存中...' : (loreEditing ? '保存' : '创建') }}</button>
          <button v-if="loreEditing" class="btn" @click="cancelLoreEdit" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">取消</button>
        </div>
        <div v-if="loreMsg" style="font-size:13px" :style="{color: loreMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ loreMsg.text }}</div>
      </div>
    </div>
  </div>
  </div>
</template>

<script setup>
import { ref, computed, inject, onMounted, nextTick, watch } from 'vue'
import { fetchPersonas, fetchPersonaDetail, fetchLoreList, createPersona, updatePersona, deletePersona, fetchLores, createLore, updateLore, deleteLore, fetchTtsVoices, ttsPreview, ttsClone, updateTtsClone, deleteTtsClone, savePersonaVoice } from '../api'

defineOptions({ name: 'PersonaPanel' })

    const showAdminDialog = inject('showAdminDialog')
    const personas = ref([])
    const loreList = ref([])
    const newName = ref('')
    const newDesc = ref('')
    const newLore = ref('none')
    const newWill = ref(1.0)
    const newNsfw = ref('none')
    const newContent = ref('')
    const editingName = ref(null)
    const editingType = ref(null)
    const creating = ref(false)
    const createMsg = ref(null)
    const personaDeleting = ref(null)
    const personaEditing = ref(null)
    const personaEditSection = ref(null)
    const loreEditSection = ref(null)

    const lores = ref([])
    const loreFormName = ref('')
    const loreFormDesc = ref('')
    const loreFormContent = ref('')
    const loreSaving = ref(false)
    const loreMsg = ref(null)
    const loreDeleting = ref(null)
    const loreEditing = ref(null)

    async function load() {
      const [pRes, lRes, loRes] = await Promise.all([fetchPersonas(), fetchLoreList(), fetchLores()])
      if (pRes.ok) personas.value = pRes.data
      if (lRes.ok) loreList.value = lRes.data
      if (loRes.ok) lores.value = loRes.data
    }
    onMounted(load)

    const corePersona = computed(() => personas.value.find(p => p.type === 'core'))
    const defaultModes = computed(() => personas.value.filter(p => p.type === 'mode'))
    const regularPersonas = computed(() => personas.value.filter(p => p.type !== 'core' && p.type !== 'mode'))

    async function doCreate() {
      if (!newName.value.trim()) { createMsg.value = { type: 'err', text: '请输入名称' }; return }
      if (!newContent.value.trim()) { createMsg.value = { type: 'err', text: '请输入人格内容' }; return }
      creating.value = true; createMsg.value = null
      const payload = {
        name: newName.value.trim(),
        description: newDesc.value.trim(),
        lore: newLore.value,
        will: newWill.value,
        nsfw: newNsfw.value,
        content: newContent.value,
      }
      const res = editingName.value ? await updatePersona(payload) : await createPersona(payload)
      if (res.code === 'ADMIN_REQUIRED') { if (showAdminDialog) showAdminDialog((editingName.value ? '更新' : '创建') + '人格需要管理员密码', doCreate); creating.value = false; return }
      if (res.ok) {
        createMsg.value = { type: 'ok', text: res.data?.message || (editingName.value ? '更新成功' : '创建成功') }
        newName.value = ''; newDesc.value = ''; newContent.value = ''; newLore.value = 'none'; newWill.value = 1.0; newNsfw.value = 'none'; editingName.value = null; editingType.value = null
        const pRes = await fetchPersonas()
        if (pRes.ok) personas.value = pRes.data
      } else {
        createMsg.value = { type: 'err', text: res.data?.message || (editingName.value ? '更新失败' : '创建失败') }
      }
      creating.value = false
    }

    function cancelEdit() {
      editingName.value = null
      editingType.value = null
      personaEditing.value = null
      newName.value = ''; newDesc.value = ''; newContent.value = ''; newLore.value = 'none'; newWill.value = 1.0; newNsfw.value = 'none'
      createMsg.value = null
    }

    async function startPersonaEdit(name) {
      const p = personas.value.find(x => x.name === name)
      if (!p) return
      personaEditing.value = name
      editingName.value = name
      editingType.value = p.type || 'persona'
      newName.value = p.name
      newDesc.value = p.description || ''
      // API 列表接口不返回 content/lore，单独请求详情
      const detail = await fetchPersonaDetail(name)
      if (detail.ok && detail.data) {
        const d = detail.data.data || detail.data
        newContent.value = d.content || ''
        newLore.value = d.lore || 'none'
        newWill.value = parseFloat(d.will) || 1.0
        newNsfw.value = d.nsfw || 'none'
      } else {
        newContent.value = ''
        newLore.value = 'none'
        newWill.value = 1.0
        newNsfw.value = 'none'
      }
      createMsg.value = null
      personaEditing.value = null
      nextTick(() => {
        const el = personaEditSection.value
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }

    async function doPersonaDelete(name) {
      personaDeleting.value = name; createMsg.value = null
      const res = await deletePersona(name)
      if (res.code === 'ADMIN_REQUIRED') { personaDeleting.value = null; if (showAdminDialog) showAdminDialog('删除人格需要管理员密码', () => doPersonaDelete(name)); return }
      if (res.ok) {
        createMsg.value = { type: 'ok', text: '删除成功' }
        const pRes = await fetchPersonas()
        if (pRes.ok) personas.value = pRes.data
      } else {
        createMsg.value = { type: 'err', text: res.data?.message || '删除失败' }
      }
      personaDeleting.value = null
    }

    function resetLoreForm() {
      loreFormName.value = ''; loreFormDesc.value = ''; loreFormContent.value = ''
    }

    function startLoreEdit(l) {
      loreEditing.value = l.name
      loreFormName.value = l.name
      loreFormDesc.value = l.description || ''
      loreFormContent.value = l.content || ''
      loreMsg.value = null
      nextTick(() => {
        const el = loreEditSection.value
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }

    function cancelLoreEdit() {
      loreEditing.value = null; resetLoreForm(); loreMsg.value = null
    }

    async function doLoreSave() {
      if (!loreFormName.value.trim()) { loreMsg.value = { type: 'err', text: '请输入标识' }; return }
      if (!loreFormContent.value.trim()) { loreMsg.value = { type: 'err', text: '请输入内容' }; return }
      loreSaving.value = true; loreMsg.value = null
      const payload = { name: loreFormName.value.trim(), description: loreFormDesc.value.trim(), content: loreFormContent.value }
      const res = loreEditing.value ? await updateLore(payload) : await createLore(payload)
      if (res.code === 'ADMIN_REQUIRED') { loreSaving.value = false; if (showAdminDialog) showAdminDialog((loreEditing.value ? '编辑' : '创建') + '世界观需要管理员密码', doLoreSave); return }
      if (res.ok) {
        loreMsg.value = { type: 'ok', text: res.data?.message || (loreEditing.value ? '更新成功' : '创建成功') }
        if (!loreEditing.value) resetLoreForm(); else cancelLoreEdit()
        const [loRes, lRes] = await Promise.all([fetchLores(), fetchLoreList()])
        if (loRes.ok) lores.value = loRes.data
        if (lRes.ok) loreList.value = lRes.data
      } else {
        loreMsg.value = { type: 'err', text: res.data?.message || (loreEditing.value ? '更新失败' : '创建失败') }
      }
      loreSaving.value = false
    }

    async function doLoreDelete(name) {
      loreDeleting.value = name; loreMsg.value = null
      const res = await deleteLore(name)
      if (res.code === 'ADMIN_REQUIRED') { loreDeleting.value = null; if (showAdminDialog) showAdminDialog('删除世界观需要管理员密码', () => doLoreDelete(name)); return }
      if (res.ok) {
        loreMsg.value = { type: 'ok', text: res.data?.message || '删除成功' }
        const [loRes, lRes] = await Promise.all([fetchLores(), fetchLoreList()])
        if (loRes.ok) lores.value = loRes.data
        if (lRes.ok) loreList.value = lRes.data
      } else {
        loreMsg.value = { type: 'err', text: res.data?.message || '删除失败' }
      }
      loreDeleting.value = null
    }

    const voicePersona = ref('')
    const voiceId = ref('')
    const selectedVoiceAssetId = ref('')
    const voiceStyle = ref('')
    const voiceList = ref([])
    const voiceSaving = ref(false)
    const voicePreviewing = ref(false)
    const voiceCloning = ref(false)
    const voiceMsg = ref(null)
    const previewText = ref('')
    const previewAudioSrc = ref('')
    const cloneFile = ref(null)
    const cloneDisplayName = ref('')
    const cloneDescription = ref('')
    const cloneSampleText = ref('')
    const cloneStatus = ref('')
    const personaVoiceMap = ref({})
    const clonedVoices = ref([])
    const assetSaving = ref('')
    const assetDeleting = ref('')

    const usableClonedVoices = computed(() => clonedVoices.value.filter(asset => !asset.missing))

    function findVoiceAssetById(id) {
      return clonedVoices.value.find(asset => asset.id === id && !asset.missing) || null
    }

    function pickDefaultVoiceAsset(personaName, preferredId = '') {
      return findVoiceAssetById(preferredId) ||
        usableClonedVoices.value.find(asset => asset.personaName === personaName) ||
        usableClonedVoices.value[0] ||
        null
    }

    function assetOptionLabel(asset) {
      const name = asset.displayName || asset.id
      const owner = asset.personaName ? `（${asset.personaName}）` : ''
      const refs = asset.referencedBy?.length ? ` · 使用：${asset.referencedBy.join('、')}` : ''
      return `${name}${owner}${asset.missing ? ' · 文件缺失' : refs}`
    }

    async function loadVoices() {
      const res = await fetchTtsVoices()
      if (res.ok) {
        voiceList.value = res.data?.builtin || []
        const pvMap = {}
        for (const p of (res.data?.personas || [])) {
          if (p.name) pvMap[p.name] = { voiceId: p.voice || '', voiceStyle: p.style || '', voiceAssetId: p.voiceAssetId || '', hasSample: !!p.hasSample }
        }
        personaVoiceMap.value = pvMap
        clonedVoices.value = (res.data?.clonedVoices || []).map(asset => ({
          ...asset,
          referencedBy: Array.isArray(asset.referencedBy) ? asset.referencedBy : [],
        }))
        if (voiceId.value === '__cloned__' && !findVoiceAssetById(selectedVoiceAssetId.value)) {
          selectedVoiceAssetId.value = pickDefaultVoiceAsset(voicePersona.value, pvMap[voicePersona.value]?.voiceAssetId)?.id || ''
        }
      }
    }
    onMounted(loadVoices)

    watch(voicePersona, (name) => {
      const pv = personaVoiceMap.value[name]
      voiceId.value = pv?.voiceId || ''
      voiceStyle.value = pv?.voiceStyle || ''
      const currentAsset = clonedVoices.value.find(asset => asset.id === pv?.voiceAssetId) || clonedVoices.value.find(asset => asset.personaName === name)
      selectedVoiceAssetId.value = voiceId.value === '__cloned__' ? (pickDefaultVoiceAsset(name, pv?.voiceAssetId)?.id || '') : ''
      if (!cloneDisplayName.value) cloneDisplayName.value = currentAsset?.displayName || (name ? `${name} 克隆音色` : '')
      if (!cloneDescription.value) cloneDescription.value = currentAsset?.description || ''
      if (!cloneSampleText.value) cloneSampleText.value = currentAsset?.sampleText || ''
    })

    watch(voiceId, (next) => {
      if (next === '__cloned__' && !selectedVoiceAssetId.value) {
        selectedVoiceAssetId.value = pickDefaultVoiceAsset(voicePersona.value, personaVoiceMap.value[voicePersona.value]?.voiceAssetId)?.id || ''
      }
      if (next !== '__cloned__') selectedVoiceAssetId.value = ''
    })

    function formatBytes(size) {
      const bytes = Number(size) || 0
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    function formatTime(ms) {
      const value = Number(ms) || 0
      if (!value) return '未知时间'
      return new Date(value).toLocaleString()
    }

    async function doSaveVoice() {
      if (!voicePersona.value) return
      voiceSaving.value = true; voiceMsg.value = null
      const selectedAssetId = voiceId.value === '__cloned__' ? selectedVoiceAssetId.value : ''
      if (voiceId.value === '__cloned__' && !findVoiceAssetById(selectedAssetId)) {
        voiceSaving.value = false
        voiceMsg.value = { type: 'err', text: '请选择要绑定的克隆音色' }
        return
      }
      const res = await savePersonaVoice(voicePersona.value, voiceId.value, voiceStyle.value, selectedAssetId)
      if (res.code === 'ADMIN_REQUIRED') { voiceSaving.value = false; if (showAdminDialog) showAdminDialog('保存语音配置需要管理员密码', doSaveVoice); return }
      if (res.ok) {
        voiceMsg.value = { type: 'ok', text: '语音配置已保存' }
        personaVoiceMap.value = { ...personaVoiceMap.value, [voicePersona.value]: { ...(personaVoiceMap.value[voicePersona.value] || {}), voiceId: voiceId.value, voiceStyle: voiceStyle.value, voiceAssetId: selectedAssetId } }
        await loadVoices()
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
      }
      voiceSaving.value = false
    }

    async function doPreview() {
      voicePreviewing.value = true; previewAudioSrc.value = ''; voiceMsg.value = null
      const text = previewText.value.trim() || '你好，这是一段语音测试。'
      const selectedAssetId = voiceId.value === '__cloned__' ? selectedVoiceAssetId.value : ''
      if (voiceId.value === '__cloned__' && !findVoiceAssetById(selectedAssetId)) {
        voicePreviewing.value = false
        voiceMsg.value = { type: 'err', text: '请选择要试听的克隆音色' }
        return
      }
      const res = await ttsPreview(text, voiceId.value || '冰糖', voiceStyle.value || '活泼可爱', voicePersona.value, selectedAssetId)
      if (res.ok && res.data?.audio) {
        previewAudioSrc.value = 'data:audio/wav;base64,' + res.data.audio
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '试听失败' }
      }
      voicePreviewing.value = false
    }

    function onCloneFileChange(e) {
      cloneFile.value = e.target.files?.[0] || null
      cloneStatus.value = ''
      if (cloneFile.value && !cloneDisplayName.value.trim()) {
        cloneDisplayName.value = cloneFile.value.name.replace(/\.[^.]+$/, '')
      }
    }

    async function doClone() {
      if (!cloneFile.value || !voicePersona.value) return
      if (cloneFile.value.size > 7 * 1024 * 1024) {
        cloneStatus.value = '文件过大'
        voiceMsg.value = { type: 'err', text: '音频样本请控制在 7MB 以内，避免编码上传后超过请求限制' }
        return
      }
      voiceCloning.value = true; cloneStatus.value = '上传中...'; voiceMsg.value = null
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1]
        const mimeType = cloneFile.value.type || 'audio/mpeg'
        const res = await ttsClone(voicePersona.value, base64, mimeType, {
          displayName: cloneDisplayName.value.trim() || `${voicePersona.value} 克隆音色`,
          description: cloneDescription.value.trim(),
          sampleText: cloneSampleText.value.trim() || previewText.value.trim() || '你好，这是一段语音测试。',
          voiceStyle: voiceStyle.value || '活泼可爱',
        })
        if (res.ok) {
          cloneStatus.value = '克隆成功'
          voiceId.value = '__cloned__'
          selectedVoiceAssetId.value = res.data?.asset?.id || ''
          personaVoiceMap.value = { ...personaVoiceMap.value, [voicePersona.value]: { ...(personaVoiceMap.value[voicePersona.value] || {}), voiceId: '__cloned__', voiceStyle: voiceStyle.value, hasSample: true, voiceAssetId: res.data?.asset?.id || '' } }
          await loadVoices()
        } else {
          cloneStatus.value = '克隆失败'
          voiceMsg.value = { type: 'err', text: res.data?.message || '克隆失败' }
        }
        voiceCloning.value = false
      }
      reader.onerror = () => { voiceCloning.value = false; cloneStatus.value = '读取失败'; voiceMsg.value = { type: 'err', text: '文件读取失败' } }
      reader.readAsDataURL(cloneFile.value)
    }

    async function doPreviewAsset(asset) {
      if (!asset) return
      voicePreviewing.value = true; previewAudioSrc.value = ''; voiceMsg.value = null
      const style = voiceStyle.value || personaVoiceMap.value[voicePersona.value]?.voiceStyle || personaVoiceMap.value[asset.personaName]?.voiceStyle || '活泼可爱'
      const text = (asset.sampleText || previewText.value || '你好，这是一段语音测试。').trim()
      const res = await ttsPreview(text, '__cloned__', style, voicePersona.value || asset.personaName, asset.id)
      if (res.code === 'ADMIN_REQUIRED') { voicePreviewing.value = false; if (showAdminDialog) showAdminDialog('试听克隆音色需要管理员密码', () => doPreviewAsset(asset)); return }
      if (res.ok && res.data?.audio) {
        previewAudioSrc.value = 'data:audio/wav;base64,' + res.data.audio
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '试听失败' }
      }
      voicePreviewing.value = false
    }

    async function doUseAsset(asset) {
      if (!asset) return
      const targetPersona = voicePersona.value || asset.personaName
      if (!targetPersona) {
        voiceMsg.value = { type: 'err', text: '请先选择要绑定的人格' }
        return
      }
      voicePersona.value = targetPersona
      voiceId.value = '__cloned__'
      selectedVoiceAssetId.value = asset.id
      const style = personaVoiceMap.value[targetPersona]?.voiceStyle || voiceStyle.value || '活泼可爱'
      voiceStyle.value = style
      voiceSaving.value = true; voiceMsg.value = null
      const res = await savePersonaVoice(targetPersona, '__cloned__', style, asset.id)
      if (res.code === 'ADMIN_REQUIRED') { voiceSaving.value = false; if (showAdminDialog) showAdminDialog('启用克隆音色需要管理员密码', () => doUseAsset(asset)); return }
      if (res.ok) {
        voiceMsg.value = { type: 'ok', text: '克隆音色已启用' }
        personaVoiceMap.value = { ...personaVoiceMap.value, [targetPersona]: { ...(personaVoiceMap.value[targetPersona] || {}), voiceId: '__cloned__', voiceStyle: style, hasSample: true, voiceAssetId: asset.id } }
        await loadVoices()
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '启用失败' }
      }
      voiceSaving.value = false
    }

    async function doUpdateAsset(asset) {
      if (!asset) return
      assetSaving.value = asset.id; voiceMsg.value = null
      const res = await updateTtsClone(asset.id, {
        displayName: asset.displayName,
        description: asset.description,
        sampleText: asset.sampleText,
      })
      if (res.code === 'ADMIN_REQUIRED') { assetSaving.value = ''; if (showAdminDialog) showAdminDialog('保存音色信息需要管理员密码', () => doUpdateAsset(asset)); return }
      if (res.ok) {
        voiceMsg.value = { type: 'ok', text: '音色信息已保存' }
        await loadVoices()
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
      }
      assetSaving.value = ''
    }

    async function doDeleteAsset(asset, force = false) {
      if (!asset) return
      if (!force && !window.confirm(`删除音色「${asset.displayName}」？`)) return
      if (force && !window.confirm(`删除音色「${asset.displayName}」并回退关联人格？`)) return
      assetDeleting.value = asset.id; voiceMsg.value = null
      const res = await deleteTtsClone(asset.id, force)
      if (res.code === 'ADMIN_REQUIRED') { assetDeleting.value = ''; if (showAdminDialog) showAdminDialog('删除克隆音色需要管理员密码', () => doDeleteAsset(asset, force)); return }
      if (!res.ok && res.data?.code === 'VOICE_ASSET_IN_USE') {
        assetDeleting.value = ''
        if (window.confirm(`音色正在被 ${res.data.personas?.join('、') || asset.personaName} 使用，是否删除并回退为默认音色？`)) {
          await doDeleteAsset(asset, true)
        }
        return
      }
      if (res.ok) {
        voiceMsg.value = { type: 'ok', text: '音色已删除' }
        if (selectedVoiceAssetId.value === asset.id) {
          selectedVoiceAssetId.value = ''
          if (voiceId.value === '__cloned__') voiceId.value = '冰糖'
        }
        await loadVoices()
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '删除失败' }
      }
      assetDeleting.value = ''
    }

</script>
