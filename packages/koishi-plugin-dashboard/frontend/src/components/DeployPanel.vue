<template>
  <div>
    <div v-if="locked" class="card deploy-hero">
      <div>
        <div class="gate-kicker">Setup</div>
        <h2>先完成部署，再进入控制台</h2>
        <p>新用户可以在这里完成 Windows 本地部署，或把当前项目部署到 Linux 服务器。已经部署过的用户可以直接解锁进入完整控制台。</p>
      </div>
      <button class="btn" type="button" @click="$emit('unlocked')">我已部署，解锁</button>
    </div>

    <div class="card">
      <h2>部署方式</h2>
      <div class="segmented">
        <button type="button" :class="{ active: mode === 'local' }" @click="mode = 'local'">Windows 本地部署</button>
        <button type="button" :class="{ active: mode === 'remote' }" @click="mode = 'remote'">远程 Linux 部署</button>
      </div>
    </div>

    <div v-if="mode === 'local'" class="card">
      <h2>Windows 本地部署</h2>
      <div class="grp-desc" style="margin-bottom:14px">所有运行时文件都会放在当前项目目录的 runtime/ 下，不写入 C 盘系统目录。NapCat 扫码登录后，Koishi 使用 127.0.0.1:8080 连接。</div>

      <div class="row"><label>机器人 QQ</label><input v-model="local.qq" placeholder="机器人 QQ 号" /></div>
      <div class="row"><label>供应商</label><input v-model="local.provider" placeholder="opencode / deepseek / dashscope" /></div>
      <div class="row"><label>模型</label><input v-model="local.model" placeholder="deepseek-v4-flash" /></div>
      <div class="row"><label>API 地址</label><input v-model="local.baseUrl" placeholder="留空使用项目默认" /></div>
      <div class="row"><label>API Key</label><input v-model="local.apiKey" placeholder="可先留空，之后在 API Keys 页填写" /></div>
      <div class="row"><label>NapCat URL</label><input v-model="napcatUrl" placeholder="可选：填写直链后下载到 runtime/downloads" /></div>

      <div class="deploy-actions">
        <button class="btn btn-sm" type="button" @click="checkEnv" :disabled="checking">{{ checking ? '检测中...' : '检测环境' }}</button>
        <button class="btn btn-sm" type="button" @click="doDownloadNapcat" :disabled="downloading">{{ downloading ? '下载中...' : '下载 NapCat 包' }}</button>
        <a class="btn btn-sm btn-ghost" href="https://github.com/NapNeko/NapCatQQ/releases/latest" target="_blank">打开官方下载页</a>
        <button class="btn btn-sm" type="button" @click="writeLocalConfig" :disabled="localDeploying">{{ localDeploying ? '写入中...' : '生成本地配置' }}</button>
      </div>

      <div v-if="env" class="deploy-status">
        <div class="status-item"><span>项目目录</span><code>{{ env.projectDir }}</code></div>
        <div class="status-item"><span>runtime</span><code>{{ env.runtimeDir }}</code></div>
        <div class="status-item"><span>Node.js</span><b :class="env.node?.found ? 'ok-text' : 'err-text'">{{ env.node?.found ? env.node.version : '未检测到' }}</b></div>
        <div class="status-item"><span>npm</span><b :class="env.npm?.found ? 'ok-text' : 'err-text'">{{ env.npm?.found ? env.npm.version : '未检测到' }}</b></div>
        <div class="status-item"><span>中文路径读写</span><b :class="env.pathEncoding?.ok ? 'ok-text' : 'err-text'">{{ env.pathEncoding?.ok ? '通过' : '失败' }}</b></div>
        <div class="status-item"><span>端口</span><code>{{ portSummary }}</code></div>
        <div class="status-item"><span>NapCat</span><b :class="env.napcat?.found ? 'ok-text' : 'warn-text'">{{ env.napcat?.found ? '已发现' : '未放入 runtime/napcat' }}</b></div>
      </div>

      <div v-if="localMsg" class="msg" :class="localMsg.type">{{ localMsg.text }}</div>
    </div>

    <div v-else class="card">
      <h2>远程 Linux 部署</h2>
      <div class="grp-desc" style="margin-bottom:14px">需要本机可以直接 SSH 到服务器。部署会推送插件代码、Dashboard 前端和必要脚本到远程目录。</div>
      <div class="row"><label>服务器</label><input v-model="remote.server" placeholder="root@服务器IP" /></div>
      <div class="row"><label>应用目录</label><input v-model="remote.appDir" placeholder="/root/koishi-app" /></div>
      <div class="row"><label>模式</label><select v-model="remote.mode"><option value="install">首次安装</option><option value="update">更新代码</option></select></div>

      <div class="deploy-actions">
        <button class="btn btn-sm" type="button" @click="loadRemoteConfig">读取配置</button>
        <button class="btn btn-sm" type="button" @click="saveRemoteConfig" :disabled="savingRemote">{{ savingRemote ? '保存中...' : '保存配置' }}</button>
        <button class="btn btn-sm" type="button" @click="checkRemoteUpdate">检查更新</button>
        <button class="btn btn-sm" type="button" @click="startRemoteDeploy" :disabled="deploying">{{ deploying ? '部署中...' : '开始部署' }}</button>
      </div>

      <div style="margin-top:12px">
        <input ref="cookieInput" type="file" accept=".txt" style="display:none" @change="uploadCookie" />
        <button class="btn btn-sm btn-ghost" type="button" @click="$refs.cookieInput.click()">上传 B 站 cookies.txt</button>
      </div>

      <div v-if="remoteMsg" class="msg" :class="remoteMsg.type">{{ remoteMsg.text }}</div>
      <pre v-if="logs.length" class="deploy-log">{{ logs.join('\n') }}</pre>
    </div>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { checkDeployUpdate, checkLocalEnv, confirmDeploy, deployLocal, downloadNapcat, fetchDeployConfig, getDeployProgress, runDeploy, updateDeployConfig, uploadDeploy } from '../api'

export default {
  name: 'DeployPanel',
  props: { locked: { type: Boolean, default: false } },
  emits: ['unlocked'],
  setup() {
    const mode = ref('local')
    const local = reactive({ qq: '', provider: 'opencode', model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '' })
    const remote = reactive({ server: '', appDir: '/root/koishi-app', mode: 'update' })
    const env = ref(null)
    const localMsg = ref(null)
    const remoteMsg = ref(null)
    const logs = ref([])
    const napcatUrl = ref('')
    const checking = ref(false)
    const downloading = ref(false)
    const localDeploying = ref(false)
    const savingRemote = ref(false)
    const deploying = ref(false)
    let progressTimer = null

    const portSummary = computed(() => {
      const ports = env.value?.ports || {}
      return Object.keys(ports).map(port => `${port}:${ports[port].available ? '空闲' : '占用'}`).join('  ')
    })

    function withAdminRetry(res, message, retry) {
      if (res?.code === 'ADMIN_REQUIRED') {
        window.showAdminDialog && window.showAdminDialog(message, retry)
        return true
      }
      return false
    }

    async function checkEnv() {
      checking.value = true
      localMsg.value = null
      const res = await checkLocalEnv()
      if (res.ok) {
        env.value = res.data
        localMsg.value = { type: 'ok', text: '环境检测完成' }
      } else {
        localMsg.value = { type: 'err', text: res.data?.message || '环境检测失败' }
      }
      checking.value = false
    }

    async function doDownloadNapcat() {
      if (!napcatUrl.value.trim()) {
        localMsg.value = { type: 'err', text: '请粘贴 NapCat 包直链，或点击官方下载页手动下载后放入 runtime/napcat' }
        return
      }
      downloading.value = true
      localMsg.value = null
      const res = await downloadNapcat(napcatUrl.value.trim())
      if (withAdminRetry(res, '下载 NapCat 需要服务器密码', doDownloadNapcat)) { downloading.value = false; return }
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? 'NapCat 已下载到 runtime/downloads' : '下载失败') }
      downloading.value = false
      if (res.ok) await checkEnv()
    }

    async function writeLocalConfig() {
      if (!/^\d+$/.test(local.qq.trim())) {
        localMsg.value = { type: 'err', text: '请先填写机器人 QQ 号' }
        return
      }
      localDeploying.value = true
      localMsg.value = null
      const res = await deployLocal({ ...local, qq: local.qq.trim() })
      if (withAdminRetry(res, '生成本地部署配置需要服务器密码', writeLocalConfig)) { localDeploying.value = false; return }
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '本地配置已生成' : '生成失败') }
      localDeploying.value = false
      if (res.ok) await checkEnv()
    }

    async function loadRemoteConfig() {
      const res = await fetchDeployConfig()
      if (res.ok) {
        remote.server = res.data.server || remote.server
        remote.appDir = res.data.appDir || remote.appDir
        remoteMsg.value = { type: 'ok', text: '已读取部署配置' }
      } else {
        remoteMsg.value = { type: 'err', text: '读取配置失败' }
      }
    }

    async function saveRemoteConfig() {
      savingRemote.value = true
      const res = await updateDeployConfig(remote)
      if (withAdminRetry(res, '保存部署配置需要服务器密码', saveRemoteConfig)) { savingRemote.value = false; return }
      remoteMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '配置已保存' : '保存失败') }
      savingRemote.value = false
    }

    async function checkRemoteUpdate() {
      const res = await checkDeployUpdate()
      if (res.ok) remoteMsg.value = { type: 'ok', text: res.data.upToDate ? '远程记录已是最新版本' : `本地 ${res.data.local}，远程 ${res.data.deployed || '未记录'}` }
      else remoteMsg.value = { type: 'err', text: '检查更新失败' }
    }

    async function startRemoteDeploy() {
      deploying.value = true
      logs.value = []
      const res = await runDeploy(remote)
      if (withAdminRetry(res, '执行远程部署需要服务器密码', startRemoteDeploy)) { deploying.value = false; return }
      if (!res.ok || !res.data?.taskId) {
        remoteMsg.value = { type: 'err', text: res.data?.message || '启动部署失败' }
        deploying.value = false
        return
      }
      pollProgress(res.data.taskId)
    }

    function pollProgress(taskId) {
      if (progressTimer) clearInterval(progressTimer)
      progressTimer = setInterval(async () => {
        const res = await getDeployProgress(taskId)
        if (!res.ok) return
        logs.value = res.data.lines || []
        if (res.data.done) {
          clearInterval(progressTimer)
          progressTimer = null
          deploying.value = false
          remoteMsg.value = { type: res.data.success ? 'ok' : 'err', text: res.data.success ? '部署完成' : '部署失败，请查看日志' }
          if (res.data.success) await confirmDeploy()
        }
      }, 1500)
    }

    function uploadCookie(event) {
      const file = event.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = String(reader.result || '').split(',')[1]
        const res = await uploadDeploy('bilibili-cookies.txt', base64)
        if (withAdminRetry(res, '上传 cookies 需要服务器密码', () => uploadCookie(event))) return
        remoteMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? 'cookies 已上传' : '上传失败') }
      }
      reader.readAsDataURL(file)
    }

    onMounted(() => {
      checkEnv()
      loadRemoteConfig()
    })

    onUnmounted(() => {
      if (progressTimer) clearInterval(progressTimer)
    })

    return { mode, local, remote, env, localMsg, remoteMsg, logs, napcatUrl, checking, downloading, localDeploying, savingRemote, deploying, portSummary, checkEnv, doDownloadNapcat, writeLocalConfig, loadRemoteConfig, saveRemoteConfig, checkRemoteUpdate, startRemoteDeploy, uploadCookie }
  },
}
</script>
