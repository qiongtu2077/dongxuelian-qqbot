<template>
  <div v-if="protocolState?.supported" class="protocol-switcher">
    <label for="qq-protocol">QQ 协议</label>
    <select id="qq-protocol" :value="selectedProtocol" :disabled="protocolBusy || protocolState.switching" @change="selectProtocol">
      <option value="napcat">NapCat</option>
      <option value="sl" :disabled="!protocolState.installed">SnowLuma (SL)</option>
    </select>
    <button class="btn btn-sm btn-ghost" :disabled="protocolBusy || protocolState.switching" @click="activate(selectedProtocol)">{{ protocolBusy ? '正在切换…' : '启动 / 重启' }}</button>
    <span v-if="message" role="status" :class="{ failure }">{{ message }}</span>
    <span v-if="protocolState.conflict" class="failure" role="alert">协议运行冲突，请重新选择协议</span>
  </div>
</template>

<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref } from 'vue'
import { changeProtocol } from '../api'
import { asRecord, messageFromData } from '../types'
import type { ShowAdminDialog } from '../types'
import { protocolState, protocolBusy, selectedProtocol, refreshProtocol } from '../services/protocol-state'
import type { Protocol, ProtocolStatus } from '../services/protocol-state'
const emit = defineEmits<{ switched: [] }>()
const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const message = ref('')
const failure = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

/** 请求真实服务切换；管理员验证后重试原目标，不提前改变界面选择。 */
async function activate(provider: Protocol) {
  if (protocolBusy.value) return
  protocolBusy.value = true
  message.value = '正在停止当前协议并启动目标协议…'
  failure.value = false
  try {
    const result = await changeProtocol(provider)
    if (result.code === 'ADMIN_REQUIRED') {
      message.value = ''
      showAdminDialog?.('切换 QQ 协议需要管理员密码', () => activate(provider))
      return
    }
    failure.value = !result.ok
    message.value = messageFromData(result.data, result.ok ? '切换完成，请完成登录' : '切换失败')
    if (result.ok) {
      protocolState.value = asRecord(result.data).status as ProtocolStatus
      emit('switched')
    }
    await refreshProtocol()
  } finally { protocolBusy.value = false }
}

/** 只接受菜单定义的两个协议值。 */
function selectProtocol(event: Event) {
  const select = event.target as HTMLSelectElement
  const provider = select.value
  select.value = selectedProtocol.value
  if (provider === 'napcat' || provider === 'sl') void activate(provider)
}

onMounted(() => { void refreshProtocol(); timer = setInterval(() => { if (!protocolBusy.value) void refreshProtocol() }, 10000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.protocol-switcher{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;flex:1}
select{flex:0 0 180px;width:180px;max-width:180px;min-width:150px;padding:7px 10px}
label{color:var(--text2);white-space:nowrap}
[role=status]{font-size:12px;color:var(--success);flex-basis:100%}
.failure{color:var(--danger)!important}
</style>
