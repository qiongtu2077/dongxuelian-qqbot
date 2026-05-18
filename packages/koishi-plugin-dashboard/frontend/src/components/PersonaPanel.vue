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
        <div style="font-size:13px;color:var(--text2);margin-bottom:8px">音色克隆（上传音频样本，MP3/WAV/OGG/M4A，30s 以内，10MB 以内）</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="file" accept=".mp3,.wav,.ogg,.m4a" @change="onCloneFileChange" style="font-size:13px" />
          <button class="btn btn-sm" @click="doClone" :disabled="voiceCloning || !cloneFile || !voicePersona" style="background:transparent;border:1px solid var(--accent);color:var(--accent)">{{ voiceCloning ? '克隆中...' : '测试克隆' }}</button>
          <span v-if="cloneStatus" style="font-size:12px" :style="{color: cloneStatus.includes('成功') ? 'var(--success)' : 'var(--error)'}">{{ cloneStatus }}</span>
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

<script>
import { ref, computed, inject, onMounted, nextTick, watch } from 'vue'
import { fetchPersonas, fetchPersonaDetail, fetchLoreList, createPersona, updatePersona, deletePersona, fetchLores, createLore, updateLore, deleteLore, fetchTtsVoices, ttsPreview, ttsClone, savePersonaVoice } from '../api'

export default {
  name: 'PersonaPanel',
  setup() {
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
    const voiceStyle = ref('')
    const voiceList = ref([])
    const voiceSaving = ref(false)
    const voicePreviewing = ref(false)
    const voiceCloning = ref(false)
    const voiceMsg = ref(null)
    const previewText = ref('')
    const previewAudioSrc = ref('')
    const cloneFile = ref(null)
    const cloneStatus = ref('')
    const personaVoiceMap = ref({})

    async function loadVoices() {
      const res = await fetchTtsVoices()
      if (res.ok) {
        voiceList.value = res.data?.builtin || []
        const pvMap = {}
        for (const p of (res.data?.personas || [])) {
          if (p.name) pvMap[p.name] = { voiceId: p.voice || '', voiceStyle: p.style || '', hasSample: !!p.hasSample }
        }
        personaVoiceMap.value = pvMap
      }
    }
    onMounted(loadVoices)

    watch(voicePersona, (name) => {
      const pv = personaVoiceMap.value[name]
      voiceId.value = pv?.voiceId || ''
      voiceStyle.value = pv?.voiceStyle || ''
    })

    async function doSaveVoice() {
      if (!voicePersona.value) return
      voiceSaving.value = true; voiceMsg.value = null
      const res = await savePersonaVoice(voicePersona.value, voiceId.value, voiceStyle.value)
      if (res.code === 'ADMIN_REQUIRED') { voiceSaving.value = false; if (showAdminDialog) showAdminDialog('保存语音配置需要管理员密码', doSaveVoice); return }
      if (res.ok) {
        voiceMsg.value = { type: 'ok', text: '语音配置已保存' }
        personaVoiceMap.value = { ...personaVoiceMap.value, [voicePersona.value]: { voiceId: voiceId.value, voiceStyle: voiceStyle.value } }
      } else {
        voiceMsg.value = { type: 'err', text: res.data?.message || '保存失败' }
      }
      voiceSaving.value = false
    }

    async function doPreview() {
      voicePreviewing.value = true; previewAudioSrc.value = ''; voiceMsg.value = null
      const text = previewText.value.trim() || '你好，这是一段语音测试。'
      const res = await ttsPreview(text, voiceId.value || '冰糖', voiceStyle.value || '活泼可爱')
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
    }

    async function doClone() {
      if (!cloneFile.value || !voicePersona.value) return
      voiceCloning.value = true; cloneStatus.value = '上传中...'; voiceMsg.value = null
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1]
        const mimeType = cloneFile.value.type || 'audio/mpeg'
        const res = await ttsClone(voicePersona.value, base64, mimeType)
        if (res.ok) {
          cloneStatus.value = '克隆成功'
          voiceId.value = '__cloned__'
          personaVoiceMap.value = { ...personaVoiceMap.value, [voicePersona.value]: { voiceId: '__cloned__', voiceStyle: voiceStyle.value, hasSample: true } }
        } else {
          cloneStatus.value = '克隆失败'
          voiceMsg.value = { type: 'err', text: res.data?.message || '克隆失败' }
        }
        voiceCloning.value = false
      }
      reader.onerror = () => { voiceCloning.value = false; cloneStatus.value = '读取失败'; voiceMsg.value = { type: 'err', text: '文件读取失败' } }
      reader.readAsDataURL(cloneFile.value)
    }

    return { personas, corePersona, defaultModes, regularPersonas, loreList, newName, newDesc, newLore, newWill, newNsfw, newContent, editingName, editingType, creating, createMsg, personaDeleting, personaEditing, personaEditSection, loreEditSection, doCreate, cancelEdit,
      startPersonaEdit, doPersonaDelete,
      lores, loreFormName, loreFormDesc, loreFormContent, loreSaving, loreMsg, loreDeleting, loreEditing,
      startLoreEdit, cancelLoreEdit, doLoreSave, doLoreDelete,
      voicePersona, voiceId, voiceStyle, voiceList, voiceSaving, voicePreviewing, voiceCloning, voiceMsg, previewText, previewAudioSrc, cloneFile, cloneStatus,
      doSaveVoice, doPreview, onCloneFileChange, doClone }
  }
}
</script>
