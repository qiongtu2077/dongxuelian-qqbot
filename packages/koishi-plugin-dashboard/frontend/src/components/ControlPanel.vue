<template>
  <div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <h2 style="margin:0 0 8px 0">Bot 运行节点</h2>
        <div style="font-size:13px;color:var(--text3)">
          Worker 并发进程：{{ status.workers || 0 }}
        </div>
      </div>
      <div>
        <span v-if="status.loading" class="badge" style="color:var(--text3)">检测中...</span>
        <span v-else :class="['badge', status.running ? 'running' : 'stopped']">
          <span :class="['status-dot', status.running ? 'active' : 'offline']"></span>
          {{ status.running ? 'Online - 运行中' : 'Offline - 已停止' }}
        </span>
      </div>
    </div>

    <div class="card">
      <h2>引擎控制</h2>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn" @click="doStart" :disabled="acting || pendingVerify || status.running">
          {{ acting ? '节点拉起中...' : pendingVerify ? '启动验证中...' : '▶ 启动引擎' }}
        </button>
        <button class="btn btn-ghost" style="border-color:var(--danger);color:var(--danger)" @click="doStop" :disabled="acting || pendingVerify || !status.running">
          {{ acting ? '终止信号发送中...' : '■ 强制停止' }}
        </button>
      </div>
      <div v-if="resultMsg" class="msg" :class="resultMsg.type" style="margin-top:16px">{{ resultMsg.text }}</div>
    </div>

    <div class="card">
      <div>
        <h2 style="margin:0 0 16px">网络协议与终端配置</h2>
        <div style="font-size:14px;color:var(--text2);margin-bottom:20px;display:flex;align-items:center;gap:8px">
          当前挂载 QQ 标识：<span class="badge running" style="font-family:monospace;font-size:14px">{{ status.qq || '未挂载' }}</span>
        </div>

        <div style="margin-bottom:24px">
          <div style="color:var(--info);font-weight:700;margin-bottom:8px;font-size:14px">Step 1：建立安全隧道 (SSH Port Forwarding)</div>
          <div style="font-size:13px;color:var(--text3);margin-bottom:12px">在宿主机终端执行以下指令，映射 6099 端口至本地。</div>
          <input v-model="sshHost" @blur="onSSHHostBlur" @change="saveSSHHost" placeholder="仅填 IP 或域名（勿粘贴 http:// 整段地址）" style="width:100%;max-width:360px;margin-bottom:12px;font-family:monospace" />
          <div class="terminal-block">
            <code id="ssh-cmd">ssh -L 6099:localhost:6099 {{ sshUser }}@{{ sshHostDisplay }}</code>
            <button class="icon-btn" type="button" @click="copyText('ssh-cmd')" title="复制命令">
              <svg viewBox="0 0 24 24" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
        </div>

        <div style="margin-bottom:24px">
          <div style="color:var(--accent);font-weight:700;margin-bottom:8px;font-size:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span>Step 2：协议端身份验证 (NapCat Auth)</span>
            <button class="btn btn-sm btn-ghost" type="button" @click="requestQQToken">查看 NapCat token</button>
          </div>
          <div class="terminal-block terminal-block--emphasis">
            <code id="napcat-token">{{ displayNapcatToken }}</code>
            <div style="display:flex;gap:8px">
              <button class="icon-btn" type="button" style="border:none;background:transparent" @click="showNapcatToken = !showNapcatToken" :title="showNapcatToken ? '隐藏 Token' : '显示 Token'">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                  <path v-if="!showNapcatToken" d="M4 20 20 4" style="stroke:var(--danger)" />
                </svg>
              </button>
              <button class="icon-btn" type="button" @click="copyValue(napcatToken)" title="复制 Token">
                <svg viewBox="0 0 24 24" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            </div>
          </div>
          <a href="http://localhost:6099/webui/" target="_blank" class="btn btn-ghost btn-sm" style="margin-top:12px;text-decoration:none;display:inline-block">→ 打开 WebUI 控制台扫码</a>
        </div>

        <div style="background:rgba(244,114,182,0.1);border-left:4px solid var(--danger);border-radius:0 8px 8px 0;padding:12px 16px;font-size:13px;color:#fca5a5;margin-bottom:24px">
          ⚠ 必须在 WebUI 中扫码登录新账号并确保在线，才能执行下一步覆盖操作。
        </div>

        <div>
          <div style="color:var(--info);font-weight:700;margin-bottom:8px;font-size:14px">Step 3：热重载监听目标</div>
          <div style="display:flex;gap:12px;max-width:400px;align-items:center">
            <input v-model="newSelfId" placeholder="输入新的监听 QQ 号" style="font-family:monospace" />
            <button class="btn btn-sm" @click="saveSelfId" :disabled="savingSelfId" style="white-space:nowrap">{{ savingSelfId ? '覆写中...' : '重载配置' }}</button>
          </div>
          <div v-if="selfIdMsg" style="margin-top:12px;font-size:13px" :style="{color: selfIdMsg.type === 'ok' ? 'var(--success)' : 'var(--error)'}">{{ selfIdMsg.text }}</div>
        </div>

        <div v-if="copiedMsg" style="margin-top:16px;font-size:13px;color:var(--accent);text-align:center;font-weight:700;animation:fadeIn 0.2s">{{ copiedMsg }}</div>
      </div>
    </div>

    <div class="card">
      <h2>诊断测试</h2>
      <button class="btn btn-sm" @click="testStartBot">测试 startBot API</button>
      <div v-if="diagMsg" class="msg" style="margin-top:8px;font-size:12px;white-space:pre-wrap;font-family:monospace">{{ diagMsg }}</div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="margin:0 0 4px">维护模式</h2>
          <div style="font-size:13px;color:var(--text3)">开启后 bot 回复"优化中"，不触发 AI</div>
        </div>
        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer">
          <input type="checkbox" v-model="maintenanceOn" @change="toggleMaintenance" :disabled="maintLoading" style="opacity:0;width:0;height:0" />
          <span :style="{
            position:'absolute',inset:0,background:maintenanceOn ? 'var(--success)' : 'var(--border)',borderRadius:'13px',transition:'.2s'
          }">
            <span :style="{
              position:'absolute',top:'3px',left:maintenanceOn ? '25px' : '3px',width:'20px',height:'20px',background:'#fff',borderRadius:'50%',transition:'.2s',boxShadow:'0 2px 4px rgba(0,0,0,0.2)'
            }"></span>
          </span>
        </label>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, ref, onMounted, onActivated, inject } from 'vue'
import { botStatus, startBot, stopBot, fetchMaintenance, setMaintenance, fetchQQToken, fetchSSHInfo, fetchSelfId, updateSelfId } from '../api'

export default {
  name: 'ControlPanel',
  setup() {
    const showAdminDialog = inject('showAdminDialog')

    const status = ref({ loading: true, running: false, workers: 0 })
    const acting = ref(false)
    const pendingVerify = ref(false)
    const resultMsg = ref(null)
    const maintenanceOn = ref(false)
    const maintLoading = ref(false)
    const napcatToken = ref('')
    const tokenIsReal = ref(false)
    const showNapcatToken = ref(false)
    const copiedMsg = ref('')
    const displayNapcatToken = computed(() => {
      if (!tokenIsReal.value) return napcatToken.value || '点击查看 NapCat token 后显示'
      return showNapcatToken.value ? napcatToken.value : maskSecret(napcatToken.value)
    })

    function maskSecret(value) {
      const raw = String(value || '')
      if (!raw) return '加载中...'
      if (raw.length <= 3) return raw
      return raw.slice(0, 3) + '*'.repeat(raw.length - 3)
    }

    function normalizeSSHHost(raw) {
      let s = String(raw ?? '').trim()
      if (!s) return ''
      s = s.replace(/^https?:\/\//i, '')
      s = s.split('/')[0].split('?')[0].split('#')[0]
      let host = s
      const atIdx = host.lastIndexOf('@')
      if (atIdx >= 0) host = host.slice(atIdx + 1)
      host = host.replace(/:([0-9]+)$/, '')
      return host.trim()
    }

    const sshHost = ref(normalizeSSHHost(localStorage.getItem('dashboard_ssh_host') || ''))

    const sshHostDisplay = computed(() => {
      const h = normalizeSSHHost(sshHost.value)
      return h || '服务器IP'
    })

    const sshUser = ref('root')
    const newSelfId = ref('')
    const savingSelfId = ref(false)
    const selfIdMsg = ref(null)
    const diagMsg = ref('')

    onActivated(() => {
      acting.value = false
      loadStatus()
    })

    async function loadStatus() {
      const res = await botStatus()
      if (res.ok) status.value = { loading: false, ...res.data }
      else status.value = { loading: false, running: false, workers: 0 }
    }
    async function loadMaintenance() {
      const res = await fetchMaintenance()
      if (res.ok) maintenanceOn.value = res.data.enabled
    }
    async function loadQQToken() {
      const res = await fetchQQToken()
      if (res.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog('查看 NapCat Token 需要管理员密码', loadQQToken)
        napcatToken.value = '点击[查看 NapCat token]后显示'
        tokenIsReal.value = false
        return
      }
      if (res.ok && res.data?.token) {
        napcatToken.value = res.data.token
        tokenIsReal.value = true
      }
    }
    function requestQQToken() {
      loadQQToken()
    }
    async function loadSSHInfo() {
      const res = await fetchSSHInfo()
      if (res.ok && res.data) {
        if (res.data.host && !sshHost.value) sshHost.value = normalizeSSHHost(res.data.host)
        if (res.data.user) sshUser.value = res.data.user
      }
    }
    async function loadSelfId() {
      const res = await fetchSelfId()
      if (res.ok && res.data?.selfId) newSelfId.value = res.data.selfId
    }
    async function saveSelfId() {
      if (!newSelfId.value.trim() || !/^\d+$/.test(newSelfId.value.trim())) {
        selfIdMsg.value = { type: 'err', text: '无效 QQ 号' }; return
      }
      savingSelfId.value = true; selfIdMsg.value = null
      try {
        const res = await updateSelfId(newSelfId.value.trim())
        if (res.code === 'ADMIN_REQUIRED') {
          if (showAdminDialog) showAdminDialog('更换 QQ 号需要管理员密码', saveSelfId)
          savingSelfId.value = false
          return
        }
        selfIdMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已保存，Koishi 正在重启' : '保存失败') }
      } catch (e) { selfIdMsg.value = { type: 'err', text: e.message }
      } finally { savingSelfId.value = false }
    }

    function saveSSHHost() {
      sshHost.value = normalizeSSHHost(sshHost.value)
      localStorage.setItem('dashboard_ssh_host', sshHost.value)
    }

    function onSSHHostBlur() {
      saveSSHHost()
    }

    onMounted(() => { loadStatus(); loadMaintenance(); loadSSHInfo(); loadSelfId() })

    async function testStartBot() {
      diagMsg.value = '发起请求...'
      try {
        const res = await startBot()
        diagMsg.value = '返回: ' + JSON.stringify({ ok: res.ok, code: res.code, data: res.data }, null, 2)
      } catch (e) {
        diagMsg.value = '异常: ' + e.message
      }
      setTimeout(() => diagMsg.value = '', 8000)
    }

    function copyText(id) {
      const el = document.getElementById(id)
      if (!el) return
      const text = el.textContent || el.innerText
      try {
        navigator.clipboard.writeText(text.trim()).then(() => {
          copiedMsg.value = '已复制'
          setTimeout(() => copiedMsg.value = '', 2000)
        }).catch(() => fallbackCopy(text))
      } catch { fallbackCopy(text) }
    }

    function copyValue(value) {
      if (!tokenIsReal.value) {
        window.alert('不验证密码就想获得token？')
        return
      }
      const text = String(value || '').trim()
      if (!text) return
      try {
        navigator.clipboard.writeText(text).then(() => {
          copiedMsg.value = '已复制'
          setTimeout(() => copiedMsg.value = '', 2000)
        }).catch(() => fallbackCopy(text))
      } catch { fallbackCopy(text) }
    }

    function fallbackCopy(text) {
      const ta = document.createElement('textarea')
      ta.value = text.trim()
      ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); copiedMsg.value = '已复制' } catch {}
      document.body.removeChild(ta)
      setTimeout(() => copiedMsg.value = '', 2000)
    }

    async function doStart() {
      acting.value = true; resultMsg.value = null
      try {
        const res = await startBot()
        if (res.code === 'ADMIN_REQUIRED') {
          if (showAdminDialog) showAdminDialog('启动 Bot 需要管理员密码', doStart)
          acting.value = false
          return
        }
        resultMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已发送启动命令，等待 15 秒验证...' : '启动失败') }
        if (res.ok) {
          pendingVerify.value = true
          setTimeout(() => { loadStatus(); pendingVerify.value = false }, 15000)
        } else loadStatus()
      } catch (e) { resultMsg.value = { type: 'err', text: e.message }
      } finally { acting.value = false }
    }

    async function doStop() {
      acting.value = true; resultMsg.value = null
      try {
        const res = await stopBot()
        if (res.code === 'ADMIN_REQUIRED') {
          if (showAdminDialog) showAdminDialog('停止 Bot 需要管理员密码', doStop)
          acting.value = false
          return
        }
        resultMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已停止' : '停止失败') }
        loadStatus()
      } catch (e) { resultMsg.value = { type: 'err', text: e.message }
      } finally { acting.value = false }
    }

    async function toggleMaintenance(targetValue = maintenanceOn.value) {
      maintenanceOn.value = targetValue
      maintLoading.value = true
      const res = await setMaintenance(targetValue)
      if (res.code === 'ADMIN_REQUIRED') {
        maintenanceOn.value = !targetValue
        if (showAdminDialog) showAdminDialog('维护模式需要管理员密码', () => toggleMaintenance(targetValue))
        maintLoading.value = false
        return
      }
      if (!res.ok) maintenanceOn.value = !maintenanceOn.value
      maintLoading.value = false
    }

    return { status, acting, pendingVerify, resultMsg, maintenanceOn, maintLoading, napcatToken, showNapcatToken, displayNapcatToken, copiedMsg, sshHost, sshHostDisplay, newSelfId, savingSelfId, selfIdMsg, diagMsg, copyText, copyValue, requestQQToken, saveSSHHost, onSSHHostBlur, saveSelfId, doStart, doStop, toggleMaintenance, testStartBot, sshUser }
  }
}
</script>
