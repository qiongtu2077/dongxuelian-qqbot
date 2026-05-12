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

    <div v-if="mode === 'local'" class="card local-wizard-card">
      <div class="local-wizard-head">
        <div>
          <h2>Windows 本地部署向导</h2>
          <p class="deploy-software-note">windows本地部署需要使用软件</p>
          <div class="grp-desc">{{ localDeployDescription }}</div>
        </div>
        <button v-if="canRunWindowsLocalDeploy" class="btn" type="button" @click="runLocalWizard" :disabled="autoDeploying">{{ autoDeploying ? '部署流程进行中...' : '一键准备并启动' }}</button>
      </div>

      <div v-if="canRunWindowsLocalDeploy" class="flow-sentence">{{ localFlowText }}</div>

      <div v-if="canRunWindowsLocalDeploy" class="station-map" role="list" aria-label="本地部署步骤">
        <button v-for="(step, index) in wizardSteps" :key="step.id" type="button" :class="['station-node', 'station-' + step.status, { active: activeLocalStep === step.id }]" @click="activeLocalStep = step.id">
          <span class="station-dot">{{ index + 1 }}</span>
          <span class="station-title">{{ step.title }}</span>
          <small>{{ stationStatusText(step.status) }}</small>
        </button>
      </div>

      <div v-if="localDeployBlocked" class="local-warning local-blocked-panel">
        <strong>当前不是 Windows 本地部署器</strong>
        <span>{{ localDeployBlockedReason }}</span>
        <span>{{ localDeployTargetSummary }}</span>
        <button class="btn btn-sm btn-ghost" type="button" @click="mode = 'remote'">切换到远程 Linux 部署</button>
      </div>

      <div v-if="canRunWindowsLocalDeploy" class="local-wizard-layout">
        <section class="local-panel local-config-panel">
          <div class="section-head"><strong>最少配置</strong><span>机器人 QQ 必填，AI Key 可以先留空</span></div>
          <div class="row"><label>机器人 QQ</label><input v-model="local.qq" placeholder="机器人 QQ 号" /></div>
          <div class="row"><label>API Key</label><input v-model="local.apiKey" placeholder="可留空，之后在 API Keys 页填写" /></div>
          <p class="inline-note">AI Key 留空时仍会完成 NapCat 登录和 Koishi 启动；完成页会标记为基础可用，AI 回复暂不可用。</p>

          <details class="advanced-options">
            <summary>高级设置</summary>
            <div class="row"><label>供应商</label><input v-model="local.provider" placeholder="opencode / deepseek / dashscope" /></div>
            <div class="row"><label>模型</label><input v-model="local.model" placeholder="deepseek-v4-flash" /></div>
            <div class="row"><label>API 地址</label><input v-model="local.baseUrl" placeholder="留空使用项目默认" /></div>
            <div class="row"><label>NapCat 目录</label><div class="path-control"><input v-model="napcatInstallDir" placeholder="默认 runtime/napcat" /><button v-if="canChooseDirectory" class="btn btn-sm btn-ghost" type="button" @click="chooseNapcatDir">选择目录</button></div></div>
            <div class="row"><label>NapCat URL</label><input v-model="napcatUrl" placeholder="可选：手动下载包直链，仅保存到 runtime/downloads" /></div>
            <div class="deploy-actions">
              <button class="btn btn-sm btn-ghost" type="button" @click="doDownloadNapcat" :disabled="downloading">{{ downloading ? '下载中...' : '下载直链包' }}</button>
              <button class="btn btn-sm btn-ghost btn-danger" type="button" @click="previewDeleteConfig" :disabled="previewingDelete || deletingConfig">{{ previewingDelete ? '读取中...' : '删除 Koishi 配置' }}</button>
            </div>
          </details>
        </section>

        <section class="local-panel station-detail-panel">
          <div class="section-head"><strong>{{ activeStation.title }}</strong><span>{{ activeStation.description }}</span></div>
          <div class="station-detail-body">
            <p>{{ activeStationHint }}</p>
            <div class="deploy-actions">
              <button v-if="activeLocalStep === 'env'" class="btn btn-sm" type="button" @click="checkEnv" :disabled="checking">{{ checking ? '检测中...' : '检测环境' }}</button>
              <button v-if="activeLocalStep === 'install'" class="btn btn-sm" type="button" @click="doDownloadWindowsNapcat" :disabled="installingNapcat || !isWindows">{{ installingNapcat ? '安装中...' : '一键安装 NapCat（Windows，官方包）' }}</button>
              <a v-if="activeLocalStep === 'install'" class="btn btn-sm btn-ghost" href="https://github.com/NapNeko/NapCatQQ/releases/latest" target="_blank">打开 NapCat 发布页</a>
              <button v-if="activeLocalStep === 'config'" class="btn btn-sm" type="button" @click="writeLocalConfig" :disabled="localDeploying">{{ localDeploying ? '写入中...' : '生成 Koishi 本地配置' }}</button>
              <button v-if="activeLocalStep === 'npm'" class="btn btn-sm" type="button" @click="runNpmInstallStep" :disabled="installingDeps">{{ installingDeps ? '安装中...' : '执行 npm install' }}</button>
              <button v-if="activeLocalStep === 'napcat-start'" class="btn btn-sm" type="button" @click="startNapcatStep" :disabled="startingNapcat">{{ startingNapcat ? '启动中...' : '启动 NapCat' }}</button>
              <template v-if="activeLocalStep === 'scan'">
                <button class="btn btn-sm" type="button" @click="openNapcatWebui">打开 NapCat WebUI</button>
                <button class="btn btn-sm btn-ghost" type="button" @click="continueAfterScan" :disabled="startingKoishi">{{ startingKoishi ? '启动 Koishi 中...' : '我已扫码，继续' }}</button>
              </template>
              <button v-if="activeLocalStep === 'koishi'" class="btn btn-sm" type="button" @click="startKoishiStep" :disabled="startingKoishi">{{ startingKoishi ? '启动中...' : '启动 Koishi' }}</button>
              <button v-if="activeLocalStep === 'health'" class="btn btn-sm" type="button" @click="runReadyCheckStep" :disabled="checkingReady">{{ checkingReady ? '检查中...' : '健康检查' }}</button>
            </div>
          </div>
        </section>
      </div>

      <div v-if="env && localDeployBlocked" class="deploy-status local-target-status">
        <div class="status-item"><span>检测目标</span><b>{{ env.host?.platform }} / {{ env.host?.arch }}</b><small>{{ env.host?.hostname }}</small></div>
        <div class="status-item"><span>项目目录</span><code>{{ env.projectDir }}</code></div>
        <div class="status-item"><span>runtime</span><code>{{ env.runtimeDir }}</code></div>
        <div class="status-item"><span>Windows 本地部署</span><b class="err-text">不可在此执行</b><small>这不是浏览器所在 Windows 电脑，而是 Dashboard 后端机器。</small></div>
      </div>

      <div v-if="env && canRunWindowsLocalDeploy" class="deploy-status">
        <div class="status-item"><span>当前机器</span><b>{{ env.host?.platform }} / {{ env.host?.arch }}</b><small>{{ env.host?.hostname }}</small></div>
        <div class="status-item"><span>项目目录</span><code>{{ env.projectDir }}</code></div>
        <div class="status-item"><span>runtime</span><code>{{ env.runtimeDir }}</code></div>
        <div class="status-item"><span>Node.js</span><b :class="env.node?.ok ? 'ok-text' : 'err-text'">{{ env.node?.version || '未检测到' }}</b><small>{{ env.node?.sourcePath || env.node?.reason }}</small></div>
        <div class="status-item"><span>npm</span><b :class="env.npm?.found ? 'ok-text' : 'err-text'">{{ env.npm?.version || '未检测到' }}</b><small>{{ env.npm?.sourcePath || env.npm?.reason }}</small></div>
        <div class="status-item"><span>项目依赖</span><b :class="env.dependencies?.ready ? 'ok-text' : 'warn-text'">{{ env.dependencies?.ready ? '已安装' : '未完整安装' }}</b><small>{{ env.dependencies?.reason }}</small></div>
        <div class="status-item"><span>Koishi 配置</span><b :class="localConfigReady ? 'ok-text' : 'warn-text'">{{ localConfigReady ? '已生成' : '未生成' }}</b><small>{{ localConfigSummary }}</small></div>
        <div class="status-item"><span>端口</span><code>{{ portSummary }}</code></div>
        <div class="status-item"><span>NapCat</span><b :class="napcatStatusClass">{{ napcatStatusText }}</b><small>{{ env.napcat?.reason }}</small><code v-if="env.napcat?.entry || env.napcat?.path">{{ env.napcat?.entry || env.napcat?.path }}</code></div>
      </div>

      <div v-if="readyCheck && canRunWindowsLocalDeploy" class="ready-panel" :class="readyCheck.basicReady ? 'ready-ok' : 'ready-warn'">
        <strong>{{ readyCheck.fullyReady ? '完全可用' : (readyCheck.basicReady ? '基础可用' : '尚未就绪') }}</strong>
        <span>{{ readyCheck.message }}</span>
        <div class="ready-links">
          <a class="btn btn-sm btn-ghost" :href="readyCheck.dashboardUrl || '/dashboard/'" target="_blank">Dashboard</a>
          <a class="btn btn-sm btn-ghost" :href="readyCheck.koishiUrl || 'http://127.0.0.1:5140/'" target="_blank">Koishi</a>
          <button class="btn btn-sm btn-ghost" type="button" @click="openNapcatWebui">NapCat WebUI</button>
        </div>
      </div>

      <pre v-if="canRunWindowsLocalDeploy && currentLocalLogLines.length" ref="localLogRef" class="deploy-log themed-scrollbar">{{ currentLocalLogLines.join('\n') }}</pre>

      <div v-if="canRunWindowsLocalDeploy && deletePreview" class="delete-preview">
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

      <div v-if="canRunWindowsLocalDeploy" class="danger-zone">
        <div>
          <strong>危险区</strong>
          <span>部署失败或想重新来过时，可清理本项目安装/生成的本地环境。系统全局 Node.js/npm 只报告，不自动删除。</span>
        </div>
        <button class="btn btn-sm btn-danger-solid" type="button" @click="previewLocalUninstallFlow" :disabled="previewingUninstall || uninstalling">{{ previewingUninstall ? '读取中...' : '一键卸载本地部署环境' }}</button>
      </div>

      <div v-if="localMsg" class="msg" :class="localMsg.type">{{ localMsg.text }}</div>
    </div>

    <div v-if="canRunWindowsLocalDeploy && uninstallPreview" class="modal-backdrop uninstall-backdrop">
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
import { checkDeployUpdate, checkLocalEnv, confirmDeploy, confirmLocalUninstall, deleteLocalConfig, deployLocal, downloadNapcat, downloadNapcatWindows, fetchDeployConfig, getDeployProgress, koishiDeployStatus, localReadyCheck, napcatDeployStatus, npmInstallStatus, previewLocalConfigDelete, previewLocalUninstall, rebuildFrontend, rebuildFrontendStatus, runDeploy, startKoishiLocal, startNapcat, startNpmInstall, updateDeployConfig, uploadDeploy } from '../api'

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
    const autoDeploying = ref(false)
    const installingDeps = ref(false)
    const startingNapcat = ref(false)
    const startingKoishi = ref(false)
    const checkingReady = ref(false)
    const activeLocalStep = ref('env')
    const localLogRef = ref(null)
    const npmTaskStatus = ref(null)
    const napcatTaskStatus = ref(null)
    const koishiTaskStatus = ref(null)
    const readyCheck = ref(null)
    const savingRemote = ref(false)
    const deploying = ref(false)
    const rebuilding = ref(false)
    let progressTimer = null
    let localStatusTimer = null

    const localFlowText = '环境检测 -> 安装 NapCat -> 生成配置 -> npm install -> 启动 NapCat -> 等待扫码 -> 启动 Koishi -> 健康检查'
    const localStepDefs = [
      { id: 'env', title: '环境检测', description: '确认当前 Windows 目标机、Node.js、npm、端口和项目目录。' },
      { id: 'install', title: '安装 NapCat', description: '下载并解压 NapCat 官方 Windows 包到 runtime/napcat 或你选择的目录。' },
      { id: 'config', title: '生成配置', description: '写入 koishi.yml、start-local.bat 和本地 AI 配置；AI Key 可留空。' },
      { id: 'npm', title: 'npm install', description: '安装 Koishi 和项目依赖，并把日志写入 runtime/logs/npm-install.log。' },
      { id: 'napcat-start', title: '启动 NapCat', description: '在当前 Windows 机器启动 NapCat，等待 WebUI 或二维码出现。' },
      { id: 'scan', title: '等待扫码', description: '使用机器人 QQ 扫码登录 NapCat，完成后继续启动 Koishi。' },
      { id: 'koishi', title: '启动 Koishi', description: '启动 Koishi 5140 服务，并连接 NapCat 的 OneBot WebSocket。' },
      { id: 'health', title: '健康检查', description: '检查 Node/npm、依赖、NapCat、OneBot、Koishi 和 AI Key 状态。' },
    ]
    const stationState = reactive(Object.fromEntries(localStepDefs.map(step => [step.id, 'pending'])))

    const deployerBridge = computed(() => (typeof window !== 'undefined' ? window.dongxuelianDeployer : null))
    const localDeployTarget = computed(() => env.value?.localDeployTarget || null)
    const backendPlatform = computed(() => localDeployTarget.value?.platform || env.value?.host?.platform || env.value?.platform || '')
    const isWindows = computed(() => (backendPlatform.value || deployerBridge.value?.platform) === 'win32')
    const canRunWindowsLocalDeploy = computed(() => localDeployTarget.value ? !!localDeployTarget.value.canRunWindowsLocalDeploy : isWindows.value)
    const localDeployBlocked = computed(() => !!env.value && !canRunWindowsLocalDeploy.value)
    const localDeployBlockedReason = computed(() => localDeployTarget.value?.blockedReason || '当前 Dashboard 后端不是 Windows，不能执行 Windows 本地部署。')
    const localDeployTargetSummary = computed(() => {
      const host = env.value?.host || {}
      const dir = env.value?.projectDir || ''
      return `当前检测目标：${host.platform || backendPlatform.value || 'unknown'} / ${host.arch || localDeployTarget.value?.arch || 'unknown'}，项目目录：${dir || '未检测'}`
    })
    const localDeployDescription = computed(() => canRunWindowsLocalDeploy.value
      ? '当前 Dashboard 后端机器就是 Windows 本地部署目标。所有运行时文件默认放在当前项目的 runtime/ 下；NapCat 扫码登录后，Koishi 使用 127.0.0.1:8080 连接。'
      : '当前页面只能显示 Dashboard 后端机器状态。远端 Linux Dashboard 不能检测浏览器所在的 Windows 电脑；请打开 Windows 部署器软件后再执行本地部署。')
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
    const wizardSteps = computed(() => localStepDefs.map(step => ({ ...step, status: stationState[step.id] || 'pending' })))
    const activeStation = computed(() => wizardSteps.value.find(step => step.id === activeLocalStep.value) || wizardSteps.value[0])
    const activeStationHint = computed(() => {
      const step = activeStation.value
      if (!step) return ''
      if (step.id === 'scan') return '扫码是唯一需要你手动完成的步骤。登录后点击“我已扫码，继续”，系统会启动 Koishi 并做健康检查。'
      if (step.id === 'health' && readyCheck.value) return readyCheck.value.message || step.description
      if (step.id === 'config') return '只要求填写机器人 QQ。AI Key 可以留空，之后在 API Keys 页补充。'
      return step.description
    })
    const currentLocalLogLines = computed(() => {
      if (activeLocalStep.value === 'npm') return npmTaskStatus.value?.logLines || []
      if (activeLocalStep.value === 'napcat-start' || activeLocalStep.value === 'scan') return napcatTaskStatus.value?.logLines || []
      if (activeLocalStep.value === 'koishi' || activeLocalStep.value === 'health') return koishiTaskStatus.value?.logLines || []
      return []
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

    function scrollLocalLogToBottom() {
      nextTick(() => {
        const el = localLogRef.value
        if (el) el.scrollTop = el.scrollHeight
      })
    }

    function stationStatusText(status) {
      return ({ pending: '未开始', running: '处理中', success: '已完成', waiting: '等待用户', failed: '失败', skipped: '已跳过' })[status] || '未开始'
    }

    function setStepStatus(step, status) {
      if (stationState[step] !== undefined) stationState[step] = status
    }

    function resetWizardSteps() {
      for (const step of localStepDefs) stationState[step.id] = 'pending'
    }

    function ensureWindowsLocalDeploy() {
      if (canRunWindowsLocalDeploy.value) return true
      resetWizardSteps()
      localMsg.value = { type: 'err', text: localDeployBlockedReason.value }
      return false
    }

    function updateWizardFromSignals() {
      if (!canRunWindowsLocalDeploy.value) {
        resetWizardSteps()
        return
      }
      if (env.value) {
        setStepStatus('env', env.value.node?.ok && env.value.npm?.found ? 'success' : 'failed')
        setStepStatus('install', env.value.napcat?.found ? 'success' : (stationState.install === 'running' ? 'running' : 'pending'))
        setStepStatus('config', localConfigReady.value ? 'success' : (stationState.config === 'running' ? 'running' : 'pending'))
        if (env.value.dependencies?.ready && stationState.npm !== 'running') setStepStatus('npm', 'success')
      }
      const npmStatus = npmTaskStatus.value
      if (npmStatus?.running) setStepStatus('npm', 'running')
      else if (npmStatus?.dependencies?.ready) setStepStatus('npm', npmStatus.state === 'idle' ? 'success' : 'success')
      else if (npmStatus?.state === 'failed') setStepStatus('npm', 'failed')
      const napcatStatus = napcatTaskStatus.value
      if (napcatStatus?.webuiPort?.status === 'occupied' || napcatStatus?.onebotPort?.status === 'occupied') {
        setStepStatus('napcat-start', 'success')
        setStepStatus('scan', napcatStatus.login?.status === 'ok' ? 'success' : 'waiting')
      } else if (napcatStatus?.running) {
        setStepStatus('napcat-start', 'running')
      } else if (napcatStatus?.state === 'failed') {
        setStepStatus('napcat-start', 'failed')
      }
      const koishiStatus = koishiTaskStatus.value
      if (koishiStatus?.port?.status === 'occupied') setStepStatus('koishi', 'success')
      else if (koishiStatus?.running) setStepStatus('koishi', 'running')
      else if (koishiStatus?.state === 'failed') setStepStatus('koishi', 'failed')
      if (readyCheck.value) setStepStatus('health', readyCheck.value.basicReady ? 'success' : 'failed')
    }

    async function refreshLocalTaskStatuses(includeReady = false) {
      if (!canRunWindowsLocalDeploy.value) {
        npmTaskStatus.value = null
        napcatTaskStatus.value = null
        koishiTaskStatus.value = null
        if (includeReady) readyCheck.value = null
        resetWizardSteps()
        return
      }
      const [npmRes, napcatRes, koishiRes] = await Promise.all([npmInstallStatus(), napcatDeployStatus(), koishiDeployStatus()])
      if (npmRes.ok) npmTaskStatus.value = npmRes.data.status
      if (napcatRes.ok) napcatTaskStatus.value = napcatRes.data.status
      if (koishiRes.ok) koishiTaskStatus.value = koishiRes.data.status
      if (includeReady) {
        const readyRes = await localReadyCheck()
        if (readyRes.ok) readyCheck.value = readyRes.data
      }
      updateWizardFromSignals()
      scrollLocalLogToBottom()
    }

    async function waitForLocalTask(fetcher, assign, step, isDone) {
      for (let i = 0; i < 240; i += 1) {
        const res = await fetcher()
        if (res.ok) {
          assign(res.data.status)
          updateWizardFromSignals()
          scrollLocalLogToBottom()
          if (isDone(res.data.status)) return res.data.status
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      setStepStatus(step, 'failed')
      throw new Error('等待步骤完成超时')
    }

    async function checkEnv() {
      checking.value = true
      localMsg.value = null
      setStepStatus('env', 'running')
      const res = await checkLocalEnv()
      if (res.ok) {
        env.value = res.data
        syncNapcatInstallDir(res.data)
        if (!canRunWindowsLocalDeploy.value) {
          resetWizardSteps()
          readyCheck.value = null
          npmTaskStatus.value = null
          napcatTaskStatus.value = null
          koishiTaskStatus.value = null
          localMsg.value = { type: 'err', text: localDeployBlockedReason.value }
          checking.value = false
          return
        }
        localMsg.value = { type: 'ok', text: '环境检测完成' }
        updateWizardFromSignals()
        await refreshLocalTaskStatuses(false)
      } else {
        setStepStatus('env', 'failed')
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
      if (!ensureWindowsLocalDeploy()) return
      installingNapcat.value = true
      activeLocalStep.value = 'install'
      setStepStatus('install', 'running')
      localMsg.value = { type: 'ok', text: '正在下载并解压 NapCat（Windows），请稍等...' }
      const res = await downloadNapcatWindows(napcatInstallDir.value)
      if (withAdminRetry(res, '下载并安装 NapCat 需要管理员密码', doDownloadWindowsNapcat)) { installingNapcat.value = false; return }
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? 'NapCat 已安装' : '安装失败') }
      setStepStatus('install', res.ok ? 'success' : 'failed')
      installingNapcat.value = false
      if (res.ok) await checkEnv()
    }

    async function doDownloadNapcat() {
      if (!ensureWindowsLocalDeploy()) return
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
      if (!ensureWindowsLocalDeploy()) return
      if (!/^\d+$/.test(local.qq.trim())) {
        localMsg.value = { type: 'err', text: '请先填写机器人 QQ 号' }
        activeLocalStep.value = 'config'
        setStepStatus('config', 'failed')
        return
      }
      localDeploying.value = true
      activeLocalStep.value = 'config'
      setStepStatus('config', 'running')
      localMsg.value = null
      const res = await deployLocal({ ...local, qq: local.qq.trim() })
      if (withAdminRetry(res, '生成 Koishi 本地配置需要管理员密码', writeLocalConfig)) { localDeploying.value = false; return }
      const files = res.data?.files || []
      const changed = files.filter(item => item.action !== 'unchanged').length
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: res.data?.message || (res.ok ? `Koishi 本地配置已生成，写入 ${changed} 个文件` : '生成失败') }
      setStepStatus('config', res.ok ? 'success' : 'failed')
      deletePreview.value = null
      localDeploying.value = false
      if (res.ok) await checkEnv()
    }

    async function runNpmInstallStep() {
      if (!ensureWindowsLocalDeploy()) return
      installingDeps.value = true
      activeLocalStep.value = 'npm'
      setStepStatus('npm', 'running')
      localMsg.value = { type: 'ok', text: '正在执行 npm install，日志会自动滚动到底部...' }
      const res = await startNpmInstall()
      if (withAdminRetry(res, '执行 npm install 需要管理员密码', runNpmInstallStep)) { installingDeps.value = false; return }
      if (!res.ok) {
        setStepStatus('npm', 'failed')
        localMsg.value = { type: 'err', text: res.data?.message || 'npm install 启动失败' }
        installingDeps.value = false
        return
      }
      if (res.data?.status) npmTaskStatus.value = res.data.status
      if (res.data?.skipped) {
        setStepStatus('npm', 'skipped')
      } else {
        try {
          await waitForLocalTask(npmInstallStatus, status => { npmTaskStatus.value = status }, 'npm', status => !status.running && (status.dependencies?.ready || status.state === 'failed'))
          setStepStatus('npm', npmTaskStatus.value?.dependencies?.ready ? 'success' : 'failed')
        } catch (e) {
          setStepStatus('npm', 'failed')
          localMsg.value = { type: 'err', text: e.message || 'npm install 等待失败' }
        }
      }
      installingDeps.value = false
      await checkEnv()
    }

    async function startNapcatStep() {
      if (!ensureWindowsLocalDeploy()) return
      startingNapcat.value = true
      activeLocalStep.value = 'napcat-start'
      setStepStatus('napcat-start', 'running')
      localMsg.value = { type: 'ok', text: '正在启动 NapCat。启动后请打开 WebUI 或查看控制台二维码扫码。' }
      const res = await startNapcat()
      if (withAdminRetry(res, '启动 NapCat 需要管理员密码', startNapcatStep)) { startingNapcat.value = false; return }
      if (!res.ok) {
        setStepStatus('napcat-start', 'failed')
        localMsg.value = { type: 'err', text: res.data?.message || 'NapCat 启动失败' }
        startingNapcat.value = false
        return
      }
      if (res.data?.status) napcatTaskStatus.value = res.data.status
      try {
        await waitForLocalTask(napcatDeployStatus, status => { napcatTaskStatus.value = status }, 'napcat-start', status => status.webuiPort?.status === 'occupied' || status.onebotPort?.status === 'occupied' || status.state === 'failed')
        setStepStatus('napcat-start', (napcatTaskStatus.value?.webuiPort?.status === 'occupied' || napcatTaskStatus.value?.onebotPort?.status === 'occupied') ? 'success' : 'failed')
        setStepStatus('scan', napcatTaskStatus.value?.login?.status === 'ok' ? 'success' : 'waiting')
        activeLocalStep.value = 'scan'
        localMsg.value = { type: 'ok', text: 'NapCat 已启动。请使用机器人 QQ 扫码登录，完成后点击“我已扫码，继续”。' }
      } catch (e) {
        setStepStatus('napcat-start', 'failed')
        localMsg.value = { type: 'err', text: e.message || 'NapCat 启动等待失败' }
      }
      startingNapcat.value = false
    }

    async function startKoishiStep() {
      if (!ensureWindowsLocalDeploy()) return
      startingKoishi.value = true
      activeLocalStep.value = 'koishi'
      setStepStatus('koishi', 'running')
      localMsg.value = { type: 'ok', text: '正在启动 Koishi，本地日志会显示在下方。' }
      const res = await startKoishiLocal()
      if (withAdminRetry(res, '启动 Koishi 需要管理员密码', startKoishiStep)) { startingKoishi.value = false; return }
      if (!res.ok) {
        setStepStatus('koishi', 'failed')
        localMsg.value = { type: 'err', text: res.data?.message || 'Koishi 启动失败' }
        startingKoishi.value = false
        return
      }
      if (res.data?.status) koishiTaskStatus.value = res.data.status
      try {
        await waitForLocalTask(koishiDeployStatus, status => { koishiTaskStatus.value = status }, 'koishi', status => status.port?.status === 'occupied' || status.state === 'failed')
        setStepStatus('koishi', koishiTaskStatus.value?.port?.status === 'occupied' ? 'success' : 'failed')
      } catch (e) {
        setStepStatus('koishi', 'failed')
        localMsg.value = { type: 'err', text: e.message || 'Koishi 启动等待失败' }
      }
      startingKoishi.value = false
      await runReadyCheckStep()
    }

    async function runReadyCheckStep() {
      if (!ensureWindowsLocalDeploy()) return
      checkingReady.value = true
      activeLocalStep.value = 'health'
      setStepStatus('health', 'running')
      const res = await localReadyCheck()
      if (res.ok) {
        readyCheck.value = res.data
        setStepStatus('health', res.data.basicReady ? 'success' : 'failed')
        localMsg.value = { type: res.data.basicReady ? 'ok' : 'err', text: res.data.message || '健康检查完成' }
      } else {
        setStepStatus('health', 'failed')
        localMsg.value = { type: 'err', text: res.data?.message || '健康检查失败' }
      }
      checkingReady.value = false
      await refreshLocalTaskStatuses(false)
    }

    async function continueAfterScan() {
      if (!ensureWindowsLocalDeploy()) return
      setStepStatus('scan', 'success')
      await refreshLocalTaskStatuses(false)
      await startKoishiStep()
    }

    function openNapcatWebui() {
      window.open('/webui/', '_blank', 'noopener')
    }

    async function runLocalWizard() {
      autoDeploying.value = true
      localMsg.value = null
      try {
        await checkEnv()
        if (!ensureWindowsLocalDeploy()) throw new Error(localDeployBlockedReason.value)
        if (!env.value?.node?.ok || !env.value?.npm?.found) throw new Error('Node.js 或 npm 未就绪，请先安装 Node.js 18+/20+ 后重新检测')
        if (!env.value?.napcat?.found) {
          await doDownloadWindowsNapcat()
          if (!env.value?.napcat?.found) throw new Error('NapCat 未安装完成，请检查安装日志后重试')
        }
        await writeLocalConfig()
        if (!localConfigReady.value) throw new Error('Koishi 本地配置未生成，请检查机器人 QQ 和管理员验证')
        await runNpmInstallStep()
        if (!env.value?.dependencies?.ready) throw new Error('npm install 未完成，请查看日志后重试')
        await startNapcatStep()
      } catch (e) {
        localMsg.value = { type: 'err', text: e.message || '本地部署流程中断' }
      } finally {
        autoDeploying.value = false
      }
    }

    async function previewDeleteConfig() {
      if (!ensureWindowsLocalDeploy()) return
      previewingDelete.value = true
      localMsg.value = null
      const res = await previewLocalConfigDelete()
      if (withAdminRetry(res, '删除 Koishi 配置前需要管理员密码', previewDeleteConfig)) { previewingDelete.value = false; return }
      if (res.ok) deletePreview.value = res.data
      else localMsg.value = { type: 'err', text: res.data?.message || '读取删除预览失败' }
      previewingDelete.value = false
    }

    async function confirmDeleteConfig() {
      if (!ensureWindowsLocalDeploy()) return
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
      if (!ensureWindowsLocalDeploy()) return
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
      if (!ensureWindowsLocalDeploy()) return
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
    watch(currentLocalLogLines, scrollLocalLogToBottom)
    watch(mode, value => {
      if (value === 'remote') scrollDeployLogToBottom()
      if (value === 'local' && canRunWindowsLocalDeploy.value) refreshLocalTaskStatuses(false)
    })

    onMounted(() => {
      checkEnv()
      loadRemoteConfig()
      refreshLocalTaskStatuses(false)
      localStatusTimer = setInterval(() => {
        if (mode.value === 'local' && canRunWindowsLocalDeploy.value) refreshLocalTaskStatuses(false)
      }, 3500)
      scrollDeployLogToBottom()
    })
    onActivated(scrollDeployLogToBottom)
    onUnmounted(() => {
      if (progressTimer) clearInterval(progressTimer)
      if (localStatusTimer) clearInterval(localStatusTimer)
    })

    return { mode, local, remote, env, localMsg, remoteMsg, logs, napcatUrl, napcatInstallDir, deletePreview, uninstallPreview, deployLogRef, localLogRef, checking, downloading, installingNapcat, localDeploying, previewingDelete, deletingConfig, previewingUninstall, uninstalling, uninstallConfirmed, autoDeploying, installingDeps, startingNapcat, startingKoishi, checkingReady, activeLocalStep, localFlowText, wizardSteps, activeStation, activeStationHint, currentLocalLogLines, readyCheck, savingRemote, deploying, rebuilding, isWindows, canRunWindowsLocalDeploy, localDeployBlocked, localDeployBlockedReason, localDeployTargetSummary, localDeployDescription, canChooseDirectory, deleteCandidates, keptCandidates, previewRows, localConfigReady, localConfigSummary, napcatStatusText, napcatStatusClass, portSummary, uninstallDeleteItems, uninstallUserDataItems, uninstallKeepItems, uninstallWarnings, uninstallBaseDeleteSize, uninstallUserDataSize, uninstallSelectedDeleteSize, uninstallSelectedDeleteCount, stationStatusText, checkEnv, chooseNapcatDir, doDownloadWindowsNapcat, doDownloadNapcat, writeLocalConfig, runNpmInstallStep, startNapcatStep, continueAfterScan, startKoishiStep, runReadyCheckStep, openNapcatWebui, runLocalWizard, previewDeleteConfig, confirmDeleteConfig, previewLocalUninstallFlow, closeUninstallPreview, shouldKeepUserData, setUserDataKeep, setAllUserDataKeep, formatUninstallPaths, confirmLocalUninstallFlow, loadRemoteConfig, saveRemoteConfig, checkRemoteUpdate, startRemoteDeploy, doRebuildFrontend, uploadCookie, formatSize, formatPreviewAction }
  },
}
</script>