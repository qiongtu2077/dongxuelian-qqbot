<template>
  <div>
    <!-- Bot 状态卡片 -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">Bot 状态</h2>
        <span v-if="status.loading" style="color:var(--text3)">检测中...</span>
        <span v-else :style="{color: status.running ? '#39C5BB' : '#F472B6', fontSize:'14px', fontWeight:'700'}">
          {{ status.running ? '● 运行中' : '● 已停止' }}
        </span>
      </div>
      <div v-if="status.running" style="font-size:13px;color:var(--text3);margin-top:4px">
        Worker 数量：{{ status.workers }}
      </div>
    </div>

    <!-- 控制按钮 -->
    <div class="card">
      <h2>控制</h2>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn" @click="doStart" :disabled="acting || status.running">
          {{ acting ? '执行中...' : '▶ 启动 Bot' }}
        </button>
        <button class="btn" style="background:#F472B6" @click="doStop" :disabled="acting || !status.running">
          {{ acting ? '执行中...' : '■ 停止 Bot' }}
        </button>
      </div>
      <div v-if="resultMsg" class="msg" :class="resultMsg.type" style="margin-top:12px">{{ resultMsg.text }}</div>
    </div>

    <!-- QQ 管理 -->
    <div class="card">
      <div>
        <h2 style="margin:0 0 4px">QQ 管理</h2>
          <div style="font-size:13px;color:var(--text2);margin-bottom:16px">
          当前 QQ：<span style="font-family:monospace;color:#39C5BB">{{ status.qq || '未知' }}</span>
        </div>

        <!-- 步骤一：SSH 隧道 -->
        <div style="background:var(--input);border-radius:8px;padding:14px 16px;font-size:13px;margin-bottom:12px">
          <div style="color:#39C5BB;font-weight:700;margin-bottom:8px">步骤一：输入你的服务器 IP 地址</div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:6px">在电脑的 CMD 终端复制下面的指令开启隧道（请不要关掉）</div>
          <input v-model="sshHost" @change="saveSSHHost" placeholder="服务器 IP 或域名" style="width:100%;margin-bottom:8px;font-family:monospace" />
          <div style="display:flex;gap:8px">
            <code id="ssh-cmd" style="flex:1;background:var(--input);border-radius:6px;padding:10px 14px;font-size:12px;color:var(--accent);font-family:monospace">ssh -L 6099:localhost:6099 {{ sshUser }}@{{ sshHost || '服务器IP' }}</code>
            <button class="btn btn-sm" style="white-space:nowrap" @click="copyText('ssh-cmd')">复制</button>
          </div>
        </div>

        <!-- 步骤二：NapCat 扫码 -->
        <div style="background:var(--input);border-radius:8px;padding:14px 16px;font-size:13px;margin-bottom:12px">
          <div style="color:#FCD34D;font-weight:700;margin-bottom:8px">步骤二：在 NapCat 扫码登新号</div>
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <code id="napcat-token" style="flex:1;background:var(--input);border-radius:6px;padding:10px 14px;font-size:12px;color:#FCD34D;font-family:monospace">{{ napcatToken || '加载中...' }}</code>
            <button class="btn btn-sm" style="white-space:nowrap" @click="copyText('napcat-token')">复制</button>
          </div>
          <a href="http://localhost:6099/webui/" target="_blank" class="btn btn-sm" style="display:inline-block;text-decoration:none">打开 NapCat 管理面板</a>
        </div>

        <!-- 警告分隔 -->
        <div style="background:rgba(244,114,182,0.1);border:1px solid rgba(244,114,182,0.3);border-radius:8px;padding:10px 14px;font-size:12px;color:#F472B6;margin-bottom:12px">
          ⚠ 请先在 NapCat 完成扫码登录，再进行第三步
        </div>

        <!-- 步骤三：更新 Koishi -->
        <div style="background:var(--input);border-radius:8px;padding:14px 16px;font-size:13px">
          <div style="color:#39C5BB;font-weight:700;margin-bottom:8px">步骤三：更新 Koishi QQ 号</div>
          <input v-model="newSelfId" placeholder="输入新 QQ 号" style="width:100%;margin-bottom:8px;font-family:monospace" />
          <button class="btn btn-sm" @click="saveSelfId" :disabled="savingSelfId">{{ savingSelfId ? '保存中...' : '保存并重启 Koishi' }}</button>
          <div v-if="selfIdMsg" style="margin-top:8px;font-size:12px" :style="{color: selfIdMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ selfIdMsg.text }}</div>
        </div>

        <div v-if="copiedMsg" style="margin-top:8px;font-size:12px;color:#39C5BB;text-align:center">{{ copiedMsg }}</div>
      </div>
    </div>

    <!-- 诊断 -->
    <div class="card">
      <h2>诊断</h2>
      <button class="btn btn-sm" @click="testStartBot">测试 startBot API</button>
      <div v-if="diagMsg" class="msg" style="margin-top:8px;font-size:12px;white-space:pre-wrap;font-family:monospace">{{ diagMsg }}</div>
    </div>

    <!-- 维护模式 -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="margin:0 0 4px">维护模式</h2>
          <div style="font-size:13px;color:var(--text3)">开启后 bot 回复"优化中"，不触发 AI</div>
        </div>
        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer">
          <input type="checkbox" v-model="maintenanceOn" @change="toggleMaintenance" :disabled="maintLoading" style="opacity:0;width:0;height:0" />
          <span :style="{
            position:'absolute',inset:0,background:maintenanceOn ? '#39C5BB' : 'var(--border)',borderRadius:'13px',transition:'.2s'
          }">
            <span :style="{
              position:'absolute',top:'3px',left:maintenanceOn ? '25px' : '3px',width:'20px',height:'20px',background:'#fff',borderRadius:'50%',transition:'.2s'
            }"></span>
          </span>
        </label>
      </div>
    </div>
  </div>
  <!-- 管理员验证弹窗（全局，由 App.vue 提供） -->
</template>

<script>
import { ref, onMounted, onActivated } from 'vue'
import { botStatus, startBot, stopBot, fetchMaintenance, setMaintenance, fetchQQToken, fetchSSHInfo, fetchSelfId, updateSelfId } from '../api'

export default {
  name: 'ControlPanel',
  components: { },
  setup() {
    const status = ref({ loading: true, running: false, workers: 0 })
    const acting = ref(false)
    const resultMsg = ref(null)
    const maintenanceOn = ref(false)
    const maintLoading = ref(false)
    const napcatToken = ref('')
    const copiedMsg = ref('')
    const sshHost = ref(localStorage.getItem('dashboard_ssh_host') || '')
    const sshUser = ref('root')
    const newSelfId = ref('')
    const savingSelfId = ref(false)
    const selfIdMsg = ref(null)
    const diagMsg = ref('')

    // KeepAlive 缓存激活时重置状态
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
      if (res.ok && res.data?.token) napcatToken.value = res.data.token
    }
    async function loadSSHInfo() {
      const res = await fetchSSHInfo()
      if (res.ok && res.data) {
        if (res.data.host && !sshHost.value) sshHost.value = res.data.host
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
          window.showAdminDialog && window.showAdminDialog('更换 QQ 号需要管理员密码', saveSelfId)
          return
        }
        selfIdMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已保存，Koishi 正在重启' : '保存失败') }
      } catch (e) { selfIdMsg.value = { type: 'err', text: e.message }
      } finally { savingSelfId.value = false }
    }

    function onAdminVerified() {
    }
    function saveSSHHost() {
      localStorage.setItem('dashboard_ssh_host', sshHost.value)
    }

    onMounted(() => { loadStatus(); loadMaintenance(); loadQQToken(); loadSSHInfo(); loadSelfId() })

    async function testStartBot() {
      diagMsg.value = '发起请求...'
      try {
        const res = await startBot()
        diagMsg.value = '返回: ' + JSON.stringify({ ok: res.ok, code: res.code, data: res.data }, null, 2)
      } catch (e) {
        diagMsg.value = '异常: ' + e.message
      }
      // 3 秒后清除
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
          window.showAdminDialog && window.showAdminDialog('启动 Bot 需要管理员密码', doStart)
          return
        }
        resultMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已发送启动命令，等待 15 秒验证...' : '启动失败') }
        if (res.ok) setTimeout(loadStatus, 15000)
        else loadStatus()
      } catch (e) { resultMsg.value = { type: 'err', text: e.message }
      } finally { acting.value = false }
    }

    async function doStop() {
      acting.value = true; resultMsg.value = null
      try {
        const res = await stopBot()
        if (res.code === 'ADMIN_REQUIRED') {
          window.showAdminDialog && window.showAdminDialog('停止 Bot 需要管理员密码', doStop)
          return
        }
        resultMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已停止' : '停止失败') }
        loadStatus()
      } catch (e) { resultMsg.value = { type: 'err', text: e.message }
      } finally { acting.value = false }
    }

    async function toggleMaintenance() {
      maintLoading.value = true
      const res = await setMaintenance(maintenanceOn.value)
      if (res.code === 'ADMIN_REQUIRED') {
        window.showAdminDialog && window.showAdminDialog('维护模式需要管理员密码', () => toggleMaintenance())
        maintLoading.value = false
        return
      }
      if (!res.ok) maintenanceOn.value = !maintenanceOn.value
      maintLoading.value = false
    }

    return { status, acting, resultMsg, maintenanceOn, maintLoading, napcatToken, copiedMsg, sshHost, sshUser, newSelfId, savingSelfId, selfIdMsg, diagMsg, copyText, saveSSHHost, saveSelfId, doStart, doStop, toggleMaintenance, testStartBot }
  }
}
</script>
