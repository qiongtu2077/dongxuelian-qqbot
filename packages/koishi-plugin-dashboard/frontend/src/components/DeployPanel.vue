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
          <div class="grp-desc">{{ localDeployDescription }}</div>
        </div>
        <button v-if="canRunWindowsLocalDeploy" class="btn" type="button" @click="runLocalWizard" :disabled="autoDeploying">{{ autoDeploying ? '环境配置中...' : '一键配置环境并启动' }}</button>
      </div>

      <div v-if="canRunWindowsLocalDeploy" class="flow-sentence">{{ localFlowText }}</div>

      <div v-if="canRunWindowsLocalDeploy" class="station-map themed-scrollbar" role="list" aria-label="本地部署步骤">
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

      <div v-if="electronPathRows.length" class="electron-path-panel">
        <div class="section-head">
          <strong>部署器路径</strong>
          <span>{{ electronPathHint }}</span>
        </div>
        <div class="path-row-list">
          <div v-for="row in electronPathRows" :key="row.key" class="path-row">
            <span>{{ row.label }}</span>
            <code>{{ row.path }}</code>
            <button class="btn btn-sm btn-ghost" type="button" @click="openElectronPath(row.path)">打开</button>
            <button class="btn btn-sm btn-ghost" type="button" @click="copyElectronPath(row.path)">复制</button>
          </div>
        </div>
        <p v-if="electronAppInfo?.fallbackReason" class="inline-note warn-text">{{ electronAppInfo.fallbackReason }}</p>
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
              <button v-if="activeLocalStep === 'npm' && !npmGuideSteps" class="btn btn-sm" type="button" @click="runNpmInstallStep" :disabled="installingDeps">{{ installingDeps ? '获取中...' : '查看安装命令' }}</button>
              <button v-if="activeLocalStep === 'npm' && npmGuideSteps" class="btn btn-sm" type="button" @click="confirmNpmDone" :disabled="installingDeps">{{ installingDeps ? '检测中...' : '我已在终端执行完成' }}</button>
              <button v-if="activeLocalStep === 'npm' && npmGuideSteps" class="btn btn-sm btn-ghost" type="button" @click="copyNpmGuideCommands">复制安装命令</button>
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
        <div v-if="workspaceStatusText" class="status-item"><span>工作目录</span><b :class="workspaceSafe ? 'ok-text' : 'warn-text'">{{ workspaceStatusText }}</b><small>{{ workspaceStatusHint }}</small></div>
        <div class="status-item"><span>Node.js</span><b :class="env.node?.ok ? 'ok-text' : 'err-text'">{{ env.node?.version || '未检测到' }}</b><small>{{ env.node?.sourcePath || env.node?.reason }}</small><small>便携 Node 官方包内自带 npm.cmd 与 npx.cmd。</small><button v-if="!env.node?.ok" class="btn btn-sm status-action" type="button" @click="installPortableNodeStep" :disabled="installingNode">{{ installingNode ? '安装中...' : '安装便携 Node/npm' }}</button></div>
        <div class="status-item"><span>npm</span><b :class="env.npm?.found ? 'ok-text' : 'err-text'">{{ env.npm?.version || '未检测到' }}</b><small>{{ env.npm?.sourcePath || env.npm?.reason }}</small><small>这里检查 npm 命令程序是否存在，不代表项目依赖已安装。</small><button v-if="!env.npm?.found" class="btn btn-sm status-action" type="button" @click="installPortableNodeStep" :disabled="installingNode">{{ installingNode ? '安装中...' : '安装便携 Node/npm' }}</button></div>
        <div class="status-item"><span>项目依赖</span><b :class="env.dependencies?.ready ? 'ok-text' : 'warn-text'">{{ env.dependencies?.ready ? '已安装' : '未完整安装' }}</b><small>{{ env.dependencies?.reason }}</small><small>这里检查 node_modules 中 Koishi 与本项目依赖是否已由 npm install 安装完成。</small><button v-if="!env.dependencies?.ready" class="btn btn-sm status-action" type="button" @click="runNpmInstallStep" :disabled="installingDeps || !env.npm?.found">{{ installingDeps ? '检测中...' : '查看安装命令' }}</button></div>
        <div class="status-item"><span>Koishi 配置</span><b :class="localConfigReady ? 'ok-text' : 'warn-text'">{{ localConfigReady ? '已生成' : '未生成' }}</b><small>{{ localConfigSummary }}</small><button v-if="!localConfigReady" class="btn btn-sm status-action" type="button" @click="writeLocalConfig" :disabled="localDeploying">{{ localDeploying ? '写入中...' : '生成配置' }}</button></div>
        <div class="status-item"><span>端口</span><code>{{ portSummary }}</code></div>
        <div class="status-item"><span>NapCat</span><b :class="napcatStatusClass">{{ napcatStatusText }}</b><small>{{ env.napcat?.reason }}</small><code v-if="env.napcat?.entry || env.napcat?.path">{{ env.napcat?.entry || env.napcat?.path }}</code><button v-if="!env.napcat?.found" class="btn btn-sm status-action" type="button" @click="doDownloadWindowsNapcat" :disabled="installingNapcat || !isWindows">{{ installingNapcat ? '安装中...' : '安装 NapCat' }}</button></div>
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

      <div v-if="activeLocalStep === 'npm' && npmGuideSteps" class="npm-guide-card card">
        <strong>请在终端中手动执行以下命令：</strong>
        <ol class="npm-guide-steps">
          <li v-for="step in npmGuideSteps" :key="step.command"><span>{{ step.label }}</span><code>{{ step.command }}</code></li>
        </ol>
        <small>完成后点击"我已在终端执行完成"按钮，部署器会自动检测依赖状态。</small>
      </div>

    <div v-if="activeLocalStep === 'npm' && npmFailureGuide" class="repair-guide">
        <div class="repair-guide-head">
          <div>
            <strong>{{ npmFailureGuide.title }}</strong>
            <span>{{ npmFailureGuide.summary }}</span>
          </div>
          <div class="repair-guide-actions">
            <button v-if="npmFailureGuide.code === 'NPM_PROXY_REFUSED'" class="btn btn-sm" type="button" @click="repairNpmProxyFlow" :disabled="repairingNpm || installingDeps">{{ repairingNpm ? '修复中...' : '查看代理修复命令' }}</button>
            <button v-if="npmGuideCommands.length" class="btn btn-sm btn-ghost" type="button" @click="copyNpmFixCommands">复制部署器 npm 命令</button>
          </div>
        </div>
        <ol>
          <li v-for="step in npmFailureGuide.fixSteps" :key="step">{{ step }}</li>
        </ol>
        <div v-if="npmGuideCommands.length" class="repair-command-list">
          <code v-for="command in npmGuideCommands" :key="command">{{ command }}</code>
        </div>
        <div v-if="npmDiagnosticRows.length" class="repair-diagnostics">
          <span v-for="row in npmDiagnosticRows" :key="row.label"><b>{{ row.label }}</b>{{ row.value }}</span>
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

    <div v-if="localAlert" class="modal-backdrop local-alert-backdrop" @click.self="closeLocalAlert">
      <div class="admin-modal-card local-alert-card" role="dialog" aria-modal="true" aria-labelledby="local-alert-title">
        <h2 id="local-alert-title" class="admin-modal-title">提示</h2>
        <p class="local-alert-text">{{ localAlert }}</p>
        <div class="gate-actions">
          <button class="btn" type="button" autofocus @click="closeLocalAlert">确定</button>
        </div>
      </div>
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
              <input type="checkbox" :checked="shouldKeepUserData(item)" @change="onUserDataKeepChange(item, $event)" :disabled="uninstalling" />
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
      <div class="grp-desc" style="margin-bottom:14px">需要本机可以直接 SSH 到服务器。部署会先重建当前 Dashboard 后端机器上的最新前端，再上传插件代码、前端源码、全新 dist 和必要脚本到远程目录。</div>
      <div class="row"><label>服务器</label><input v-model="remote.server" placeholder="<YOUR_SERVER_USER>@<YOUR_SERVER_HOST>" /></div>
      <div class="row"><label>应用目录</label><input v-model="remote.appDir" placeholder="<YOUR_DATA_DIR>" /></div>
      <div class="row"><label>模式</label><SelectBox v-model="remote.mode" :options="remoteModeOptions" /></div>

      <div class="deploy-actions">
        <button class="btn btn-sm" type="button" @click="loadRemoteConfig">自动填入服务器地址</button>
        <button class="btn btn-sm" type="button" @click="saveRemoteConfig" :disabled="savingRemote">{{ savingRemote ? '保存中...' : '保存服务器地址' }}</button>
        <button class="btn btn-sm" type="button" @click="checkRemoteUpdate">检查更新</button>
        <button class="btn btn-sm" type="button" @click="startRemoteDeploy" :disabled="deploying || rebuilding">{{ deploying ? '部署中...' : '重建并部署到远端' }}</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="doRebuildFrontend" :disabled="rebuilding || deploying">{{ rebuilding ? '构建中...' : '重建前端' }}</button>
      </div>
      <div class="deploy-action-notes" aria-label="远程部署按钮说明">
        <p><strong>重建并部署到远端：</strong>会先在当前 Dashboard 后端机器重建最新前端源码，再上传插件代码、前端源码和新的 dist；远端旧 dist 会被清理后切换为新 dist，并执行重启脚本。</p>
        <p><strong>重建前端：</strong>只在当前 Dashboard 后端所在机器本地执行构建并刷新本机 dist；需要更新服务器页面时，直接点“重建并部署到远端”。</p>
      </div>

      <div style="margin-top:12px">
        <input ref="cookieInput" type="file" accept=".txt" style="display:none" @change="uploadCookie" />
        <button class="btn btn-sm btn-ghost" type="button" @click="cookieInput?.click()">上传 B 站 cookies.txt</button>
      </div>

      <div v-if="remoteMsg" class="msg" :class="remoteMsg.type">{{ remoteMsg.text }}</div>
      <pre v-if="logs.length" ref="deployLogRef" class="deploy-log themed-scrollbar">{{ logs.join('\n') }}</pre>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, inject, nextTick, onActivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { getDongxuelianDeployerBridge, isElectronDeployerEnv } from '../electron-deployer'
import { checkDeployUpdate, checkLocalEnv, confirmDeploy, confirmLocalUninstall, deleteLocalConfig, deployLocal, downloadNapcat, downloadNapcatWindows, fetchDeployConfig, getDeployProgress, installPortableNode, koishiDeployStatus, localReadyCheck, napcatDeployStatus, npmInstallStatus, previewLocalConfigDelete, previewLocalUninstall, rebuildFrontend, rebuildFrontendStatus, repairNpmProxyAndInstall, runDeploy, startKoishiLocal, startNapcat, startNpmInstall, updateDeployConfig, uploadDeploy } from '../api'
import type { ApiResult, MessageState, SelectOption, ShowAdminDialog } from '../types'
import { asRecord, errorMessage, messageFromData } from '../types'
import SelectBox from './SelectBox.vue'

type DeployMode = 'local' | 'remote'
type RemoteMode = 'install' | 'update'
type LocalStepId = 'env' | 'install' | 'config' | 'npm' | 'napcat-start' | 'scan' | 'koishi' | 'health'
type LocalStepStatus = 'pending' | 'running' | 'success' | 'waiting' | 'failed' | 'skipped'
type AdminRetry = () => unknown

interface LocalConfig {
  qq: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

interface RemoteConfig {
  server: string
  appDir: string
  mode: RemoteMode
}

interface LocalStepDef {
  id: LocalStepId
  title: string
  description: string
}

interface WizardStep extends LocalStepDef {
  status: LocalStepStatus
}

interface ElectronAppInfo {
  distribution?: string
  executableDir?: string
  resourceRoot?: string
  workspaceRoot?: string
  logDir?: string
  fallbackReason?: string
}

interface ElectronPathRow {
  key: string
  label: string
  path: string
}

interface LocalWorkspaceInfo {
  isTempRuntime?: boolean
  packaged?: boolean
  reasons?: string[]
  workspaceRoot?: string
}

interface LocalDeployTarget {
  platform?: string
  arch?: string
  canRunWindowsLocalDeploy?: boolean
  blockedReason?: string
  workspace?: LocalWorkspaceInfo
}

interface ToolInfo {
  ok?: boolean
  found?: boolean
  version?: string
  sourcePath?: string
  reason?: string
  ownedByProject?: boolean
}

interface DependencyInfo {
  ready?: boolean
  reason?: string
}

interface PreviewItem {
  key: string
  label: string
  action: string
  path: string
  reason: string
  size?: number
  version?: string
  message: string
  paths?: Array<{ path?: string; size?: number }>
}

interface DeletePreview {
  files?: PreviewItem[]
  protected?: PreviewItem[]
}

interface NapcatInfo {
  found?: boolean
  status?: string
  reason?: string
  entry?: string
  path?: string
  expectedPath?: string
}

interface PortInfo {
  status?: string
  available?: boolean
}

interface EnvCheckData {
  localDeployTarget?: LocalDeployTarget
  host?: { platform?: string; arch?: string; hostname?: string }
  platform?: string
  projectDir?: string
  runtimeDir?: string
  node?: ToolInfo
  npm?: ToolInfo
  dependencies?: DependencyInfo
  localConfig?: DeletePreview
  napcat?: NapcatInfo
  ports?: Record<string, PortInfo>
}

interface LoginStatus {
  status?: string
  reason?: string
}

interface DeployTaskStatus {
  state?: string
  running?: boolean
  logLines?: string[]
  logFile?: string
  dependencies?: DependencyInfo
  webuiPort?: PortInfo
  onebotPort?: PortInfo
  login?: LoginStatus
  port?: PortInfo
  failureGuide?: NpmFailureGuide
}

interface NpmGuideStep {
  label: string
  command: string
}

interface NpmFailureGuide {
  title?: string
  summary?: string
  code?: string
  fixSteps?: string[]
  commands?: string[]
  diagnostics?: Record<string, unknown>
}

interface ReadyCheck {
  basicReady?: boolean
  fullyReady?: boolean
  message?: string
  dashboardUrl?: string
  koishiUrl?: string
}

interface UninstallPreview {
  deleteItems?: PreviewItem[]
  userDataItems?: PreviewItem[]
  keepItems?: PreviewItem[]
  warnings?: PreviewItem[]
}

interface DeployRunData {
  taskId?: string
  message?: string
}

interface DeployProgressData {
  lines?: string[]
  done?: boolean
  success?: boolean
}

interface RebuildStatusData {
  state?: string
  message?: string
  detail?: string
}

interface DeployActionData {
  message?: string
  manualSteps?: string[]
  needsManualSetup?: boolean
  files?: PreviewItem[]
  deleted?: unknown[]
  status?: DeployTaskStatus
  skipped?: boolean
  guide?: boolean
  steps?: NpmGuideStep[]
}

interface DeployUpdateData {
  upToDate?: boolean
  local?: string
  deployed?: string
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

function readNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function listFromData<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function dataRecord<T extends object>(value: unknown): T {
  return asRecord(value) as T
}

function normalizePreviewItem(value: unknown): PreviewItem {
  const raw = asRecord(value)
  return {
    key: readString(raw.key, readString(raw.path) || readString(raw.label)),
    label: readString(raw.label),
    action: readString(raw.action),
    path: readString(raw.path),
    reason: readString(raw.reason),
    size: raw.size === undefined ? undefined : readNumber(raw.size),
    version: readString(raw.version) || undefined,
    message: readString(raw.message),
    paths: listFromData<Record<string, unknown>>(raw.paths).map(item => ({ path: readString(item.path), size: item.size === undefined ? undefined : readNumber(item.size) })),
  }
}

function normalizeDeletePreview(value: unknown): DeletePreview {
  const raw = asRecord(value)
  return {
    files: listFromData<unknown>(raw.files).map(normalizePreviewItem),
    protected: listFromData<unknown>(raw.protected).map(normalizePreviewItem),
  }
}

function normalizeUninstallPreview(value: unknown): UninstallPreview {
  const raw = asRecord(value)
  return {
    deleteItems: listFromData<unknown>(raw.deleteItems).map(normalizePreviewItem),
    userDataItems: listFromData<unknown>(raw.userDataItems).map(normalizePreviewItem),
    keepItems: listFromData<unknown>(raw.keepItems).map(normalizePreviewItem),
    warnings: listFromData<unknown>(raw.warnings).map(normalizePreviewItem),
  }
}

export default {
  name: 'DeployPanel',
  components: { SelectBox },
  props: { locked: { type: Boolean, default: false } },
  emits: ['unlocked'],
  setup() {
    const showAdminDialog = inject<ShowAdminDialog>('showAdminDialog')
    const mode = ref<DeployMode>('local')
    const local = reactive<LocalConfig>({ qq: '', provider: 'opencode', model: 'deepseek-v4-flash', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '' })
    const remote = reactive<RemoteConfig>({ server: '', appDir: '', mode: 'update' })
    const remoteModeOptions: SelectOption<RemoteMode>[] = [
      { value: 'install', label: '实验性首次安装' },
      { value: 'update', label: '更新已有部署' },
    ]
    const env = ref<EnvCheckData | null>(null)
    const localMsg = ref<MessageState | null>(null)
    const localAlert = ref('')
    const remoteMsg = ref<MessageState | null>(null)
    const logs = ref<string[]>([])
    const electronAppInfo = ref<ElectronAppInfo | null>(null)
    const napcatUrl = ref('')
    const napcatInstallDir = ref('')
    const deletePreview = ref<DeletePreview | null>(null)
    const uninstallPreview = ref<UninstallPreview | null>(null)
    const deleteUserDataKeys = ref<string[]>([])
    const uninstallConfirmed = ref(false)
    const deployLogRef = ref<HTMLPreElement | null>(null)
    const cookieInput = ref<HTMLInputElement | null>(null)
    const checking = ref(false)
    const installingNode = ref(false)
    const downloading = ref(false)
    const installingNapcat = ref(false)
    const localDeploying = ref(false)
    const previewingDelete = ref(false)
    const deletingConfig = ref(false)
    const previewingUninstall = ref(false)
    const uninstalling = ref(false)
    const autoDeploying = ref(false)
    const installingDeps = ref(false)
    const repairingNpm = ref(false)
    const startingNapcat = ref(false)
    const startingKoishi = ref(false)
    const checkingReady = ref(false)
    const activeLocalStep = ref('env')
    const localLogRef = ref<HTMLPreElement | null>(null)
    const npmTaskStatus = ref<DeployTaskStatus | null>(null)
    const npmGuideSteps = ref<NpmGuideStep[] | null>(null)
    const napcatTaskStatus = ref<DeployTaskStatus | null>(null)
    const koishiTaskStatus = ref<DeployTaskStatus | null>(null)
    const readyCheck = ref<ReadyCheck | null>(null)
    const savingRemote = ref(false)
    const deploying = ref(false)
    const rebuilding = ref(false)
    let progressTimer: ReturnType<typeof setInterval> | null = null
    let localStatusTimer: ReturnType<typeof setInterval> | null = null
    let localStatusLoading = false
    let localStatusPending = false
    let rebuildTimer: ReturnType<typeof setInterval> | null = null
    let rebuildTimeout: ReturnType<typeof setTimeout> | null = null

    const localFlowText = '环境检测 -> 安装 NapCat -> 生成配置 -> npm install -> 启动 NapCat -> 等待扫码 -> 启动 Koishi -> 健康检查'
    const localStepDefs: LocalStepDef[] = [
      { id: 'env', title: '环境检测', description: '确认当前 Windows 目标机、Node.js、npm、端口和项目目录。' },
      { id: 'install', title: '安装 NapCat', description: '下载并解压 NapCat 官方 Windows 包到 runtime/napcat 或你选择的目录。' },
      { id: 'config', title: '生成配置', description: '写入 koishi.yml、start-local.bat 和本地 AI 配置；AI Key 可留空。' },
      { id: 'npm', title: 'npm install', description: '手动在终端执行 npm install 安装项目依赖。' },
      { id: 'napcat-start', title: '启动 NapCat', description: '在当前 Windows 机器启动 NapCat，等待 WebUI 或二维码出现。' },
      { id: 'scan', title: '等待扫码', description: '使用机器人 QQ 扫码登录 NapCat，完成后继续启动 Koishi。' },
      { id: 'koishi', title: '启动 Koishi', description: '启动 Koishi 5140 服务，并连接 NapCat 的 OneBot WebSocket。' },
      { id: 'health', title: '健康检查', description: '检查 Node/npm、依赖、NapCat、OneBot、Koishi 和 AI Key 状态。' },
    ]
    const stationState = reactive<Record<LocalStepId, LocalStepStatus>>(Object.fromEntries(localStepDefs.map(step => [step.id, 'pending'])) as Record<LocalStepId, LocalStepStatus>)

    const deployerBridge = computed<DongxuelianDeployerBridge | null>(() => getDongxuelianDeployerBridge())
    const localDeployTarget = computed<LocalDeployTarget | null>(() => env.value?.localDeployTarget || null)
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
      ? '当前 Dashboard 后端机器就是 Windows 本地部署目标。便携版把环境、依赖、配置和日志放在 EXE 同级 LianLianBOT；安装版放在文档目录 LianLianBOT。NapCat 扫码登录后，Koishi 使用 127.0.0.1:8080 连接。'
      : '当前页面只能显示 Dashboard 后端机器状态。远端 Linux Dashboard 不能检测浏览器所在的 Windows 电脑；请打开 Windows 部署器软件后再执行本地部署。')
    const electronPathHint = computed(() => {
      const type = electronAppInfo.value?.distribution
      if (type === 'portable') return '便携版运行文件在 EXE 同级 LianLianBOT；程序资源目录只读。'
      if (type === 'installed') return '安装版程序目录和运行数据分开；运行数据在文档目录 LianLianBOT。'
      return '源码模式使用当前仓库目录。'
    })
    const electronPathRows = computed<ElectronPathRow[]>(() => {
      const info = electronAppInfo.value
      if (!info) return []
      return [
        { key: 'executableDir', label: '程序目录', path: info.executableDir },
        { key: 'resourceRoot', label: '资源目录', path: info.resourceRoot },
        { key: 'workspaceRoot', label: '工作目录', path: info.workspaceRoot },
        { key: 'logDir', label: '日志目录', path: info.logDir },
      ].filter((item): item is ElectronPathRow => !!item.path)
    })
    const workspaceSafe = computed(() => !(localDeployTarget.value?.workspace?.isTempRuntime))
    const workspaceStatusText = computed(() => {
      const workspace = localDeployTarget.value?.workspace
      if (!workspace) return ''
      if (workspace.packaged) return workspaceSafe.value ? 'LianLianBOT 工作目录' : '临时目录风险'
      return workspaceSafe.value ? '源码工作目录' : '临时目录风险'
    })
    const workspaceStatusHint = computed(() => {
      const workspace = localDeployTarget.value?.workspace
      if (!workspace) return ''
      const reasons = workspace.reasons || []
      if (reasons.length) return reasons.join('；')
      return workspace.packaged ? `工作目录：${workspace.workspaceRoot || env.value?.projectDir || ''}` : '源码模式使用当前仓库目录。'
    })
    const canChooseDirectory = computed(() => typeof deployerBridge.value?.selectDirectory === 'function')
    const deleteCandidates = computed<PreviewItem[]>(() => (deletePreview.value?.files || []).filter(item => item.action === 'delete'))
    const keptCandidates = computed<PreviewItem[]>(() => (deletePreview.value?.files || []).filter(item => item.action !== 'delete').concat(deletePreview.value?.protected || []))
    const previewRows = computed<PreviewItem[]>(() => (deletePreview.value ? [...(deletePreview.value.files || []), ...(deletePreview.value.protected || [])] : []))
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
      const ports: Record<string, PortInfo> = env.value?.ports || {}
      const labels: Record<string, string> = { free: '空闲', occupied: '占用', denied: '无权限', unknown: '未知', invalid: '无效' }
      return Object.keys(ports).map(port => {
        const info = ports[port]
        return `${port}:${labels[info.status || ''] || (info.available ? '空闲' : '占用')}`
      }).join('  ')
    })
    const wizardSteps = computed<WizardStep[]>(() => localStepDefs.map(step => ({ ...step, status: stationState[step.id] || 'pending' })))
    const activeStation = computed<WizardStep>(() => wizardSteps.value.find(step => step.id === activeLocalStep.value) || wizardSteps.value[0])
    const activeStationHint = computed(() => {
      const step = activeStation.value
      if (!step) return ''
      if (step.id === 'scan') return '扫码是唯一需要你手动完成的步骤。部署器会自动检测登录成功并继续启动 Koishi；超时后也可以手动继续。'
      if (step.id === 'health' && readyCheck.value) return readyCheck.value.message || step.description
      if (step.id === 'config') return '只要求填写机器人 QQ。AI Key 可以留空，之后在 API Keys 页补充。'
      if (step.id === 'npm') return '部署器会为你生成终端命令，请复制到 PowerShell 或 CMD 中执行。安装完成后点击确认按钮。'
      return step.description
    })
    const currentLocalLogLines = computed<string[]>(() => {
      if (activeLocalStep.value === 'npm') return npmTaskStatus.value?.logLines || []
      if (activeLocalStep.value === 'napcat-start' || activeLocalStep.value === 'scan') return napcatTaskStatus.value?.logLines || []
      if (activeLocalStep.value === 'koishi' || activeLocalStep.value === 'health') return koishiTaskStatus.value?.logLines || []
      return []
    })
    const npmFailureGuide = computed<NpmFailureGuide | null>(() => npmTaskStatus.value?.failureGuide || null)
    const npmGuideCommands = computed<string[]>(() => npmFailureGuide.value?.commands || [])
    const npmDiagnosticRows = computed<{ label: string; value: string }[]>(() => {
      const diag = npmFailureGuide.value?.diagnostics
      if (!diag) return []
      const envDiag = asRecord(diag.env)
      const configDiag = asRecord(diag.config)
      const proxyDiag = asRecord(diag.proxy)
      const repairDiag = asRecord(diag.repair)
      const toolsDiag = asRecord(diag.tools)
      const pathsDiag = asRecord(diag.paths)
      const staleProxy = listFromData<Record<string, unknown>>(proxyDiag.staleLoopback).map(item => `${readString(item.key)}:${readString(item.hostname)}:${readString(item.port)}`).join('、')
      const repairActions = listFromData<Record<string, unknown>>(repairDiag.actions).map(item => `${item.ok ? 'OK' : 'FAIL'} ${readString(item.command)}`).join('；')
      const rows = [
        ['HTTP_PROXY', envDiag.HTTP_PROXY],
        ['HTTPS_PROXY', envDiag.HTTPS_PROXY],
        ['ALL_PROXY', envDiag.ALL_PROXY],
        ['npm_config_proxy', envDiag.npm_config_proxy],
        ['npm_config_https_proxy', envDiag.npm_config_https_proxy],
        ['npm_config_all_proxy', envDiag.npm_config_all_proxy],
        ['NO_PROXY', envDiag.NO_PROXY],
        ['npm proxy', configDiag.proxy],
        ['npm https-proxy', configDiag.httpsProxy],
        ['npm registry', configDiag.registry],
        ['代理诊断', proxyDiag.reason || staleProxy],
        ['自动清理', repairDiag.envClearedForRetry ? (repairDiag.automatic ? '已自动执行' : '已手动执行') : '未执行'],
        ['清理动作', repairActions],
        ['npm path', toolsDiag.npmSourcePath],
        ['workdir', pathsDiag.projectDir],
      ]
      return rows.filter(([, value]) => value).map(([label, value]) => ({ label: readString(label), value: readString(value) }))
    })
    const uninstallDeleteItems = computed<PreviewItem[]>(() => uninstallPreview.value?.deleteItems || [])
    const uninstallUserDataItems = computed<PreviewItem[]>(() => uninstallPreview.value?.userDataItems || [])
    const uninstallKeepItems = computed<PreviewItem[]>(() => uninstallPreview.value?.keepItems || [])
    const uninstallWarnings = computed<PreviewItem[]>(() => uninstallPreview.value?.warnings || [])
    const uninstallBaseDeleteSize = computed(() => uninstallDeleteItems.value.reduce((sum, item) => sum + (item.size || 0), 0))
    const uninstallUserDataSize = computed(() => uninstallUserDataItems.value.reduce((sum, item) => sum + (item.size || 0), 0))
    const uninstallSelectedUserDataItems = computed<PreviewItem[]>(() => uninstallUserDataItems.value.filter(item => deleteUserDataKeys.value.includes(item.key || '')))
    const uninstallSelectedDeleteSize = computed(() => uninstallBaseDeleteSize.value + uninstallSelectedUserDataItems.value.reduce((sum, item) => sum + (item.size || 0), 0))
    const uninstallSelectedDeleteCount = computed(() => uninstallDeleteItems.value.length + uninstallSelectedUserDataItems.value.length)

    function withAdminRetry(res: ApiResult<unknown>, message: string, retry: AdminRetry): boolean {
      if (res?.code === 'ADMIN_REQUIRED') {
        if (showAdminDialog) showAdminDialog(message, async () => { await retry() })
        return true
      }
      return false
    }

    function showLocalAlert(text: string) {
      localAlert.value = text
    }

    function closeLocalAlert() {
      localAlert.value = ''
    }

    function validateLocalQQ(useAlert = false): boolean {
      if (/^\d+$/.test(local.qq.trim())) return true
      const text = '请先填入bot挂载的qq号'
      localMsg.value = { type: 'err', text }
      activeLocalStep.value = 'config'
      setStepStatus('config', 'failed')
      if (useAlert) showLocalAlert(text)
      return false
    }

    function shouldUsePortableNodeForWizard(): boolean {
      const packaged = isElectronDeployerEnv()
      if (!env.value?.node?.ok || !env.value?.npm?.found) return true
      return packaged && (!env.value?.node?.ownedByProject || !env.value?.npm?.ownedByProject)
    }

    function syncNapcatInstallDir(data: EnvCheckData | null) {
      if (!napcatInstallDir.value) napcatInstallDir.value = data?.napcat?.expectedPath || (data?.runtimeDir ? `${data.runtimeDir}\\napcat` : '')
    }

    /** 读取 Electron 部署器路径信息，用于排查安装版和便携版目录。 */
    async function loadElectronAppInfo() {
      const getter = deployerBridge.value?.getAppInfo
      if (typeof getter !== 'function') return
      try {
        electronAppInfo.value = dataRecord<ElectronAppInfo>(await getter())
      } catch {
        electronAppInfo.value = null
      }
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

    function stationStatusText(status: LocalStepStatus): string {
      const labels: Record<LocalStepStatus, string> = { pending: '未开始', running: '处理中', success: '已完成', waiting: '等待用户', failed: '失败', skipped: '已跳过' }
      return labels[status] || '未开始'
    }

    function setStepStatus(step: LocalStepId, status: LocalStepStatus) {
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
      if (npmStatus?.dependencies?.ready) setStepStatus('npm', 'success')
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
      if (localStatusLoading) {
        localStatusPending = true
        return
      }
      localStatusLoading = true
      try {
        if (!canRunWindowsLocalDeploy.value) {
          npmTaskStatus.value = null
          napcatTaskStatus.value = null
          koishiTaskStatus.value = null
          if (includeReady) readyCheck.value = null
          resetWizardSteps()
          return
        }
        const [npmRes, napcatRes, koishiRes] = await Promise.all([npmInstallStatus(), napcatDeployStatus(), koishiDeployStatus()])
        if (npmRes.ok) npmTaskStatus.value = dataRecord<{ status?: DeployTaskStatus }>(npmRes.data).status || null
        if (napcatRes.ok) napcatTaskStatus.value = dataRecord<{ status?: DeployTaskStatus }>(napcatRes.data).status || null
        if (koishiRes.ok) koishiTaskStatus.value = dataRecord<{ status?: DeployTaskStatus }>(koishiRes.data).status || null
        if (includeReady) {
          const readyRes = await localReadyCheck()
          if (readyRes.ok) readyCheck.value = dataRecord<ReadyCheck>(readyRes.data)
        }
        updateWizardFromSignals()
        scrollLocalLogToBottom()
      } finally {
        localStatusLoading = false
        if (localStatusPending) {
          localStatusPending = false
          refreshLocalTaskStatuses(includeReady)
        }
      }
    }

    function taskFailureText(step: LocalStepId, status: DeployTaskStatus | null, fallback?: string): string {
      const title = localStepDefs.find(item => item.id === step)?.title || step
      const logFile = status?.logFile ? `日志文件：${status.logFile}` : ''
      const tail = (status?.logLines || []).slice(-8).join('\n')
      return [fallback || `${title} 未完成`, logFile, tail ? `最后日志：\n${tail}` : ''].filter(Boolean).join('\n')
    }

    async function waitForLocalTask(fetcher: () => Promise<ApiResult<unknown>>, assign: (status: DeployTaskStatus) => void, step: LocalStepId, isDone: (status: DeployTaskStatus) => boolean): Promise<DeployTaskStatus> {
      let lastStatus: DeployTaskStatus | null = null
      for (let i = 0; i < 240; i += 1) {
        const res = await fetcher()
        if (res.ok) {
          const status = dataRecord<{ status?: DeployTaskStatus }>(res.data).status || {}
          assign(status)
          lastStatus = status
          updateWizardFromSignals()
          scrollLocalLogToBottom()
          if (isDone(status)) return status
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      setStepStatus(step, 'failed')
      throw new Error(taskFailureText(step, lastStatus, '等待步骤完成超时'))
    }

    async function waitForNapcatLogin(): Promise<boolean> {
      activeLocalStep.value = 'scan'
      setStepStatus('scan', 'waiting')
      localMsg.value = { type: 'ok', text: 'NapCat 已启动。请使用机器人 QQ 扫码登录，部署器会自动检测登录成功并继续。' }
      for (let i = 0; i < 240; i += 1) {
        const res = await napcatDeployStatus()
        if (res.ok) {
          const status = dataRecord<{ status?: DeployTaskStatus }>(res.data).status || {}
          napcatTaskStatus.value = status
          updateWizardFromSignals()
          scrollLocalLogToBottom()
          if (status.login?.status === 'ok') return true
          if (status.login?.status === 'failed') throw new Error(taskFailureText('scan', status, status.login.reason || 'NapCat 启动失败，请查看日志后重试'))
          if (status.state === 'failed' && !status.running) throw new Error(taskFailureText('scan', status, 'NapCat 进程已退出，请查看日志后重试'))
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
      return false
    }

    async function waitForNpmDependenciesReady(): Promise<boolean> {
      for (let i = 0; i < 30; i += 1) {
        const res = await npmInstallStatus()
        if (res.ok) {
          const status = dataRecord<{ status?: DeployTaskStatus }>(res.data).status || {}
          npmTaskStatus.value = status
          updateWizardFromSignals()
          scrollLocalLogToBottom()
          if (status.dependencies?.ready) return true
          if (status.state === 'failed') return false
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      return false
    }

    async function checkEnv() {
      checking.value = true
      localMsg.value = null
      await loadElectronAppInfo()
      setStepStatus('env', 'running')
      const res = await checkLocalEnv()
      if (res.ok) {
        const data = dataRecord<EnvCheckData>(res.data)
        env.value = data
        syncNapcatInstallDir(data)
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
        localMsg.value = { type: 'err', text: messageFromData(res.data, '环境检测失败') }
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
      if (!ensureWindowsLocalDeploy()) return false
      installingNapcat.value = true
      activeLocalStep.value = 'install'
      setStepStatus('install', 'running')
      localMsg.value = { type: 'ok', text: '正在下载 NapCat 官方 OneKey 包，并优先使用 tar.exe 解压，请稍等...' }
      const res = await downloadNapcatWindows(napcatInstallDir.value)
      if (withAdminRetry(res, '下载并安装 NapCat 需要管理员密码', doDownloadWindowsNapcat)) { installingNapcat.value = false; return false }
      const data = dataRecord<DeployActionData>(res.data)
      const manualSteps = data.manualSteps || []
      const messageText = [data.message || (res.ok ? 'NapCat OneKey 包已处理' : '安装失败')].concat(manualSteps.length ? ['手动处理步骤：', ...manualSteps.map((step, index) => `${index + 1}. ${step}`)] : []).join('\n')
      const success = res.ok && !data.needsManualSetup
      localMsg.value = { type: success ? 'ok' : 'err', text: messageText }
      setStepStatus('install', success ? 'success' : 'failed')
      installingNapcat.value = false
      if (success) await checkEnv()
      return success
    }

    async function installPortableNodeStep() {
      if (!ensureWindowsLocalDeploy()) return false
      installingNode.value = true
      activeLocalStep.value = 'env'
      setStepStatus('env', 'running')
      localMsg.value = { type: 'ok', text: '正在安装便携 Node/npm 到 runtime/node，请稍等...' }
      const res = await installPortableNode()
      if (withAdminRetry(res, '安装便携 Node/npm 需要管理员密码', installPortableNodeStep)) { installingNode.value = false; return false }
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: messageFromData(res.data, res.ok ? '便携 Node/npm 已安装' : '安装失败') }
      setStepStatus('env', res.ok ? 'success' : 'failed')
      installingNode.value = false
      if (res.ok) await checkEnv()
      return !!res.ok
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
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: messageFromData(res.data, res.ok ? 'NapCat 包已下载到 runtime/downloads' : '下载失败') }
      downloading.value = false
      if (res.ok) await checkEnv()
    }

    async function writeLocalConfig() {
      if (!ensureWindowsLocalDeploy()) return
      if (!validateLocalQQ(true)) return
      localDeploying.value = true
      activeLocalStep.value = 'config'
      setStepStatus('config', 'running')
      localMsg.value = null
      const res = await deployLocal({ ...local, qq: local.qq.trim() })
      if (withAdminRetry(res, '生成 Koishi 本地配置需要管理员密码', writeLocalConfig)) { localDeploying.value = false; return }
      const data = dataRecord<DeployActionData>(res.data)
      const files = data.files || []
      const changed = files.filter(item => item.action !== 'unchanged').length
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: data.message || (res.ok ? `Koishi 本地配置已生成，写入 ${changed} 个文件` : '生成失败') }
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
      localMsg.value = { type: 'ok', text: '正在获取安装指引...' }
      const res = await startNpmInstall()
      if (withAdminRetry(res, '获取 npm install 指引需要管理员密码', runNpmInstallStep)) { installingDeps.value = false; return }
      if (!res.ok) {
        setStepStatus('npm', 'failed')
        localMsg.value = { type: 'err', text: messageFromData(res.data, '获取安装指引失败') }
        installingDeps.value = false
        return
      }
      const data = dataRecord<DeployActionData>(res.data)
      if (data.status) npmTaskStatus.value = data.status
      if (data.skipped) {
        setStepStatus('npm', 'skipped')
        npmGuideSteps.value = null
        localMsg.value = { type: 'ok', text: '项目依赖已安装，无需再次执行。' }
        await checkEnv()
      } else if (data.guide) {
        npmGuideSteps.value = data.steps || []
        setStepStatus('npm', 'waiting')
        localMsg.value = { type: 'ok', text: data.message || '请在终端中手动执行命令安装依赖' }
      }
      installingDeps.value = false
    }

    async function confirmNpmDone() {
      if (!ensureWindowsLocalDeploy()) return
      installingDeps.value = true
      localMsg.value = { type: 'ok', text: '正在检测依赖安装状态...' }
      const ready = await waitForNpmDependenciesReady()
      if (ready) {
        setStepStatus('npm', 'success')
        npmGuideSteps.value = null
        localMsg.value = { type: 'ok', text: '项目依赖已安装完成。' }
        await checkEnv()
      } else {
        setStepStatus('npm', 'failed')
        localMsg.value = { type: 'err', text: '依赖未完整安装，请确认 npm install 是否执行成功后重试。' }
      }
      installingDeps.value = false
    }

    async function copyNpmGuideCommands() {
      const steps = npmGuideSteps.value || []
      const text = steps.map(s => s.command).filter(Boolean).join('\n')
      if (!text) return
      const bridge = getDongxuelianDeployerBridge?.()
      if (bridge?.copyText) {
        try { await bridge.copyText(text); localMsg.value = { type: 'ok', text: '安装命令已复制到剪贴板。' } }
        catch { localMsg.value = { type: 'err', text: '复制失败，请手动选择命令文本复制。' } }
        return
      }
      try { await navigator.clipboard?.writeText(text); localMsg.value = { type: 'ok', text: '安装命令已复制到剪贴板。' } }
      catch { localMsg.value = { type: 'err', text: '复制失败，请手动选择命令文本复制。' } }
    }

    async function repairNpmProxyFlow() {
      if (!ensureWindowsLocalDeploy()) return
      repairingNpm.value = true
      installingDeps.value = true
      activeLocalStep.value = 'npm'
      setStepStatus('npm', 'running')
      localMsg.value = { type: 'ok', text: '正在获取代理修复指引...' }
      const res = await repairNpmProxyAndInstall()
      if (withAdminRetry(res, '获取修复指引需要管理员密码', repairNpmProxyFlow)) { repairingNpm.value = false; installingDeps.value = false; return }
      if (!res.ok) {
        setStepStatus('npm', 'failed')
        localMsg.value = { type: 'err', text: messageFromData(res.data, 'npm 代理修复指引获取失败') }
        repairingNpm.value = false
        installingDeps.value = false
        return
      }
      const data = dataRecord<DeployActionData>(res.data)
      if (data.status) npmTaskStatus.value = data.status
      if (data.guide) {
        npmGuideSteps.value = data.steps || []
        setStepStatus('npm', 'waiting')
        localMsg.value = { type: 'ok', text: data.message || '请在终端中执行修复和安装命令' }
      }
      repairingNpm.value = false
      installingDeps.value = false
    }

    async function startNapcatStep() {
      if (!ensureWindowsLocalDeploy()) return
      startingNapcat.value = true
      activeLocalStep.value = 'napcat-start'
      setStepStatus('napcat-start', 'running')
      localMsg.value = { type: 'ok', text: '正在启动 NapCat。启动后请打开 WebUI 或查看控制台二维码扫码。' }
      const res = await startNapcat()
      if (withAdminRetry(res, '启动 NapCat 需要管理员密码', startNapcatStep)) { startingNapcat.value = false; return }
      const data = dataRecord<DeployActionData>(res.data)
      if (!res.ok) {
        setStepStatus('napcat-start', 'failed')
        localMsg.value = { type: 'err', text: taskFailureText('napcat-start', data.status || null, data.message || 'NapCat 启动失败') }
        startingNapcat.value = false
        return
      }
      if (data.status) napcatTaskStatus.value = data.status
      try {
        await waitForLocalTask(napcatDeployStatus, status => { napcatTaskStatus.value = status }, 'napcat-start', status => status.webuiPort?.status === 'occupied' || status.onebotPort?.status === 'occupied' || status.state === 'failed' || status.login?.status === 'failed')
        setStepStatus('napcat-start', (napcatTaskStatus.value?.webuiPort?.status === 'occupied' || napcatTaskStatus.value?.onebotPort?.status === 'occupied') ? 'success' : 'failed')
        setStepStatus('scan', napcatTaskStatus.value?.login?.status === 'ok' ? 'success' : 'waiting')
        activeLocalStep.value = 'scan'
        if (napcatTaskStatus.value?.login?.status === 'failed') throw new Error(taskFailureText('napcat-start', napcatTaskStatus.value, napcatTaskStatus.value.login.reason || 'NapCat 启动失败'))
        if (napcatTaskStatus.value?.state === 'failed' && !napcatTaskStatus.value?.running) throw new Error(taskFailureText('napcat-start', napcatTaskStatus.value, 'NapCat 启动失败'))
        localMsg.value = { type: 'ok', text: 'NapCat 已启动。请使用机器人 QQ 扫码登录，部署器会自动检测登录成功并继续。' }
      } catch (e) {
        setStepStatus('napcat-start', 'failed')
        localMsg.value = { type: 'err', text: errorMessage(e, 'NapCat 启动等待失败') }
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
      const data = dataRecord<DeployActionData>(res.data)
      if (!res.ok) {
        setStepStatus('koishi', 'failed')
        localMsg.value = { type: 'err', text: taskFailureText('koishi', data.status || null, data.message || 'Koishi 启动失败') }
        startingKoishi.value = false
        return
      }
      if (data.status) koishiTaskStatus.value = data.status
      try {
        await waitForLocalTask(koishiDeployStatus, status => { koishiTaskStatus.value = status }, 'koishi', status => status.port?.status === 'occupied' || status.state === 'failed')
        setStepStatus('koishi', koishiTaskStatus.value?.port?.status === 'occupied' ? 'success' : 'failed')
        if (koishiTaskStatus.value?.state === 'failed' && koishiTaskStatus.value?.port?.status !== 'occupied') throw new Error(taskFailureText('koishi', koishiTaskStatus.value, 'Koishi 启动失败'))
      } catch (e) {
        setStepStatus('koishi', 'failed')
        localMsg.value = { type: 'err', text: errorMessage(e, 'Koishi 启动等待失败') }
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
        const data = dataRecord<ReadyCheck>(res.data)
        readyCheck.value = data
        setStepStatus('health', data.basicReady ? 'success' : 'failed')
        localMsg.value = { type: data.basicReady ? 'ok' : 'err', text: data.message || '健康检查完成' }
      } else {
        setStepStatus('health', 'failed')
        localMsg.value = { type: 'err', text: messageFromData(res.data, '健康检查失败') }
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
      if (!validateLocalQQ(true)) return
      autoDeploying.value = true
      localMsg.value = null
      try {
        await checkEnv()
        if (!ensureWindowsLocalDeploy()) throw new Error(localDeployBlockedReason.value)
        if (shouldUsePortableNodeForWizard()) {
          if (!await installPortableNodeStep()) throw new Error('部署器便携 Node/npm 安装失败，请查看上方错误后重试')
          if (shouldUsePortableNodeForWizard()) throw new Error('部署器便携 Node/npm 未就绪，请先安装便携 Node/npm 后重新检测')
        }
        if (!env.value?.napcat?.found) {
          if (!await doDownloadWindowsNapcat()) throw new Error('NapCat 未安装完成，请检查安装日志后重试')
          if (!env.value?.napcat?.found) throw new Error('NapCat 未安装完成，请检查安装日志后重试')
        }
        await writeLocalConfig()
        if (!localConfigReady.value) throw new Error('Koishi 本地配置未生成，请检查机器人 QQ 和管理员验证')
        await runNpmInstallStep()
        if (!env.value?.dependencies?.ready) {
          localMsg.value = { type: 'ok', text: '请在终端中完成 npm install 后，点击"我已在终端执行完成"按钮继续。一键部署已暂停在此步骤。' }
          return
        }
        await startNapcatStep()
        const loginOk = await waitForNapcatLogin()
        if (loginOk) await continueAfterScan()
        else localMsg.value = { type: 'ok', text: 'NapCat 已启动，但还没有检测到扫码成功。请完成扫码后点击“我已扫码，继续”。' }
      } catch (e) {
        localMsg.value = { type: 'err', text: errorMessage(e, '本地部署流程中断') }
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
      if (res.ok) deletePreview.value = normalizeDeletePreview(res.data)
      else localMsg.value = { type: 'err', text: messageFromData(res.data, '读取删除预览失败') }
      previewingDelete.value = false
    }

    async function confirmDeleteConfig() {
      if (!ensureWindowsLocalDeploy()) return
      if (!deleteCandidates.value.length) return
      deletingConfig.value = true
      localMsg.value = null
      const res = await deleteLocalConfig()
      if (withAdminRetry(res, '删除 Koishi 配置需要管理员密码', confirmDeleteConfig)) { deletingConfig.value = false; return }
      const data = dataRecord<DeployActionData>(res.data)
      const deleted = data.deleted?.length || 0
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: data.message || (res.ok ? `已删除 ${deleted} 个配置文件` : '删除失败') }
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
        uninstallPreview.value = normalizeUninstallPreview(res.data)
        deleteUserDataKeys.value = []
        uninstallConfirmed.value = false
      } else {
        localMsg.value = { type: 'err', text: messageFromData(res.data, '读取卸载预览失败') }
      }
      previewingUninstall.value = false
    }

    function closeUninstallPreview() {
      if (uninstalling.value) return
      uninstallPreview.value = null
      deleteUserDataKeys.value = []
      uninstallConfirmed.value = false
    }

    function shouldKeepUserData(item: PreviewItem): boolean {
      return !deleteUserDataKeys.value.includes(item.key)
    }

    function setUserDataKeep(item: PreviewItem, keep: boolean) {
      const keys = new Set(deleteUserDataKeys.value)
      if (keep) keys.delete(item.key)
      else keys.add(item.key)
      deleteUserDataKeys.value = [...keys]
    }

    function onUserDataKeepChange(item: PreviewItem, event: Event) {
      const input = event.target instanceof HTMLInputElement ? event.target : null
      setUserDataKeep(item, !!input?.checked)
    }

    function setAllUserDataKeep(keep: boolean) {
      deleteUserDataKeys.value = keep ? [] : uninstallUserDataItems.value.map(item => item.key)
    }

    function formatUninstallPaths(item: PreviewItem): string {
      const paths = item.paths || []
      if (!paths.length) return ''
      if (paths.length === 1) return paths[0].path || ''
      return `${paths[0].path} 等 ${paths.length} 项`
    }

    async function confirmLocalUninstallFlow() {
      if (!ensureWindowsLocalDeploy()) return
      if (!uninstallConfirmed.value) return
      uninstalling.value = true
      localMsg.value = null
      const res = await confirmLocalUninstall({ deleteUserDataKeys: deleteUserDataKeys.value })
      if (withAdminRetry(res, '一键卸载需要管理员密码', confirmLocalUninstallFlow)) { uninstalling.value = false; return }
      const data = dataRecord<DeployActionData>(res.data)
      const deleted = data.deleted?.length || 0
      localMsg.value = { type: res.ok ? 'ok' : 'err', text: data.message || (res.ok ? `一键卸载完成，删除 ${deleted} 项` : '一键卸载失败') }
      uninstalling.value = false
      uninstallPreview.value = null
      deleteUserDataKeys.value = []
      uninstallConfirmed.value = false
      await checkEnv()
    }

    async function loadRemoteConfig() {
      const res = await fetchDeployConfig()
      if (res.ok) {
        const data = dataRecord<Partial<RemoteConfig>>(res.data)
        remote.server = data.server || remote.server
        remote.appDir = data.appDir || remote.appDir
        remoteMsg.value = { type: 'ok', text: '已读取部署配置' }
      } else {
        remoteMsg.value = { type: 'err', text: '读取配置失败' }
      }
    }

    async function saveRemoteConfig() {
      savingRemote.value = true
      const res = await updateDeployConfig(remote)
      if (withAdminRetry(res, '保存部署配置需要管理员密码', saveRemoteConfig)) { savingRemote.value = false; return }
      remoteMsg.value = { type: res.ok ? 'ok' : 'err', text: messageFromData(res.data, res.ok ? '配置已保存' : '保存失败') }
      savingRemote.value = false
    }

    async function checkRemoteUpdate() {
      const res = await checkDeployUpdate()
      const data = dataRecord<DeployUpdateData>(res.data)
      if (res.ok) remoteMsg.value = { type: 'ok', text: data.upToDate ? '远程记录已是最新版本' : `本地 ${data.local}，远程 ${data.deployed || '未记录'}` }
      else remoteMsg.value = { type: 'err', text: '检查更新失败' }
    }

    function clearRebuildPolling() {
      if (rebuildTimer) clearInterval(rebuildTimer)
      if (rebuildTimeout) clearTimeout(rebuildTimeout)
      rebuildTimer = null
      rebuildTimeout = null
    }

    async function doRebuildFrontend() {
      clearRebuildPolling()
      rebuilding.value = true; remoteMsg.value = null
      const res = await rebuildFrontend()
      if (withAdminRetry(res, '重建前端需要管理员密码', doRebuildFrontend)) { rebuilding.value = false; return }
      if (!res.ok) { remoteMsg.value = { type: 'err', text: messageFromData(res.data, '启动失败') }; rebuilding.value = false; return }
      remoteMsg.value = { type: 'ok', text: '前端构建中...' }
      rebuildTimer = setInterval(async () => {
        const sr = await rebuildFrontendStatus()
        if (sr.ok) {
          const data = dataRecord<RebuildStatusData>(sr.data)
          if (data.state === 'success') {
            clearRebuildPolling(); rebuilding.value = false
            remoteMsg.value = { type: 'ok', text: '前端构建成功，请刷新页面' }
          } else if (data.state === 'failed') {
            clearRebuildPolling(); rebuilding.value = false
            remoteMsg.value = { type: 'err', text: (data.message || '构建失败') + (data.detail ? '：' + data.detail : '') }
          }
        }
      }, 2000)
      rebuildTimeout = setTimeout(() => { clearRebuildPolling(); if (rebuilding.value) { rebuilding.value = false; remoteMsg.value = { type: 'err', text: '构建超时' } } }, 150000)
    }

    async function startRemoteDeploy() {
      deploying.value = true
      logs.value = []
      const res = await runDeploy(remote)
      if (withAdminRetry(res, '执行远程部署需要管理员密码', startRemoteDeploy)) { deploying.value = false; return }
      const data = dataRecord<DeployRunData>(res.data)
      if (!res.ok || !data.taskId) {
        remoteMsg.value = { type: 'err', text: data.message || '启动部署失败' }
        deploying.value = false
        return
      }
      pollProgress(data.taskId)
    }

    function pollProgress(taskId: string) {
      if (progressTimer) clearInterval(progressTimer)
      progressTimer = setInterval(async () => {
        const res = await getDeployProgress(taskId)
        if (!res.ok) return
        const data = dataRecord<DeployProgressData>(res.data)
        logs.value = data.lines || []
        if (data.done) {
          if (progressTimer) clearInterval(progressTimer)
          progressTimer = null
          deploying.value = false
          remoteMsg.value = { type: data.success ? 'ok' : 'err', text: data.success ? '部署完成' : '部署失败，请查看日志' }
          if (data.success) {
            const confirm = await confirmDeploy()
            if (!confirm.ok) remoteMsg.value = { type: 'err', text: '部署成功，但版本记录写入失败' }
          }
        }
      }, 1500)
    }

    function uploadCookie(event: Event) {
      const input = event.target instanceof HTMLInputElement ? event.target : null
      const file = input?.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = String(reader.result || '').split(',')[1]
        const res = await uploadDeploy('bilibili-cookies.txt', base64)
        if (withAdminRetry(res, '上传 cookies 需要管理员密码', () => uploadCookie(event))) return
        remoteMsg.value = { type: res.ok ? 'ok' : 'err', text: messageFromData(res.data, res.ok ? 'cookies 已上传' : '上传失败') }
      }
      reader.readAsDataURL(file)
    }

    function formatSize(size: unknown): string {
      const value = readNumber(size)
      if (!value) return '0 B'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function formatPreviewAction(action: string): string {
      const labels: Record<string, string> = { delete: '删除', keep: '保留', missing: '缺失', error: '错误' }
      return labels[action] || action
    }

    async function copyNpmFixCommands() {
      const text = npmGuideCommands.value.join('\n')
      if (!text) return
      const bridge = getDongxuelianDeployerBridge?.()
      if (bridge?.copyText) {
        try {
          await bridge.copyText(text)
          localMsg.value = { type: 'ok', text: '部署器 npm 命令已复制。命令包含实际 npm 路径；执行后可点击“执行 npm install”，也可以直接点“查看代理修复命令”。' }
        } catch {
          localMsg.value = { type: 'err', text: '复制失败，请手动选择命令文本复制。' }
        }
        return
      }
      try {
        await navigator.clipboard?.writeText(text)
        localMsg.value = { type: 'ok', text: '部署器 npm 命令已复制。命令包含实际 npm 路径；执行后可点击“执行 npm install”，也可以直接点“查看代理修复命令”。' }
      } catch {
        localMsg.value = { type: 'err', text: '复制失败，请手动选择命令文本复制。' }
      }
    }

    /** 打开部署器暴露的安全目录。 */
    async function openElectronPath(targetPath: string) {
      const value = String(targetPath || '').trim()
      if (!value) return
      const bridge = deployerBridge.value
      try {
        const opener = bridge?.openPath || bridge?.showItemInFolder
        const result = typeof opener === 'function' ? await opener(value) : ''
        if (result && result !== 'ok') localMsg.value = { type: 'err', text: `打开失败：${result}` }
      } catch {
        localMsg.value = { type: 'err', text: '打开路径失败，请手动复制路径后查看。' }
      }
    }

    /** 复制部署器路径，方便用户手动定位日志或工作目录。 */
    async function copyElectronPath(targetPath: string) {
      const value = String(targetPath || '').trim()
      if (!value) return
      try {
        if (deployerBridge.value?.copyText) await deployerBridge.value.copyText(value)
        else await navigator.clipboard?.writeText(value)
        localMsg.value = { type: 'ok', text: '路径已复制。' }
      } catch {
        localMsg.value = { type: 'err', text: '复制失败，请手动选择路径文本复制。' }
      }
    }

    watch(logs, scrollDeployLogToBottom)
    watch(currentLocalLogLines, scrollLocalLogToBottom)
    watch(mode, value => {
      if (value === 'remote') scrollDeployLogToBottom()
      if (value === 'local' && canRunWindowsLocalDeploy.value) refreshLocalTaskStatuses(false)
    })

    onMounted(() => {
      loadElectronAppInfo().catch(() => { /* non-critical: deployer path info is optional */ })
      checkEnv().catch(() => { /* non-critical: panel still renders manual actions when env probe fails */ })
      loadRemoteConfig().catch(() => { /* non-critical: user can fill remote config manually */ })
      localStatusTimer = setInterval(() => {
        if (mode.value === 'local' && canRunWindowsLocalDeploy.value) refreshLocalTaskStatuses(false)
      }, 3500)
      scrollDeployLogToBottom()
    })
    onActivated(scrollDeployLogToBottom)
    onUnmounted(() => {
      if (progressTimer) clearInterval(progressTimer)
      if (localStatusTimer) clearInterval(localStatusTimer)
      clearRebuildPolling()
    })

    return { mode, local, remote, remoteModeOptions, env, electronAppInfo, electronPathRows, electronPathHint, localMsg, localAlert, remoteMsg, logs, napcatUrl, napcatInstallDir, deletePreview, uninstallPreview, deployLogRef, localLogRef, cookieInput, checking, installingNode, downloading, installingNapcat, localDeploying, previewingDelete, deletingConfig, previewingUninstall, uninstalling, uninstallConfirmed, autoDeploying, installingDeps, repairingNpm, startingNapcat, startingKoishi, checkingReady, activeLocalStep, localFlowText, wizardSteps, activeStation, activeStationHint, currentLocalLogLines, npmGuideSteps, npmFailureGuide, npmGuideCommands, npmDiagnosticRows, readyCheck, savingRemote, deploying, rebuilding, isWindows, canRunWindowsLocalDeploy, localDeployBlocked, localDeployBlockedReason, localDeployTargetSummary, localDeployDescription, workspaceSafe, workspaceStatusText, workspaceStatusHint, canChooseDirectory, deleteCandidates, keptCandidates, previewRows, localConfigReady, localConfigSummary, napcatStatusText, napcatStatusClass, portSummary, uninstallDeleteItems, uninstallUserDataItems, uninstallKeepItems, uninstallWarnings, uninstallBaseDeleteSize, uninstallUserDataSize, uninstallSelectedDeleteSize, uninstallSelectedDeleteCount, stationStatusText, closeLocalAlert, checkEnv, chooseNapcatDir, installPortableNodeStep, doDownloadWindowsNapcat, doDownloadNapcat, writeLocalConfig, runNpmInstallStep, confirmNpmDone, copyNpmGuideCommands, repairNpmProxyFlow, startNapcatStep, continueAfterScan, startKoishiStep, runReadyCheckStep, openNapcatWebui, runLocalWizard, previewDeleteConfig, confirmDeleteConfig, previewLocalUninstallFlow, closeUninstallPreview, shouldKeepUserData, setUserDataKeep, onUserDataKeepChange, setAllUserDataKeep, formatUninstallPaths, confirmLocalUninstallFlow, loadRemoteConfig, saveRemoteConfig, checkRemoteUpdate, startRemoteDeploy, doRebuildFrontend, uploadCookie, formatSize, formatPreviewAction, copyNpmFixCommands, openElectronPath, copyElectronPath }
  },
}
</script>
