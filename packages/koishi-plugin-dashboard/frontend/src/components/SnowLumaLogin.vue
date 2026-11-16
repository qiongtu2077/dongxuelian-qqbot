<template>
  <div class="card sl-login">
    <div class="sl-heading"><h2>SnowLuma 登录</h2><button class="btn btn-sm btn-ghost" :disabled="busy || protocolBusy" @click="loadLogin">刷新登录状态</button></div>
    <p class="hint">切换到 SL 后，NapCat 已停止。请依次确认协议、登录 QQ、完成机器人连接。</p>
    <div v-if="message" class="msg" :class="failure ? 'err' : 'ok'" role="status">{{ message }}</div>
    <div v-if="agreements?.consentRequired" class="sl-step">
      <h3>1. 阅读并确认协议</h3>
      <details v-for="document in agreements.documents" :key="document.id"><summary>{{ document.title }}</summary><pre>{{ document.text }}</pre></details>
      <label class="consent-check"><input v-model="accepted" type="checkbox" />我已阅读并同意上述用户协议与隐私政策</label>
      <button class="btn" :disabled="!accepted || busy || protocolBusy" @click="acceptAgreements">确认并继续</button>
    </div>
    <template v-else-if="agreements">
      <div class="sl-step">
        <h3>1. 在专用桌面登录机器人 QQ</h3>
        <p class="hint">点击打开桌面后，使用手机 QQ 扫码或操作 QQ 登录窗口。扫码、设备验证和账号选择均在下方桌面内完成。</p>
        <button class="btn" :disabled="busy || protocolBusy" @click="openDesktop">{{ busy ? '处理中…' : desktopUrl ? '重新连接扫码桌面' : '打开 QQ 扫码桌面' }}</button>
        <button v-if="desktopUrl" class="btn btn-sm btn-ghost" @click="desktopUrl = ''">关闭桌面</button>
        <iframe v-if="desktopUrl" :key="desktopUrl" :src="desktopUrl" title="SnowLuma QQ 扫码桌面" referrerpolicy="no-referrer" />
      </div>
      <div class="sl-step">
        <h3>2. 完成登录并连接机器人</h3>
        <p v-if="accounts.length">已识别 QQ：<span v-for="account in accounts" :key="account.uin" class="badge running">{{ account.nickname || 'QQ' }} · {{ account.uin }}</span></p>
        <p v-else class="hint">当前尚未识别到已登录的 QQ 会话。</p>
        <p v-for="process in processes" :key="process.pid" class="hint">QQ 接入状态：{{ process.status }} <span v-if="process.error">{{ process.error }}</span></p>
        <button class="btn" :disabled="busy || protocolBusy" @click="finishLogin">完成登录并连接 OneBot</button>
        <p class="hint">系统会核对当前项目的 QQ 号、配置 OneBot，并验证机器人的实际连接。</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { inject, onMounted, onUnmounted, onActivated, onDeactivated, ref, watch } from 'vue'
import { fetchSlLogin, acceptSlConsent, connectSl, openSlDesktop } from '../api'
import type { ApiResult, ShowAdminDialog } from '../types'
import { asRecord, messageFromData } from '../types'
import { selectedProtocol, protocolBusy } from '../services/protocol-state'

interface Agreements { version: string; consentRequired: boolean; documents: { id: string; title: string; text: string }[] }
interface Account { uin: string; nickname: string }
interface QqProcess { pid: number; status: string; error?: string }
const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
const agreements = ref<Agreements | null>(null)
const accounts = ref<Account[]>([])
const processes = ref<QqProcess[]>([])
const accepted = ref(false)
const busy = ref(false)
const message = ref('')
const failure = ref(false)
const desktopUrl = ref('')
let timer: ReturnType<typeof setInterval> | undefined

/** 统一处理管理员验证与上游失败，不把未完成登录标记为成功。 */
function check(result: ApiResult, retry: () => void | Promise<void>): boolean {
  if (result.code === 'ADMIN_REQUIRED') { showAdminDialog?.('SnowLuma 登录需要管理员密码', retry); return false }
  if (!result.ok) { failure.value = true; message.value = messageFromData(result.data, 'SnowLuma 请求失败'); return false }
  return true
}

/** 获取真实账号和协议确认状态；切换期间暂停轮询。 */
async function loadLogin() {
  if (selectedProtocol.value !== 'sl' || protocolBusy.value) return
  const result = await fetchSlLogin()
  if (!check(result, loadLogin) || selectedProtocol.value !== 'sl') return
  const data = asRecord(result.data)
  agreements.value = data.agreements as Agreements
  accounts.value = data.accounts as Account[]
  processes.value = data.processes as QqProcess[]
}

/** 用户明确确认后记录当前版本协议。 */
async function acceptAgreements() {
  if (!agreements.value || !accepted.value) return
  busy.value = true
  try {
    const result = await acceptSlConsent(agreements.value.version)
    if (check(result, acceptAgreements)) { failure.value = false; message.value = '协议已确认，请打开扫码桌面'; await loadLogin() }
  } finally { busy.value = false }
}

/** 先接入本项目 QQ，再取得一次性桌面票据；旧桌面随切换销毁。 */
async function openDesktop() {
  busy.value = true
  try {
    const connect = await connectSl()
    if (!check(connect, openDesktop)) return
    const result = await openSlDesktop()
    if (check(result, openDesktop)) { desktopUrl.value = String(asRecord(result.data).url); message.value = ''; failure.value = false }
  } finally { busy.value = false }
}

/** 核验登录账号、应用 OneBot 配置，并等待 Koishi 真正重连。 */
async function finishLogin() {
  busy.value = true
  try {
    const result = await connectSl()
    if (check(result, finishLogin)) {
      failure.value = asRecord(result.data).connected !== true
      message.value = messageFromData(result.data, '请完成 QQ 登录')
      await loadLogin()
    }
  } finally { busy.value = false }
}

watch(selectedProtocol, () => { desktopUrl.value = ''; agreements.value = null; accounts.value = []; processes.value = []; message.value = ''; if (selectedProtocol.value === 'sl') void loadLogin() })
watch(protocolBusy, value => { if (value) desktopUrl.value = ''; else if (selectedProtocol.value === 'sl') void loadLogin() })
/** 显示时刷新，隐藏或离开终端页时停止轮询并断开桌面。 */
function activatePanel() {
  void loadLogin()
  if (!timer) timer = setInterval(() => { if (!busy.value && agreements.value && !agreements.value.consentRequired) void loadLogin() }, 5000)
}
/** 回收 KeepAlive 隐藏页中的网络和桌面资源。 */
function releasePanel() { desktopUrl.value = ''; if (timer) clearInterval(timer); timer = undefined }
onMounted(activatePanel)
onActivated(activatePanel)
onDeactivated(releasePanel)
onUnmounted(releasePanel)
</script>

<style scoped>
.sl-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.sl-heading h2{margin:0}
.hint{color:var(--text3);font-size:13px;line-height:1.7}.sl-step{margin-top:22px}h3{font-size:14px;color:var(--info)}
iframe{display:block;width:100%;height:620px;border:1px solid var(--border);border-radius:10px;margin-top:16px;background:#111}
details{margin:12px 0;border:1px solid var(--border);padding:12px;border-radius:8px}summary{cursor:pointer}
pre{max-height:300px;overflow:auto;white-space:pre-wrap;line-height:1.7;font-size:12px}
.consent-check{display:flex;align-items:center;gap:10px;margin:16px 0;font-size:13px}.consent-check input{width:auto}
button+button{margin-left:10px}@media(max-width:760px){iframe{height:520px}.sl-heading{align-items:flex-start}}
</style>
