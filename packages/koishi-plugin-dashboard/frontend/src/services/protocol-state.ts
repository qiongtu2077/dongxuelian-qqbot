/** 在顶部菜单与终端面板之间分别共享服务端协议状态和本地查看选择。 */
import { computed, ref } from 'vue'
import { fetchProtocolStatus } from '../api'

export type Protocol = 'napcat' | 'sl'
export interface ProtocolStatus {
  supported: boolean
  selected: Protocol
  switching: boolean
  conflict?: boolean
  installed?: boolean
  napcat?: { state: string; pid: number }
  sl?: { state: string; pid: number }
}
export const protocolState = ref<ProtocolStatus | null>(null)
export const protocolBusy = ref(false)
export const selectedProtocol = computed(() => protocolState.value?.selected || 'napcat')
// 未操作菜单时跟随服务端；浏览选择只保存在本地，不触发协议启停。
export const protocolView = ref<Protocol | null>(null)
export const viewedProtocol = computed(() => protocolView.value || selectedProtocol.value)

/** 同步服务器实际选择，刷新失败时保留最后一次已确认状态。 */
export async function refreshProtocol(): Promise<void> {
  const result = await fetchProtocolStatus()
  if (result.ok) protocolState.value = result.data as ProtocolStatus
}
