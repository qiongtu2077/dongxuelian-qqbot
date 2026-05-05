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
</template>

<script>
import { ref, onMounted } from 'vue'
import { fetchPersonas, fetchLoreList, createPersona } from '../api'

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

    async function load() {
      const [pRes, lRes] = await Promise.all([fetchPersonas(), fetchLoreList()])
      if (pRes.ok) personas.value = pRes.data
      if (lRes.ok) loreList.value = lRes.data
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
      if (res.code === 'ADMIN_REQUIRED') { window.showAdminDialog && window.showAdminDialog('创建人格需要管理员密码', doCreate); return }
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

    return { personas, loreList, newName, newDesc, newLore, newContent, creating, createMsg, doCreate }
  }
}
</script>
