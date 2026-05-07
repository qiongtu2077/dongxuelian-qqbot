<template>
  <div class="card">
    <details style="font-size:13px;color:var(--text2);margin-bottom:12px">
      <summary style="cursor:pointer;font-weight:700;color:var(--accent)">📖 使用说明（点击展开）</summary>
      <div style="margin-top:8px;line-height:1.7;background:var(--input);border-radius:8px;padding:14px 16px;font-size:12px;color:var(--text2)">
        <p><b>什么是部署面板？</b>在浏览器里配置远程服务器信息，一键将本地所有插件、前端、配置文件推送到远程服务器并重启 Bot。适合初次部署或日常更新。</p>
        <p><b>前置条件</b>：本机已配置 SSH 密钥认证（<code>~/.ssh/id_rsa</code>），能免密码 <code>ssh root@服务器IP</code>。</p>
        <p><b>使用步骤：</b></p>
        <ol style="margin-left:16px">
           <li>填写服务器地址（如 <code>root@your-server.com</code>）和应用目录 → 保存配置</li>
          <li>（可选）展开密码设置，填写目标服务器的访问密码和管理员密码；留空则使用默认密码 <code>123456</code></li>
          <li>（可选）视频插件需要 B 站 Cookies，按提示从浏览器导出 <code>cookies.txt</code> 上传</li>
          <li>点「开始部署」→ 实时查看部署日志，约 30 秒完成</li>
          <li>部署完成后点「打开已部署面板」进入远程服务器的 Dashboard</li>
        </ol>
        <p><b>部署内容</b>：所有插件代码、Dashboard 前端 + 后端、数据文件、API Key、重启脚本、视频插件依赖（yt-dlp）。</p>
        <p><b>注意事项</b>：密码设置只对目标服务器生效，不影响当前运行中的控制台。部署面板可独立使用——任何有 Node.js 的机器上运行 <code>node standalone.js</code> 即可获得完整部署工具。</p>
      </div>
    </details>

    <h2>部署配置</h2>
    <div style="display:grid;gap:12px">
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">服务器地址</div>
        <input v-model="server" placeholder="root@your-server.com" style="width:100%" />
      </div>
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">应用目录</div>
        <input v-model="appDir" placeholder="/root/koishi-app" style="width:100%" />
      </div>
      <details open style="font-size:13px;color:var(--text3)">
        <summary style="cursor:pointer;color:var(--text2)">密码设置（部署到新服务器时使用）</summary>
        <div style="margin-top:8px;display:grid;gap:8px">
          <div>
            <div style="font-size:12px;margin-bottom:2px">访问密码</div>
            <input v-model="accessPwd" placeholder="留空则使用默认" style="width:100%;font-size:13px" />
          </div>
          <div>
            <div style="font-size:12px;margin-bottom:2px">管理员密码</div>
            <input v-model="adminPwd" placeholder="留空则使用默认" style="width:100%;font-size:13px" />
          </div>
        </div>
      </details>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" @click="doSave" :disabled="saving">{{ saving ? '保存中...' : '保存配置' }}</button>
        <button class="btn" @click="connectRemote" :disabled="!server.trim() || connecting" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">{{ connecting ? '连接中...' : '🔗 连接远程' }}</button>
        <span v-if="saveMsg" style="margin-left:4px;font-size:13px" :style="{color: saveMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ saveMsg.text }}</span>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>一键部署</h2>
    <p style="font-size:13px;color:var(--text2);margin-bottom:12px">将本地所有插件、前端、配置文件推送到远程服务器并重启 Bot。</p>

    <div style="margin-bottom:12px;padding:12px;background:rgba(57,197,187,0.06);border:1px solid rgba(57,197,187,0.15);border-radius:8px">
      <div style="font-size:13px;color:var(--text2);margin-bottom:6px">B站 Cookies（可选，视频插件需要）</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="file" accept=".txt" @change="onCookiesFile" style="font-size:12px;flex:1" />
        <span v-if="cookiesName" style="font-size:12px;color:var(--accent)">{{ cookiesName }} ✓</span>
      </div>
      <details style="margin-top:6px;font-size:11px;color:var(--text3)">
        <summary style="cursor:pointer">如何导出？</summary>
        <div style="margin-top:4px;line-height:1.6">1. Chrome 安装「Get cookies.txt」扩展<br/>2. 登录 bilibili.com<br/>3. 点扩展图标 → Export → 保存 cookies.txt<br/>4. 上传到上方</div>
      </details>
    </div>

    <button class="btn" @click="doDeploy" :disabled="deploying">{{ deploying ? '部署中...' : '开始部署' }}</button>
    <button class="btn" @click="doUpdate" :disabled="updating || !updateAvailable" style="margin-left:8px;background:var(--tabBg);color:var(--tabColor);border:1px solid var(--tabBorder)">{{ updating ? '更新中...' : '更新部署' }}</button>
    <button class="btn btn-sm" @click="doCheckUpdate" :disabled="checking" style="margin-left:8px;background:transparent;border:1px solid var(--accent);color:var(--accent)">{{ checking ? '检查中...' : '检查更新' }}</button>
    <div v-if="updateStatus" style="margin-top:8px;font-size:13px" :style="{color: updateStatus.type === 'ok' ? '#39C5BB' : updateStatus.type === 'info' ? 'var(--text2)' : '#F472B6'}">{{ updateStatus.text }}</div>
    <span v-if="deployMsg" style="margin-left:12px;font-size:13px" :style="{color: deployMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ deployMsg.text }}</span>

    <div v-if="logLines.length" style="margin-top:12px;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;font-family:monospace;max-height:400px;overflow:auto;white-space:pre-wrap;line-height:1.5">
      <div v-for="(line, i) in logLines" :key="i" :style="{color: line.startsWith('❌') ? '#F472B6' : line.startsWith('$') ? 'var(--accent)' : line.includes('✅') ? '#39C5BB' : 'var(--text2)'}">{{ line }}</div>
    </div>

    <div v-if="deployDone" style="margin-top:12px;display:flex;gap:8px;align-items:center">
      <span style="color:#39C5BB;font-weight:700">✅ 部署完成</span>
      <button class="btn btn-sm" @click="openRemote">打开已部署面板</button>
    </div>
    <div v-else-if="server.trim() && !deploying" style="margin-top:12px">
      <button class="btn btn-sm" @click="openRemote" style="background:transparent;border:1px solid #6366f1;color:#6366f1">🔗 查看远程 Dashboard</button>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import { fetchDeployConfig, saveDeployConfig, runDeploy, fetchDeployProgress, confirmDeployed, checkDeployUpdate, getAdminToken } from '../api'

export default {
  name: 'DeployPanel',
  setup() {
    const server = ref('')
    const appDir = ref('/root/koishi-app')
    const saving = ref(false)
    const saveMsg = ref(null)
    const deploying = ref(false)
    const logLines = ref([])
    const deployDone = ref(false)
    const deployMsg = ref(null)
    const updateStatus = ref(null)
    const updateAvailable = ref(false)
    const checking = ref(false)
    const updating = ref(false)
    const cookiesName = ref('')
    const accessPwd = ref('')
    const adminPwd = ref('')
    const connecting = ref(false)

    function onCookiesFile(e) {
      const file = e.target.files?.[0]
      if (!file) return
      cookiesName.value = file.name
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1]
        await fetch('/dashboard/api/deploy/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(localStorage.getItem('dashboard_token') ? { Authorization: 'Bearer ' + localStorage.getItem('dashboard_token') } : {}),
            ...(getAdminToken() ? { 'X-Admin-Token': getAdminToken() } : {}),
          },
          body: JSON.stringify({ name: 'bilibili-cookies.txt', data: base64 }),
        })
      }
      reader.readAsDataURL(file)
    }

    async function load() {
      const res = await fetchDeployConfig()
      if (res.ok) { server.value = res.data.server || ''; appDir.value = res.data.appDir || '/root/koishi-app' }
    }
    onMounted(load)

    async function doSave() {
      if (!server.value.trim()) { saveMsg.value = { type: 'err', text: '请输入服务器地址' }; return }
      saving.value = true; saveMsg.value = null
      const res = await saveDeployConfig({ server: server.value.trim(), appDir: appDir.value.trim(), accessPwd: accessPwd.value, adminPwd: adminPwd.value })
      if (res.code === 'ADMIN_REQUIRED') { saving.value = false; window.showAdminDialog && window.showAdminDialog('保存部署配置需要管理员密码', doSave); return }
      saveMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '已保存' : '保存失败') }
      saving.value = false
    }

    let pollTimer = null

    onUnmounted(() => {
      if (pollTimer) clearTimeout(pollTimer)
    })

    async function doDeploy() {
      if (!server.value.trim() || !appDir.value.trim()) { logLines.value = ['❌ 请先填写并保存部署配置']; return }
      if (pollTimer) clearTimeout(pollTimer)
      logLines.value = []; deployDone.value = false; deployMsg.value = null; deploying.value = true
      const res = await runDeploy({ server: server.value.trim(), appDir: appDir.value.trim(), accessPwd: accessPwd.value, adminPwd: adminPwd.value })
      if (res.code === 'ADMIN_REQUIRED') { deploying.value = false; window.showAdminDialog && window.showAdminDialog('部署需要管理员密码', doDeploy); return }
      if (!res.ok || !res.data?.taskId) { logLines.value = ['❌ 启动部署失败']; deploying.value = false; return }
      const taskId = res.data.taskId
      let delay = 700
      const poll = async () => {
        const pRes = await fetchDeployProgress(taskId)
        if (pRes.ok && pRes.data?.lines) {
          logLines.value = pRes.data.lines.filter(l => l)
          if (pRes.data.done) {
            deploying.value = false
            const success = pRes.data.success === true || pRes.data.lines.some(l => l.includes('✅') || l.includes('DONE'))
            if (success) {
              deployDone.value = true
              const confirm = await confirmDeployed()
              deployMsg.value = { type: confirm.ok ? 'ok' : 'err', text: confirm.ok ? '部署记录已更新' : (confirm.data?.message || '部署记录更新失败') }
              if (window.electronAPI && server.value) {
                const host = server.value.replace(/^root@/, '').replace(/:.*$/, '')
                window.electronAPI.setRemote(host)
                setTimeout(() => window.electronAPI.switchMode('remote'), 1000)
              }
            } else {
              deployDone.value = false
              deployMsg.value = { type: 'err', text: '部署失败，请查看日志' }
            }
            return
          }
        }
        delay = Math.min(delay + 300, 2500)
        pollTimer = setTimeout(poll, delay)
      }
      pollTimer = setTimeout(poll, delay)
    }

    function openRemote() {
      const host = server.value.replace(/^root@/, '').replace(/:.*$/, '')
      if (window.electronAPI) {
        window.electronAPI.setRemote(host)
        window.electronAPI.switchMode('remote')
      } else {
        window.open('http://' + host + ':5150/dashboard/', '_blank')
      }
    }

    async function connectRemote() {
      const host = server.value.replace(/^root@/, '').replace(/:.*$/, '')
      if (!host) { saveMsg.value = { type: 'err', text: '请先填写服务器地址' }; return }
      connecting.value = true
      saveMsg.value = null
      if (window.electronAPI) {
        window.electronAPI.setRemote(host)
        window.electronAPI.switchMode('remote')
      } else {
        window.open('http://' + host + ':5150/dashboard/', '_blank')
      }
      setTimeout(() => { connecting.value = false }, 3000)
    }

    async function doCheckUpdate() {
      if (!server.value.trim()) { updateStatus.value = { type: 'err', text: '请先填写服务器地址' }; return }
      checking.value = true; updateStatus.value = null
      const res = await checkDeployUpdate()
      if (res.ok && res.data) {
        const d = res.data
        updateAvailable.value = !d.upToDate
        updateStatus.value = {
          type: d.upToDate ? 'ok' : 'info',
          text: d.upToDate ? '本地指纹: ' + d.local + ' | 远端指纹: ' + d.deployed + ' — 已是最新版本' : '本地指纹: ' + d.local + ' | 远端指纹: ' + d.deployed + ' — 有可用更新',
        }
      } else {
        updateStatus.value = { type: 'err', text: '检查更新失败，请确认配置正确' }
      }
      checking.value = false
    }

    async function doUpdate() {
      if (!server.value.trim() || !appDir.value.trim()) { logLines.value = ['❌ 请先填写并保存部署配置']; return }
      if (pollTimer) clearTimeout(pollTimer)
      logLines.value = []; deployDone.value = false; deployMsg.value = null; updateStatus.value = null; updating.value = true
      const res = await runDeploy({ server: server.value.trim(), appDir: appDir.value.trim(), mode: 'update' })
      if (res.code === 'ADMIN_REQUIRED') { updating.value = false; window.showAdminDialog && window.showAdminDialog('更新部署需要管理员密码', doUpdate); return }
      if (!res.ok || !res.data?.taskId) { logLines.value = ['❌ 启动更新失败']; updating.value = false; return }
      const taskId = res.data.taskId
      let delay = 700
      const poll = async () => {
        const pRes = await fetchDeployProgress(taskId)
        if (pRes.ok && pRes.data?.lines) {
          logLines.value = pRes.data.lines.filter(l => l)
          if (pRes.data.done) {
            updating.value = false
            const success = pRes.data.success === true || pRes.data.lines.some(l => l.includes('✅') || l.includes('DONE'))
            if (success) {
              deployDone.value = true
              const confirm = await confirmDeployed()
              if (confirm.code === 'ADMIN_REQUIRED') { updating.value = false; window.showAdminDialog && window.showAdminDialog('更新部署需要管理员密码', doUpdate); return }
              if (confirm.ok) {
                updateStatus.value = { type: 'ok', text: '更新完成，Bot 已重启' }
                updateAvailable.value = false
              } else {
                updateStatus.value = { type: 'err', text: '更新完成，但版本记录更新失败，请确认管理员密码' }
                updateAvailable.value = true
              }
              if (window.electronAPI && server.value) {
                const host = server.value.replace(/^root@/, '').replace(/:.*$/, '')
                window.electronAPI.setRemote(host)
                setTimeout(() => window.electronAPI.switchMode('remote'), 1000)
              }
            } else {
              updateStatus.value = { type: 'err', text: '更新失败，请查看日志' }
            }
            return
          }
        }
        delay = Math.min(delay + 300, 2500)
        pollTimer = setTimeout(poll, delay)
      }
      pollTimer = setTimeout(poll, delay)
    }

    return {
      server, appDir, saving, saveMsg, deploying, logLines, deployDone, deployMsg,
      cookiesName, accessPwd, adminPwd, connecting,
      onCookiesFile, doSave, doDeploy, doCheckUpdate, doUpdate,
      openRemote, connectRemote,
      updateStatus, updateAvailable, checking, updating,
    }
  }
}
</script>
