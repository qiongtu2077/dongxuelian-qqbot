import { ref } from 'vue'
import { fetchGroupNames } from '../api'

// 维护展示用群目录；读取失败保留群号，不影响配置编辑或提交。
export function useGroupNames() {
  const groupNames = ref<Record<string, string>>({})
  let loadedAt = 0
  let pending: Promise<void> | null = null

  // 每分钟最多刷新一次，手动刷新可以立即读取最新群名。
  async function refreshGroupNames(force = false): Promise<void> {
    if (pending) return pending
    if (!force && loadedAt && Date.now() - loadedAt < 60000) return
    pending = (async () => {
      try {
        const response = await fetchGroupNames()
        if (response.ok && response.data?.groups) {
          groupNames.value = response.data.groups
          loadedAt = Date.now()
        }
      } finally { pending = null }
    })()
    return pending
  }

  // 群号始终放在前面；没有真实名称时仅显示群号。
  function groupLabel(id: string): string {
    const name = groupNames.value[id]
    return name ? `${id} · ${name}` : id
  }

  return { groupNames, groupLabel, refreshGroupNames }
}
