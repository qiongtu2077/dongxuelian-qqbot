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
      <div class="row"><label>NapCat 目录</label><div class="path-control"><input v-model="napcatInstallDir" placeholder="默认 runtime/napcat" /><button v-if="canChooseDirectory" class="btn btn-sm btn-ghost" type="button" @click="chooseNapcatDir">选择目录</button></div></div>
      <div class="row"><label>NapCat URL</label><input v-model="napcatUrl" placeholder="可选：手动下载包直链，仅保存到 runtime/downloads" /></div>

      <div class="deploy-actions">
        <button class="btn btn-sm" type="button" @click="checkEnv" :disabled="checking">{{ checking ? '检测中...' : '检测环境' }}</button>
        <button v-if="isWindows && !env?.napcat?.found" class="btn btn-sm" type="button" @click="doDownloadWindowsNapcat" :disabled="installingNapcat">{{ installingNapcat ? '安装中...' : '下载 NapCat（Windows）' }}</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="doDownloadNapcat" :disabled="downloading">{{ downloading ? '下载中...' : '下载直链包' }}</button>
        <a class="btn btn-sm btn-ghost" href="https://github.com/NapNeko/NapCatQQ/releases/latest" target="_blank">打开 NapCat 发布页</a>
        <button class="btn btn-sm" type="button" @click="writeLocalConfig" :disabled="localDeploying">{{ localDeploying ? '写入中...' : '生成 Koishi 本地配置' }}</button>
        <button class="btn btn-sm btn-ghost btn-danger" type="button" @click="previewDeleteConfig" :disabled="previewingDelete || deletingConfig">{{ previewingDelete ? '读取中...' : '删除 Koishi 配置' }}</button>
      </div>

      <div v-if="env" class="deploy-status">
        <div class="status-item"><span>项目目录</span><code>{{ env.projectDir }}</code></div>
        <div class="status-item"><span>runtime</span><code>{{ env.runtimeDir }}</code></div>
        <div class="status-item"><span>Node.js</span><b :class="env.node?.ok ? 'ok-text' : 'err-text'">{{ env.node?.version || '未检测到' }}</b><small>{{ env.node?.reason }}</small></div>
        <div class="status-item"><span>npm</span><b :class="env.npm?.found ? 'ok-text' : 'err-text'">{{ env.npm?.version || '未检测到' }}</b><small>{{ env.npm?.reason }}</small></div>
        <div class="status-item"><span>项目依赖</span><b :class="env.dependencies?.ready ? 'ok-text' : 'warn-text'">{{ env.dependencies?.ready ? '已安装' : '未完整安装' }}</b><small>{{ env.dependencies?.reason }}</small></div>
        <div class="status-item"><span>Koishi 配置</span><b :class="localConfigReady ? 'ok-text' : 'warn-text'">{{ localConfigReady ? '已生成' : '未生成' }}</b><small>{{ localConfigSummary }}</small></div>
        <div class="status-item"><span>中文路径读写</span><b :class="env.pathEncoding?.ok ? 'ok-text' : 'warn-text'">{{ env.pathEncoding?.ok ? '通过' : (env.pathEncoding?.skipped ? '未检测' : '失败') }}</b><small>{{ env.pathEncoding?.message }}</small></div>
        <div class="status-item"><span>端口</span><code>{{ portSummary }}</code></div>
        <div class="status-item"><span>NapCat</span><b :class="napcatStatusClass">{{ napcatStatusText }}</b><small>{{ env.napcat?.reason }}</small><code v-if="env.napcat?.entry || env.napcat?.path">{{ env.napcat?.entry || env.napcat?.path }}</code></div>
      </div>

      <div v-if="deletePreview" class="delete-preview">
        <div class="preview-head">
          <div>
            <strong>删除预览</strong>
            <span>{{ deleteCandidates.length }} 个文件将删除，{{ keptCandidates.length }} 个项目会保留</span>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="deletePreview = null">×</button>
        </div>
        <div class="preview-list themed-scrollbar">
          <div v-for="item in previewRows" :key="item.path" :class="['preview-row', 'preview-' + item.action]">
            <span>{{ formatPreviewAction(item.action) }}</span>
            <code>{{ item.path }}</code>
            <small>{{ item.reason }}<template v-if="item.size"> · {{ formatSize(item.size) }}</template></small>
          </div>
        </div>
        <div class="deploy-actions">
          <button class="btn btn-sm btn-danger-solid" type="button" @click="confirmDeleteConfig" :disabled="deletingConfig || !deleteCandidates.length">{{ deletingConfig ? '删除中...' : '确认删除预览中的配置' }}</button>
          <button class="btn btn-sm btn-ghost" type="button" @click="deletePreview = null" :disabled="deletingConfig">取消</button>
        </div>
      </div>

      <div class="danger-zone">
        <div>
          <strong>危险区</strong>
          <span>部署失败或想重新来过时，可清理本项目安装/生成的本地环境。系统全局 Node.js/npm 只报告，不自动删除。</span>
        </div>
        <button class="btn btn-sm btn-danger-solid" type="button" @click="previewLocalUninstallFlow" :disabled="previewingUninstall || uninstalling">{{ previewingUninstall ? '读取中...' : '一键卸载本地部署环境' }}</button>
      </div>

      <div v-if="localMsg" class="msg" :class="localMsg.type">{{ localMsg.text }}</div>
    </div>

    <div v-if="uninstallPreview" class="modal-backdrop uninstall-backdrop">
      <div class="uninstall-modal themed-scrollbar">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">一键卸载确认</h2>
            <p>环境文件默认删除；用户数据默认保留。取消保留后，确认卸载时会一并删除。</p>
          </div>
          <button class="icon-btn" type="button" title="关闭" @click="closeUninstallPreview" :disabled="uninstalling">×</button>
        </div>

        <div class="uninstall-summary">
          <div><span>环境文件</span><b>{{ uninstallDeleteItems.length }}</b><small>{{ formatSize(uninstallBaseDeleteSize) }}</small></div>
          <div><span>用户数据</span><b>{{ uninstallUserDataItems.length }}</b><small>{{ formatSize(uninstallUserDataSize) }}</small></div>
          <div><span>本次将删</span><b>{{ formatSize(uninstallSelectedDeleteSize) }}</b><small>{{ uninstallSelectedDeleteCount }} 项</small></div>
        </div>

        <div v-if="uninstallWarnings.length" class="uninstall-warning-list">
          <div v-for="item in uninstallWarnings" :key="item.key || item.path || item.message">{{ item.message || item.reason }}<code v-if="item.path">{{ item.path }}</code></div>
        </div>

        <section class="uninstall-section">
          <div class="section-head"><strong>环境文件</strong><span>这些是本项目安装或生成的可重建文件</span></div>
          <div class="uninstall-list themed-scrollbar">
            <div v-for="item in uninstallDeleteItems" :key="item.key" class="uninstall-row delete">
              <div><strong>{{ item.label }}</strong><small>{{ item.reason }}</small></div>
              <code>{{ formatUninstallPaths(item) }}</code>
              <b>{{ formatSize(item.size) }}</b>
            </div>
          </div>
        </section>

        <section class="uninstall-section">
          <div class="section-head">
            <div><strong>用户数据</strong><span>默认保留；关闭开关后会删除对应数据</span></div>
            <div class="mini-actions">
              <button class="btn btn-sm btn-ghost" type="button" @click="setAllUserDataKeep(true)" :disabled="uninstalling">全部保留</button>
              <button class="btn btn-sm btn-ghost btn-danger" type="button" @click="setAllUserDataKeep(false)" :disabled="uninstalling">全部删除</button>
            </div>
          </div>
          <div class="uninstall-list themed-scrollbar">
            <label v-for="item in uninstallUserDataItems" :key="item.key" :class="['uninstall-row', shouldKeepUserData(item) ? 'keep' : 'delete']">
              <input type="checkbox" :checked="shouldKeepUserData(item)" @change="setUserDataKeep(item, $event.target.checked)" :disabled="uninstalling" />
              <div><strong>{{ item.label }}</strong><small>{{ item.reason }}</small></div>
              <code>{{ formatUninstallPaths(item) }}</code>
              <b>{{ shouldKeepUserData(item) ? '保留' : formatSize(item.size) }}</b>
            </label>
          </div>
        </section>

        <section v-if="uninstallKeepItems.length" class="uninstall-section">
          <div class="section-head"><strong>不会自动删除</strong><span>系统级工具或无法证明归属的路径</span></div>
          <div class="uninstall-list compact themed-scrollbar">
            <div v-for="item in uninstallKeepItems" :key="item.label + item.path" class="uninstall-row keep">
              <div><strong>{{ item.label }}</strong><small>{{ item.reason }}</small></div>
              <code>{{ item.path }}</code>
              <b>{{ item.version || '保留' }}</b>
            </div>
          </div>
        </section>

        <label class="confirm-check">
          <input type="checkbox" v-model="uninstallConfirmed" :disabled="uninstalling" />
          <span>我确认卸载本地部署环境，并理解未保留的用户数据会被删除。</span>
        </label>

        <div class="deploy-actions uninstall-actions">
          <button class="btn btn-sm btn-danger-solid" type="button" @click="confirmLocalUninstallFlow" :disabled="uninstalling || !uninstallConfirmed">{{ uninstalling ? '卸载中...' : '确认一键卸载' }}</button>
          <button class="btn btn-sm btn-ghost" type="button" @click="closeUninstallPreview" :disabled="uninstalling">取消</button>
        </div>
      </div>
    </div>

    <div v-if="mode === 'remote'" class="card">
      <h2>远程 Linux 部署</h2>
      <div class="grp-desc" style="margin-bottom:14px">需要本机可以直接 SSH 到服务器。部署会推送插件代码、Dashboard 前端和必要脚本到远程目录。</div>
      <div class="row"><label>服务器</label><input v-model="remote.server" placeholder="root@服务器IP" /></div>
      <div class="row"><label>应用目录</label><input v-model="remote.appDir" placeholder="/root/koishi-app" /></div>
      <div class="row"><label>模式</label><select v-model="remote.mode" class="themed-select"><option value="install">实验性首次安装</option><option value="update">更新已有部署</option></select></div>

      <div class="deploy-actions">
        <button class="btn btn-sm" type="button" @click="loadRemoteConfig">自动填入服务器地址</button>
        <button class="btn btn-sm" type="button" @click="saveRemoteConfig" :disabled="savingRemote">{{ savingRemote ? '保存中...' : '保存服务器地址' }}</button>
        <button class="btn btn-sm" type="button" @click="checkRemoteUpdate">检查更新</button>
        <button class="btn btn-sm" type="button" @click="startRemoteDeploy" :disabled="deploying">{{ deploying ? '部署中...' : '开始远程操作' }}</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="doRebuildFrontend" :disabled="rebuilding">{{ rebuilding ? '构建中...' : '重建前端' }}</button>
      </div>

      <div style="margin-top:12px">
        <input ref="cookieInput" type="file" accept=".txt" style="display:none" @change="uploadCookie" />
        <button class="btn btn-sm btn-ghost" type="button" @click="$refs.cookieInput.click()">上传 B 站 cookies.txt</button>
      </div>

      <div v-if="remoteMsg" class="msg" :class="remoteMsg.type">{{ remoteMsg.text }}</div>
      <pre v-if="logs.length" ref="deployLogRef" class="deploy-log themed-scrollbar">{{ logs.join('\n') }}</pre>
    </div>
  </div>
</template>

<script>
import { computed, inject, nextTick, onActivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { checkDeployUpdate, checkLocalEnv, confirmDeploy, confirmLocalUninstall, deleteLocalConfig, deployLocal, downloadNapcat, downloadNapcatWindows, fetchDeployConfig, getDeployProgress, previewLocalConfigDelete, previewLocalUninstall, rebuildFrontend, rebuildFrontendStatus, runDeploy, updateDeployConfig, uploadDeploy } from '../api'

export default {
  name: 'DeployPanel',
  props: { locked: { type: Boolean, default: false } },
  emits: ['unlocked'],
  setup() {
    const showAdminDialog = inject('showAdminDialog')
    const mode = ref('local')
    const local = reactive({ qq: '', provider: 'opencode', model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '' })
    const remote = reactive({ server: '', appDir: '/root/koishi-app', mode: 'update' })
    const env = ref(null)
    const localMsg = ref(null)
    const remoteMsg = ref(null)
    const logs = ref([])
    const napcatUrl = ref('')
    const napcatInstallDir = ref('')
    const deletePreview = ref(null)
    const uninstallPreview = ref(null)
    const deleteUserDataKeys = ref([])
    const uninstallConfirmed = ref(false)
    const deployLogRef = ref(null)
    const checking = ref(false)
    const downloading = ref(false)
    const installingNapcat = ref(false)
    const localDeploying = ref(false)
    const previewingDelete = ref(false)
    const deletingConfig = ref(false)
    const previewingUninstall = ref(false)
    const uninstalling = ref(false)
    const savingRemote = ref(false)
    const deploying = ref(false)
    const rebuilding = ref(false)
    let progressTimer = null

    const deployerBridge = computed(() => (typeof window !== 'undefined' ? window.dongxuelianDeployer : null))
    const isWindows = computed(() => (env.value?.platform || deployerBridge.value?.platform) === 'win32')
    const canChooseDirectory = computed(() => typeof deployerBridge.value?.selectDirectory === 'function')
    const deleteCandidates = computed(() => (deletePreview.value?.files || []).filter(item => item.action === 'delete'))
    const keptCandidates = computed(() => (deletePreview.value?.files || []).filter(item => item.action !== 'delete').concat(deletePreview.value?.protected || []))
    const previewRows = computed(() => (deletePreview.value ? [...(deletePreview.value.files || []), ...(deletePreview.value.protected || [])] : []))
    const localConfigReady = computed(() => (env.value?.localConfig?.files || []).some(item => item.action === 'delete' && ['koishi.yml', 'start-local.bat'].includes(item.path)))
    const localConfigSummary = computed(() => {
      const files = env.value?.localConfig?.files || []
      const deletable = files.filter(item => item.action === 'delete').map(item => item.path)
      return deletable.length ? deletable.join('、') : '未检测到本工具生成的 koishi.yml/start-local.bat'
    })
    const napcatStatusText = computed(() => {
      const status = env.value?.napcat?.status
      if (env.value?.napcat?.found) return '已安装'
      if (status === 'partial') return '安装不完整'
      if (status === 'unknown') return '状态未知'
      return '未安装'
    })
    const napcatStatusClass = computed(() => env.value?.napcat?.found ? 'ok-text' : (env.value?.napcat?.status === 'missing' ? 'warn-text' : 'err-text'))
    const portSummary = computed(() => {
      const ports = env.value?.ports || {}
      const labels = { free: '空闲', occupied: '占用', denied: '无权限', unknown: '未知', invalid: '无效' }
      return Object.keys(ports).map(port => `${port}:${labels[ports[port].status] || (ports[port].available ? '空闲' : '占用')}`).join('  ')
    })
    const uninstallDeleteItems = computed(() => uninstallPreview.value?.deleteItems || [])
    const uninstallUserDataItems = computed(() => uninstallPreview.value?.userDataItems || [])
    const uninstallKeepItems = computed(() => uninstallPreview.value?.keepItems || [])
    const uninstallWarnings = computed(() => uninstallPreview.value?.warnings || [])
    const uninstallBaseDeleteSize = computed(() => uninstallDeleteItems.value.reduce((sum, item) => sum + (item.size || 0), 0))
    const uninstallUserDataSize = computed(() => uninstallUserDataItems.value.reduce((sum, item) => sum + (item.size || 0), 0))
    const uninstallSelectedUserDataItems = computed(() => uninstallUserDataItems.value.filter(item => deleteUserDataKeys.value.includes(item.key)))
    const uninstallSelectedDeleteSize = computed(() => uninstallBaseDeleteSize.value + uninstallSelectedUserDataItems.value.reduce((sum, item) => sum + (item.size || 0), 0))
    const uninstallSelectedDeleteCount = computed(() => uninstallDeleteItems.value.length + uninstallSelectedUserDataItems.value.length)

    function withAdminRetry(res, message, retry) {
      if (res?.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog(message, retry)
        return true
      }
      return false
    }

    function syncNapcatInstallDir(data) {
      if (!napcatInstallDir.value) napcatInstallDir.value = data?.napcat?.expectedPath || (data?.runtimeDir ? `${data.runtimeDir}\\napcat` : '')
    }

    function scrollDeployLogToBottom() {
      nextTick(() => {
        const el = deployLogRef.value
        if (el) el.scrollTop = el.scrollHeight
      })
    }

    async function checkEnv() {
      checking.value = true
      localMsg.value = null
      const res = await checkLocalEnv()
      if (res.ok) {
        env.value = res.data
        syncNapcatInstallDir(res.data)
        localMsg.value = { type: 'ok', text: '环境检测完成' }
      } else {
        localMsg.value = { type: 'err', text: res.data?.message || '环境检测失败' }
      }
      checking.value = false
    }

    async function chooseNapcatDir() {
      const picker = deployerBridge.value?.selectDirectory
      if (!picker) return
      const selected = await picker(napcatInstallDir.value)
      if (selected) napcatInstallDir.value = selected
    }

    async function doDownloadWindowsNapcat() {
      installingNapcat.value = true
      localMsg.value = { type: 'ok', text: '正在下载并解压 NapCat（Windows），请稍等...' }
      const res = await downloadNapcatWindows(napcatInstallDir.value)
      if (withAdminRetry(res, '下载并安装 NapCat 需要管理员密码', doDownloadWindowsNapcat)) { installingNapcat.value = false; return }
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? 'NapCat 已安装' : '安装失败') }
      installingNapcat.value = false
      if (res.ok) await checkEnv()
    }

    async function doDownloadNapcat() {
      if (!napcatUrl.value.trim()) {
        localMsg.value = { type: 'err', text: '请粘贴 NapCat 包直链，或点击 NapCat 发布页手动下载' }
        return
      }
      downloading.value = true
      localMsg.value = null
      const res = await downloadNapcat(napcatUrl.value.trim())
      if (withAdminRetry(res, '下载 NapCat 需要管理员密码', doDownloadNapcat)) { downloading.value = false; return }
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? 'NapCat 包已下载到 runtime/downloads' : '下载失败') }
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
      if (withAdminRetry(res, '生成 Koishi 本地配置需要管理员密码', writeLocalConfig)) { localDeploying.value = false; return }
      const files = res.data?.files || []
      const changed = files.filter(item => item.action !== 'unchanged').length
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? `Koishi 本地配置已生成，写入 ${changed} 个文件` : '生成失败') }
      deletePreview.value = null
      localDeploying.value = false
      if (res.ok) await checkEnv()
    }

    async function previewDeleteConfig() {
      previewingDelete.value = true
      localMsg.value = null
      const res = await previewLocalConfigDelete()
      if (withAdminRetry(res, '删除 Koishi 配置前需要管理员密码', previewDeleteConfig)) { previewingDelete.value = false; return }
      if (res.ok) deletePreview.value = res.data
      else localMsg.value = { type: 'err', text: res.data?.message || '读取删除预览失败' }
      previewingDelete.value = false
    }

    async function confirmDeleteConfig() {
      if (!deleteCandidates.value.length) return
      deletingConfig.value = true
      localMsg.value = null
      const res = await deleteLocalConfig()
      if (withAdminRetry(res, '删除 Koishi 配置需要管理员密码', confirmDeleteConfig)) { deletingConfig.value = false; return }
      const deleted = res.data?.deleted?.length || 0
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? `已删除 ${deleted} 个配置文件` : '删除失败') }
      deletingConfig.value = false
      deletePreview.value = null
      await checkEnv()
    }

    async function previewLocalUninstallFlow() {
      previewingUninstall.value = true
      localMsg.value = null
      const res = await previewLocalUninstall()
      if (withAdminRetry(res, '一键卸载需要管理员密码', previewLocalUninstallFlow)) { previewingUninstall.value = false; return }
      if (res.ok) {
        uninstallPreview.value = res.data
        deleteUserDataKeys.value = []
        uninstallConfirmed.value = false
      } else {
        localMsg.value = { type: 'err', text: res.data?.message || '读取卸载预览失败' }
      }
      previewingUninstall.value = false
    }

    function closeUninstallPreview() {
      if (uninstalling.value) return
      uninstallPreview.value = null
      deleteUserDataKeys.value = []
      uninstallConfirmed.value = false
    }

    function shouldKeepUserData(item) {
      return !deleteUserDataKeys.value.includes(item.key)
    }

    function setUserDataKeep(item, keep) {
      const keys = new Set(deleteUserDataKeys.value)
      if (keep) keys.delete(item.key)
      else keys.add(item.key)
      deleteUserDataKeys.value = [...keys]
    }

    function setAllUserDataKeep(keep) {
      deleteUserDataKeys.value = keep ? [] : uninstallUserDataItems.value.map(item => item.key)
    }

    function formatUninstallPaths(item) {
      const paths = item.paths || []
      if (!paths.length) return ''
      if (paths.length === 1) return paths[0].path
      return `${paths[0].path} 等 ${paths.length} 项`
    }

    async function confirmLocalUninstallFlow() {
      if (!uninstallConfirmed.value) return
      uninstalling.value = true
      localMsg.value = null
      const res = await confirmLocalUninstall({ deleteUserDataKeys: deleteUserDataKeys.value })
      if (withAdminRetry(res, '一键卸载需要管理员密码', confirmLocalUninstallFlow)) { uninstalling.value = false; return }
      const deleted = res.data?.deleted?.length || 0
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? `一键卸载完成，删除 ${deleted} 项` : '一键卸载失败') }
      uninstalling.value = false
      uninstallPreview.value = null
      deleteUserDataKeys.value = []
      uninstallConfirmed.value = false
      await checkEnv()
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
      if (withAdminRetry(res, '保存部署配置需要管理员密码', saveRemoteConfig)) { savingRemote.value = false; return }
      remoteMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? '配置已保存' : '保存失败') }
      savingRemote.value = false
    }

    async function checkRemoteUpdate() {
      const res = await checkDeployUpdate()
      if (res.ok) remoteMsg.value = { type: 'ok', text: res.data.upToDate ? '远程记录已是最新版本' : `本地 ${res.data.local}，远程 ${res.data.deployed || '未记录'}` }
      else remoteMsg.value = { type: 'err', text: '检查更新失败' }
    }

    async function doRebuildFrontend() {
      rebuilding.value = true; remoteMsg.value = null
      const res = await rebuildFrontend()
      if (withAdminRetry(res, '重建前端需要管理员密码', doRebuildFrontend)) { rebuilding.value = false; return }
      if (!res.ok) { remoteMsg.value = { type: 'err', text: res.data?.message || '启动失败' }; rebuilding.value = false; return }
      remoteMsg.value = { type: 'ok', text: '前端构建中...' }
      const timer = setInterval(async () => {
        const sr = await rebuildFrontendStatus()
        if (sr.ok) {
          if (sr.data.state === 'success') {
            clearInterval(timer); rebuilding.value = false
            remoteMsg.value = { type: 'ok', text: '前端构建成功，请刷新页面' }
          } else if (sr.data.state === 'failed') {
            clearInterval(timer); rebuilding.value = false
            remoteMsg.value = { type: 'err', text: (sr.data.message || '构建失败') + (sr.data.detail ? '：' + sr.data.detail : '') }
          }
        }
      }, 2000)
      setTimeout(() => { clearInterval(timer); if (rebuilding.value) { rebuilding.value = false; remoteMsg.value = { type: 'err', text: '构建超时' } } }, 150000)
    }

    async function startRemoteDeploy() {
      deploying.value = true
      logs.value = []
      const res = await runDeploy(remote)
      if (withAdminRetry(res, '执行远程部署需要管理员密码', startRemoteDeploy)) { deploying.value = false; return }
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
          if (res.data.success) {
            const confirm = await confirmDeploy()
            if (!confirm.ok) remoteMsg.value = { type: 'err', text: '部署成功，但版本记录写入失败' }
          }
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
        if (withAdminRetry(res, '上传 cookies 需要管理员密码', () => uploadCookie(event))) return
        remoteMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? 'cookies 已上传' : '上传失败') }
      }
      reader.readAsDataURL(file)
    }

    function formatSize(size) {
      if (!size) return '0 B'
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      return (size / 1024 / 1024).toFixed(1) + ' MB'
    }

    function formatPreviewAction(action) {
      return ({ delete: '删除', keep: '保留', missing: '缺失', error: '错误' })[action] || action
    }

    watch(logs, scrollDeployLogToBottom)
    watch(mode, value => { if (value === 'remote') scrollDeployLogToBottom() })

    onMounted(() => {
      checkEnv()
      loadRemoteConfig()
      scrollDeployLogToBottom()
    })
    onActivated(scrollDeployLogToBottom)
    onUnmounted(() => {
      if (progressTimer) clearInterval(progressTimer)
    })

    return { mode, local, remote, env, localMsg, remoteMsg, logs, napcatUrl, napcatInstallDir, deletePreview, uninstallPreview, deployLogRef, checking, downloading, installingNapcat, localDeploying, previewingDelete, deletingConfig, previewingUninstall, uninstalling, uninstallConfirmed, savingRemote, deploying, rebuilding, isWindows, canChooseDirectory, deleteCandidates, keptCandidates, previewRows, localConfigReady, localConfigSummary, napcatStatusText, napcatStatusClass, portSummary, uninstallDeleteItems, uninstallUserDataItems, uninstallKeepItems, uninstallWarnings, uninstallBaseDeleteSize, uninstallUserDataSize, uninstallSelectedDeleteSize, uninstallSelectedDeleteCount, checkEnv, chooseNapcatDir, doDownloadWindowsNapcat, doDownloadNapcat, writeLocalConfig, previewDeleteConfig, confirmDeleteConfig, previewLocalUninstallFlow, closeUninstallPreview, shouldKeepUserData, setUserDataKeep, setAllUserDataKeep, formatUninstallPaths, confirmLocalUninstallFlow, loadRemoteConfig, saveRemoteConfig, checkRemoteUpdate, startRemoteDeploy, doRebuildFrontend, uploadCookie, formatSize, formatPreviewAction }
  },
}
</script>