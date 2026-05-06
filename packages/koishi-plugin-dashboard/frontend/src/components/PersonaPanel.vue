<template>
  <div class="card">
    <h2>自定义人格</h2>
    <div v-if="!personas.length" style="color:var(--text3);font-size:14px">无自定义人格</div>
    <div v-for="p in personas" :key="p.name" class="grp" style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div class="grp-name">{{ p.name }}</div>
        <div class="grp-desc">{{ p.description || '无描述' }}</div>
      </div>
      <button class="btn-sm" @click="doEdit(p.name)"
        style="background:transparent;border:1px solid var(--accent);color:var(--accent);flex-shrink:0">编辑</button>
      <button class="btn-sm" @click="doDelete(p.name)"
        :style="{ background: deleting === p.name ? 'var(--tabBg)' : 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', flexShrink: 0 }"
        :disabled="deleting === p.name">{{ deleting === p.name ? '删除中' : '删除' }}</button>
    </div>
  </div>

  <div class="card">
    <h2>{{ editingName ? '编辑人格' : '创建新人格' }}</h2>
    <div style="display:grid;gap:12px">
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">名称</div>
        <input v-model="newName" placeholder="人格名称" style="width:100%" :disabled="!!editingName" />
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">描述</div>
        <input v-model="newDesc" placeholder="一句话描述" style="width:100%" />
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">世界观绑定</div>
        <SelectBox v-model="newLore" :options="loreOpts" placeholder="不绑定世界观" />
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">主动性 (will): {{ newWill }}</div>
        <input type="range" min="0.5" max="2.0" step="0.1" v-model.number="newWill" class="will-slider" />
        <div style="font-size:11px;color:var(--text3);display:flex;justify-content:space-between"><span>0.5 被动</span><span>1.0 默认</span><span>2.0 主动</span></div>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">人格内容（提示词）</div>
        <textarea v-model="newContent" rows="10" placeholder="在此编写人格的提示词..." style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:13px;font-family:monospace;resize:vertical"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" @click="doSave" :disabled="saving">{{ saving ? '保存中...' : (editingName ? '保存修改' : '创建人格') }}</button>
        <button v-if="editingName" class="btn" @click="cancelEdit" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">取消</button>
      </div>
      <div v-if="personaMsg" style="font-size:13px" :style="{color: personaMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ personaMsg.text }}</div>
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
        style="background:transparent;border:1px solid var(--accent);color:var(--accent);flex-shrink:0">编辑</button>
      <button class="btn-sm" @click="doLoreDelete(l.name)"
        :style="{ background: loreDeleting === l.name ? 'var(--tabBg)' : 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', flexShrink: 0 }"
        :disabled="loreDeleting === l.name">{{ loreDeleting === l.name ? '删除中' : '删除' }}</button>
    </div>

    <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
      <div style="font-size:13px;color:var(--text2);margin-bottom:8px">{{ loreEditing ? '编辑世界观' : '创建世界观' }}</div>
      <div style="display:grid;gap:8px">
        <input v-model="loreFormName" placeholder="世界观标识（如：my-lore）" style="width:100%" :disabled="!!loreEditing" />
        <input v-model="loreFormDesc" placeholder="一句话描述" style="width:100%" />
        <textarea v-model="loreFormContent" rows="12" placeholder="世界观设定内容..." style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:13px;font-family:monospace;resize:vertical"></textarea>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" @click="doLoreSave" :disabled="loreSaving">{{ loreSaving ? '保存中...' : (loreEditing ? '保存' : '创建') }}</button>
          <button v-if="loreEditing" class="btn btn-sm" @click="cancelLoreEdit" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">取消</button>
        </div>
        <div v-if="loreMsg" style="font-size:13px" :style="{color: loreMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ loreMsg.text }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { fetchPersonas, fetchLoreList, fetchPersona, createPersona, updatePersona, deletePersona, fetchLores, createLore, updateLore, deleteLore } from '../api'
import SelectBox from './SelectBox.vue'

export default {
  name: 'PersonaPanel',
  components: { SelectBox },
  setup() {
    const personas = ref([])
    const loreList = ref([])
    const loreOpts = computed(() => {
      const list = loreList.value.map(l => ({ value: l.id, label: l.description ? l.id + ' - ' + l.description : l.id }))
      return list
    })
    const newName = ref('')
    const newDesc = ref('')
    const newWill = ref(1.0)
    const newLore = ref('none')
    const newContent = ref('')
    const saving = ref(false)
    const personaMsg = ref(null)
    const deleting = ref(null)
    const editingName = ref(null)

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

    function resetForm() {
      newName.value = ''; newDesc.value = ''; newWill.value = 1.0; newLore.value = 'none'; newContent.value = ''
    }

    async function doEdit(name) {
      const res = await fetchPersona(name)
      if (!res.ok || !res.data?.data) { personaMsg.value = { type: 'err', text: '获取人格内容失败' }; return }
      const d = res.data.data
      editingName.value = name
      newName.value = d.name
      newDesc.value = d.description || ''
      newLore.value = d.lore || 'none'
      newWill.value = parseFloat(d.will) || 1.0
      newContent.value = d.content || ''
      personaMsg.value = null
    }

    function cancelEdit() {
      editingName.value = null; resetForm(); personaMsg.value = null
    }

    async function doSave() {
      if (!newName.value.trim()) { personaMsg.value = { type: 'err', text: '请输入名称' }; return }
      if (!newContent.value.trim()) { personaMsg.value = { type: 'err', text: '请输入人格内容' }; return }
      saving.value = true; personaMsg.value = null
      const payload = { name: newName.value.trim(), description: newDesc.value.trim(), lore: newLore.value, will: newWill.value, content: newContent.value }
      const res = editingName.value ? await updatePersona(payload) : await createPersona(payload)
      if (res.code === 'ADMIN_REQUIRED') { saving.value = false; window.showAdminDialog && window.showAdminDialog((editingName.value ? '编辑' : '创建') + '人格需要管理员密码', doSave); return }
      if (res.ok) {
        personaMsg.value = { type: 'ok', text: res.data?.message || (editingName.value ? '更新成功' : '创建成功') }
        if (!editingName.value) resetForm(); else cancelEdit()
        const pRes = await fetchPersonas()
        if (pRes.ok) personas.value = pRes.data
      } else {
        personaMsg.value = { type: 'err', text: res.data?.message || (editingName.value ? '更新失败' : '创建失败') }
      }
      saving.value = false
    }

    async function doDelete(name) {
      deleting.value = name; personaMsg.value = null
      const res = await deletePersona(name)
      if (res.code === 'ADMIN_REQUIRED') { deleting.value = null; window.showAdminDialog && window.showAdminDialog('删除人格需要管理员密码', () => doDelete(name)); return }
      if (res.ok) {
        personaMsg.value = { type: 'ok', text: res.data?.message || '删除成功' }
        const pRes = await fetchPersonas()
        if (pRes.ok) personas.value = pRes.data
      } else {
        personaMsg.value = { type: 'err', text: res.data?.message || '删除失败' }
      }
      deleting.value = null
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
      if (res.code === 'ADMIN_REQUIRED') { loreSaving.value = false; window.showAdminDialog && window.showAdminDialog((loreEditing.value ? '编辑' : '创建') + '世界观需要管理员密码', doLoreSave); return }
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
      if (res.code === 'ADMIN_REQUIRED') { loreDeleting.value = null; window.showAdminDialog && window.showAdminDialog('删除世界观需要管理员密码', () => doLoreDelete(name)); return }
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

    return { personas, loreList, loreOpts, newName, newDesc, newWill, newLore, newContent, saving, personaMsg, deleting, editingName, doEdit, cancelEdit, doSave, doDelete,
      lores, loreFormName, loreFormDesc, loreFormContent, loreSaving, loreMsg, loreDeleting, loreEditing, startLoreEdit, cancelLoreEdit, doLoreSave, doLoreDelete }
  }
}
</script>
