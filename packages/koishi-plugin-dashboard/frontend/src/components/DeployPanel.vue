<template>
  <div class="card">
    <details style="font-size:13px;color:var(--text2);margin-bottom:12px">
      <summary style="cursor:pointer;font-weight:700;color:var(--accent)">📖 使用说明（点击展开）</summary>
      <div style="margin-top:8px;line-height:1.7;background:var(--input);border-radius:8px;padding:14px 16px;font-size:12px;color:var(--text2)">
        <p><b>什么是部署面板？</b>在浏览器里配置远程服务器信息，一键将本地所有插件、前端、配置文件推送到远程服务器并重启 Bot。适合初次部署或日常更新。</p>
        <p><b>前置条件</b>：本机已配置 SSH 密钥认证（<code>~/.ssh/id_rsa</code>），能免密码 <code>ssh root@服务器IP</code>。</p>
        <p><b>使用步骤：</b></p>
        <ol style="margin-left:16px">
          <li>填写服务器地址（如 <code>root@120.55.246.12</code>）和应用目录 → 保存配置</li>
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
        <input v-model="server" placeholder="root@120.55.246.12" style="width:100%" />
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
import { ref, onMounted } from 'vue'
import { fetchDeployConfig, saveDeployConfig, runDeploy, fetchDeployProgress, confirmDeployed } from '../api'

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
          headers: { 'Content-Type': 'application/json' },
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

    async function doDeploy() {
      if (!server.value.trim() || !appDir.value.trim()) { logLines.value = ['❌ 请先填写并保存部署配置']; return }
      logLines.value = []; deployDone.value = false; deploying.value = true
      const res = await runDeploy({ server: server.value.trim(), appDir: appDir.value.trim(), accessPwd: accessPwd.value, adminPwd: adminPwd.value })
      if (res.code === 'ADMIN_REQUIRED') { deploying.value = false; window.showAdminDialog && window.showAdminDialog('部署需要管理员密码', doDeploy); return }
      if (!res.ok || !res.data?.taskId) { logLines.value = ['❌ 启动部署失败']; deploying.value = false; return }
      const taskId = res.data.taskId
      pollTimer = setInterval(async () => {
        const pRes = await fetchDeployProgress(taskId)
        if (pRes.ok && pRes.data?.lines) {
          logLines.value = pRes.data.lines.filter(l => l)
            if (pRes.data.done) {
              clearInterval(pollTimer); deploying.value = false
              const success = pRes.data.lines.some(l => l.includes('✅') || l.includes('DONE'))
              if (success) {
                deployDone.value = true
                await confirmDeployed()
                location.reload()
              } else {
                deployDone.value = false
              }
            }
        }
      }, 500)
    }

    function openRemote() {
      const host = server.value.replace(/^root@/, '').replace(/:.*$/, '')
      window.open('http://' + host + ':5150/dashboard/', '_blank')
    }

    return { server, appDir, saving, saveMsg, deploying, logLines, deployDone, cookiesName, accessPwd, adminPwd, onCookiesFile, doSave, doDeploy, openRemote }
  }
}
</script>
