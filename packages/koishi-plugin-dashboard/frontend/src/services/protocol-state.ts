/** 在顶部菜单与终端面板之间共享服务端确认的协议状态。 */
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

/** 同步服务器实际选择，刷新失败时保留最后一次已确认状态。 */
export async function refreshProtocol(): Promise<void> {
  const result = await fetchProtocolStatus()
  if (result.ok) protocolState.value = result.data as ProtocolStatus
}
