<template>
  <div class="card">
    <h2>自定义人格</h2>
    <div v-if="!personas.length" style="color:var(--text3);font-size:14px">无自定义人格</div>
    <div v-for="p in personas" :key="p.name" class="grp">
      <div class="grp-name">{{ p.name }}</div>
      <div class="grp-desc">{{ p.description || '无描述' }}</div>
    </div>
  </div>

  <div class="card">
    <h2>创建新人格</h2>
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
          <div style="font-size:13px;color:var(--text2);margin-bottom:4px">人格内容（提示词）</div>
          <textarea v-model="newContent" rows="10" placeholder="在此编写人格的提示词..." style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:13px;font-family:monospace;resize:vertical"></textarea>
      </div>
      <div>
        <button class="btn" @click="doCreate" :disabled="creating">{{ creating ? '创建中...' : '创建人格' }}</button>
        <div v-if="createMsg" style="margin-top:8px;font-size:13px" :style="{color: createMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ createMsg.text }}</div>
      </div>
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
          <button class="btn" @click="doLoreSave" :disabled="loreSaving">{{ loreSaving ? '保存中...' : (loreEditing ? '保存' : '创建') }}</button>
          <button v-if="loreEditing" class="btn" @click="cancelLoreEdit" style="background:var(--tabBg);color:var(--text2);border:1px solid var(--border)">取消</button>
        </div>
        <div v-if="loreMsg" style="font-size:13px" :style="{color: loreMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ loreMsg.text }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { fetchPersonas, fetchLoreList, createPersona, fetchLores, createLore, updateLore, deleteLore } from '../api'

export default {
  name: 'PersonaPanel',
  setup() {
    const personas = ref([])
    const loreList = ref([])
    const newName = ref('')
    const newDesc = ref('')
    const newLore = ref('none')
    const newContent = ref('')
    const creating = ref(false)
    const createMsg = ref(null)

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

    async function doCreate() {
      if (!newName.value.trim()) { createMsg.value = { type: 'err', text: '请输入名称' }; return }
      if (!newContent.value.trim()) { createMsg.value = { type: 'err', text: '请输入人格内容' }; return }
      creating.value = true; createMsg.value = null
      const res = await createPersona({
        name: newName.value.trim(),
        description: newDesc.value.trim(),
        lore: newLore.value,
        content: newContent.value,
      })
      if (res.code === 'ADMIN_REQUIRED') { window.showAdminDialog && window.showAdminDialog('创建人格需要服务器密码', doCreate); creating.value = false; return }
      if (res.ok) {
        createMsg.value = { type: 'ok', text: res.data?.message || '创建成功' }
        newName.value = ''; newDesc.value = ''; newContent.value = ''
        // 重新加载人格列表
        const pRes = await fetchPersonas()
        if (pRes.ok) personas.value = pRes.data
      } else {
        createMsg.value = { type: 'err', text: res.data?.message || '创建失败' }
      }
      creating.value = false
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

    return { personas, loreList, newName, newDesc, newLore, newContent, creating, createMsg, doCreate,
      lores, loreFormName, loreFormDesc, loreFormContent, loreSaving, loreMsg, loreDeleting, loreEditing,
      startLoreEdit, cancelLoreEdit, doLoreSave, doLoreDelete }
  }
}
</script>
