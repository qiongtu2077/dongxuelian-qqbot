<template>
  <div class="card">
    <h2>部署配置</h2>
    <div style="display:grid;gap:12px">
      <div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:4px">服务器地址</div>
        <input v-model="server" placeholder="root@YOUR_SERVER_IP" style="width:100%" />
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
      <div>
        <button class="btn" @click="doSave" :disabled="saving">{{ saving ? '保存中...' : '保存配置' }}</button>
        <span v-if="saveMsg" style="margin-left:12px;font-size:13px" :style="{color: saveMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ saveMsg.text }}</span>
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
    <span v-if="deployMsg" style="margin-left:12px;font-size:13px" :style="{color: deployMsg.type === 'ok' ? '#39C5BB' : '#F472B6'}">{{ deployMsg.text }}</span>

    <div v-if="logLines.length" style="margin-top:12px;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;font-family:monospace;max-height:400px;overflow:auto;white-space:pre-wrap;line-height:1.5">
      <div v-for="(line, i) in logLines" :key="i" :style="{color: line.startsWith('❌') ? '#F472B6' : line.startsWith('$') ? 'var(--accent)' : line.includes('✅') ? '#39C5BB' : 'var(--text2)'}">{{ line }}</div>
    </div>

    <div v-if="deployDone" style="margin-top:12px;display:flex;gap:8px;align-items:center">
      <span style="color:#39C5BB;font-weight:700">✅ 部署完成</span>
      <button class="btn btn-sm" @click="openRemote" v-if="server">打开已部署面板</button>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import { fetchDeployConfig, saveDeployConfig, runDeploy, fetchDeployProgress, confirmDeployed, getAdminToken } from '../api'

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
    const cookiesName = ref('')
    const accessPwd = ref('')
    const adminPwd = ref('')

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
      window.open('http://' + host + ':5150/dashboard/', '_blank')
    }

    return { server, appDir, saving, saveMsg, deploying, logLines, deployDone, deployMsg, cookiesName, accessPwd, adminPwd, onCookiesFile, doSave, doDeploy, openRemote }
  }
}
</script>
