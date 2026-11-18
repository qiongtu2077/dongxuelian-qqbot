import { ref } from 'vue'
import { fetchGroupNames } from '../api'

// 维护展示用群目录；读取失败保留群号，不影响配置编辑或提交。
export function useGroupNames() {
  const groupNames = ref<Record<string, string>>({})
  let loadedAt = 0
  let pending: { signal?: AbortSignal; promise: Promise<void> } | null = null

  // 每分钟最多刷新一次，手动刷新可以立即读取最新群名。
  async function refreshGroupNames(force = false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    if (pending && !pending.signal?.aborted) return pending.promise
    if (!force && loadedAt && Date.now() - loadedAt < 60000) return
    const promise = Promise.resolve().then(async () => {
      try {
        if (signal?.aborted) return
        const response = await (signal ? fetchGroupNames(signal) : fetchGroupNames())
        if (!signal?.aborted && response.ok && response.data?.groups) {
          groupNames.value = response.data.groups
          loadedAt = Date.now()
        }
      } finally { if (pending?.promise === promise) pending = null }
    })
    pending = { signal, promise }
    return promise
  }

  // 群号始终放在前面；没有真实名称时仅显示群号。
  function groupLabel(id: string): string {
    const name = groupNames.value[id]
    return name ? `${id} · ${name}` : id
  }

  return { groupNames, groupLabel, refreshGroupNames }
}
