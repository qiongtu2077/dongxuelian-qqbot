'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const { json, collectBody, log, shellQuote, isInsidePath, copyRecursiveSync, getOptionalErrorMessage: getLegacyErrorMessage, } = require('../utils');
const { KOISHI_DIR, DATA_DIR, PLUGIN_ROOT, FE_DIR, DIST_DIR, LOCAL_DEPLOY_MANIFEST_FILE, LOCAL_NAPCAT_DIR_FILE, PORT, toProjectRel } = require('../paths');
const { requireAdmin } = require('../auth');
const { getCommandInfo, getLocalToolCommand, checkPortState } = require('../tools');
const { detectNapcatInstallation, resolveNapcatWebuiListenPort, resolveNapcatOnebotListenPort } = require('../napcat');
const { buildFrontendDist } = require('../frontend');
const { localTasks, getTaskPublicStatus, spawnLocalTask, getRebuildStatus, setRebuildStatus } = require('../deploy-state');
const { readLastLogLines } = require('../logging');
const dh = require('../deploy-helpers');
const remoteRelease = require('../remote-release');
const DEPLOY_CONFIG_FILE = path.join(DATA_DIR, 'deploy-config.json');
const DEPLOY_TASKS_DIR = path.join(DATA_DIR, 'deploy-tasks');
const DEFAULT_REMOTE_APP_DIR = process.env.DASHBOARD_REMOTE_APP_DIR || process.env.KOISHI_REMOTE_APP_DIR || '';
const REMOTE_DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;
const LOCAL_RELEASES_DIR = path.join(DATA_DIR, 'deploy-releases');
const DEPLOY_PREVIEWS_DIR = path.join(DATA_DIR, 'deploy-previews');
// --- Remote deployment task state ---
// Removes common credential assignments before a deployment error reaches logs or the browser.
function sanitizeDeployError(error) {
    return String(getLegacyErrorMessage(error) || error || '未知错误')
        .replace(/\b(password|token|api[_-]?key|secret)\s*[=:]\s*[^\s]+/gi, '$1=[REDACTED]')
        .slice(0, 2000);
}
// Returns the durable state-file path for one validated deployment task ID.
function deployTaskStateFile(taskId) {
    return path.join(DEPLOY_TASKS_DIR, taskId + '.json');
}
// Persists one deployment task state with an atomic same-directory replacement.
function writeRemoteDeployTask(task) {
    fs.mkdirSync(DEPLOY_TASKS_DIR, { recursive: true });
    const target = deployTaskStateFile(task.taskId);
    const next = target + '.tmp';
    fs.writeFileSync(next, JSON.stringify(task, null, 2), 'utf8');
    fs.renameSync(next, target);
}
// 把不中断发布的次要写入失败保存到任务状态并写入结构化日志。
function recordRemoteDeployWarning(task, code, error) {
    const detail = sanitizeDeployError(error);
    const warning = `${code}: ${detail}`.slice(0, 500);
    const warnings = Array.isArray(task.warnings) ? task.warnings : [];
    if (!warnings.includes(warning))
        task.warnings = warnings.concat(warning).slice(-20);
    log(`remote_deploy_warning taskId=${task.taskId} code=${code} detail=${detail}`);
    writeRemoteDeployTask(task);
}
// Creates the initial running state and its server-enforced deadline.
function createRemoteDeployTask(taskId) {
    const now = Date.now();
    const task = { taskId, state: 'running', stage: 'queued', error: '', warnings: [], startedAt: now, updatedAt: now, finishedAt: 0, expiresAt: now + REMOTE_DEPLOY_TIMEOUT_MS };
    writeRemoteDeployTask(task);
    return task;
}
// Updates the current non-sensitive deployment stage.
function setRemoteDeployStage(task, stage) {
    if (task.state !== 'running')
        return;
    task.stage = String(stage || 'running').slice(0, 120);
    task.updatedAt = Date.now();
    writeRemoteDeployTask(task);
}
// Moves the task into a terminal success or failed state exactly once.
function finishRemoteDeployTask(task, state, stage, error = '') {
    if (task.state !== 'running')
        return;
    task.state = state;
    task.stage = stage;
    task.error = state === 'failed' ? sanitizeDeployError(error) : '';
    task.updatedAt = Date.now();
    task.finishedAt = task.updatedAt;
    writeRemoteDeployTask(task);
}
// Reads a durable task and converts an expired running task into a failed terminal state.
function readRemoteDeployTask(taskId) {
    try {
        const task = JSON.parse(fs.readFileSync(deployTaskStateFile(taskId), 'utf8'));
        if (task.state === 'running' && Date.now() >= task.expiresAt)
            finishRemoteDeployTask(task, 'failed', 'timeout', '远程部署超过服务端 30 分钟期限');
        return task;
    }
    catch {
        return null;
    }
}
// Records exact immutable release identity after target-side activation succeeds.
function writeSuccessfulReleaseRecord(task) {
    let cfg = {};
    try {
        cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'));
    }
    catch { /* missing config is recreated from the task */ }
    Object.assign(cfg, {
        server: task.server,
        appDir: task.appDir,
        mode: 'update',
        deployedAt: Date.now(),
        releaseId: task.releaseId,
        releaseCommit: task.commit,
        releaseManifestHash: task.manifestHash,
        releaseContentHash: task.contentHash,
    });
    delete cfg.deployFingerprint;
    const next = DEPLOY_CONFIG_FILE + '.tmp';
    fs.mkdirSync(path.dirname(DEPLOY_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(next, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(next, DEPLOY_CONFIG_FILE);
}
// Pulls the detached target-side activation result into the local durable task state.
function refreshRemoteDeployTask(task) {
    if (task.state !== 'running' || !task.server || !task.appDir)
        return;
    try {
        const resultFile = dh.remoteJoin(task.appDir, 'data', 'deploy-tasks', task.taskId + '.remote.json');
        const output = execSync(dh.sshCommand(task.server, `test -f ${shellQuote(resultFile)} && cat ${shellQuote(resultFile)}`), { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
        const result = JSON.parse(String(output || '{}'));
        task.stage = String(result.stage || task.stage);
        task.updatedAt = Date.now();
        task.rolledBack = !!result.rolledBack;
        if (result.rollbackState)
            task.rollbackState = result.rollbackState;
        if (result.releaseId)
            task.releaseId = result.releaseId;
        if (result.manifestHash)
            task.manifestHash = result.manifestHash;
        if (result.contentHash)
            task.contentHash = result.contentHash;
        if (result.state === 'success') {
            writeSuccessfulReleaseRecord(task);
            finishRemoteDeployTask(task, 'success', task.stage);
        }
        else if (result.state === 'failed') {
            finishRemoteDeployTask(task, 'failed', task.stage, result.error || '目标服务器发布失败');
        }
        else {
            writeRemoteDeployTask(task);
        }
    }
    catch {
        // A transient SSH/read failure must not overwrite the server-side task state.
    }
}
// Runs local build/upload/bootstrap commands sequentially and records an exact failed stage.
function runSafeDeployCommands(task, commands, onComplete) {
    let index = 0;
    const runNext = () => {
        if (index >= commands.length)
            return onComplete();
        const current = commands[index];
        setRemoteDeployStage(task, current.stage);
        exec(current.command, { cwd: path.join(PLUGIN_ROOT, '..', '..'), timeout: current.timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (stdout)
                try {
                    fs.appendFileSync(path.join(DEPLOY_TASKS_DIR, task.taskId + '.log'), stdout.trim() + '\n', 'utf8');
                }
                catch (logError) {
                    recordRemoteDeployWarning(task, 'stdout_log_write_failed', logError);
                }
            if (stderr)
                try {
                    fs.appendFileSync(path.join(DEPLOY_TASKS_DIR, task.taskId + '.log'), stderr.trim() + '\n', 'utf8');
                }
                catch (logError) {
                    recordRemoteDeployWarning(task, 'stderr_log_write_failed', logError);
                }
            if (error)
                return finishRemoteDeployTask(task, 'failed', current.stage, error);
            index += 1;
            runNext();
        });
    };
    runNext();
}
function requireStrictAdmin(req, res) {
    const { isLocalAuthBypass, validateAdminToken } = require('../auth');
    if (isLocalAuthBypass(req))
        return true;
    const token = String(req.headers['x-admin-token'] || '').trim();
    if (!token || !validateAdminToken(token)) {
        json(res, { ok: false, message: '需要管理员密码验证', code: 'ADMIN_REQUIRED' }, 403);
        return false;
    }
    return true;
}
function stopKoishiProcesses() {
    const { stopKoishiProcesses: doStop } = require('./bot');
    return doStop();
}
function handleGetDeployConfig(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        const cfg = JSON.parse(fs.readFileSync(DEPLOY_CONFIG_FILE, 'utf8'));
        let botRunning = false;
        try {
            execSync('ss -tlnp | grep -q :5140', { stdio: 'ignore' });
            botRunning = true;
        }
        catch { /* non-critical: port probe fallback */ }
        return json(res, { ...cfg, botRunning });
    }
    catch {
        return json(res, { server: '', appDir: DEFAULT_REMOTE_APP_DIR, botRunning: false });
    }
}
// Builds and returns one frozen, read-only deployment preview for an administrator.
function handlePostDeployPreview(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const input = JSON.parse(body);
            const cfg = dh.validateDeployTarget(input);
            if (cfg.mode === 'install')
                return json(res, { ok: false, message: '首次安装请使用 setup.sh 或本地部署器；Web 远程发布只更新已有部署' }, 400);
            const preview = remoteRelease.createRemoteReleasePreview({ repoRoot: path.join(PLUGIN_ROOT, '..', '..'), releasesRoot: LOCAL_RELEASES_DIR, previewsDir: DEPLOY_PREVIEWS_DIR, server: cfg.server, appDir: cfg.appDir });
            return json(res, remoteRelease.toPublicRemoteReleasePreview(preview));
        }
        catch (error) {
            return json(res, { ok: false, message: sanitizeDeployError(error) }, 400);
        }
    });
}
function handlePutDeployConfig(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const cfg = dh.validateDeployTarget(JSON.parse(body));
            const tmp = DEPLOY_CONFIG_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
            fs.renameSync(tmp, DEPLOY_CONFIG_FILE);
            json(res, { ok: true, message: '配置已保存' });
        }
        catch (e) {
            json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
// Uploads one already-frozen preview release and starts detached target activation.
function handlePostSafeDeployRun(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const input = JSON.parse(body);
            const repoRoot = path.join(PLUGIN_ROOT, '..', '..');
            const preview = remoteRelease.validateRemoteReleasePreview({ repoRoot, releasesRoot: LOCAL_RELEASES_DIR, previewsDir: DEPLOY_PREVIEWS_DIR, previewId: input.previewId, confirmed: input.confirmed });
            const release = preview.release;
            if (!release || !preview.target.release)
                throw new Error('部署预览没有完整的冻结发布物或远端基线');
            const taskId = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
            const task = createRemoteDeployTask(taskId);
            task.server = preview.target.server;
            task.appDir = preview.target.requestedAppDir;
            task.previewId = preview.previewId;
            task.releaseId = release.releaseId;
            task.commit = release.commit;
            task.manifestHash = release.manifestHash;
            task.contentHash = release.contentHash;
            task.baselineManifestHash = preview.target.release.manifestHash;
            writeRemoteDeployTask(task);
            fs.writeFileSync(path.join(DEPLOY_TASKS_DIR, taskId + '.log'), `使用已确认预览 ${preview.previewId} 的冻结发布物\n`, 'utf8');
            json(res, { ok: true, taskId });
            const remoteReleaseRoot = dh.remoteJoin(task.appDir, '.lian-releases');
            const remoteNext = dh.remoteJoin(remoteReleaseRoot, release.releaseId + '.next');
            const remoteResult = dh.remoteJoin(task.appDir, 'data', 'deploy-tasks', taskId + '.remote.json');
            const unitName = 'lian-release-' + release.releaseId.replace(/[^a-z0-9-]/g, '-');
            const commands = [
                { stage: 'prepare_remote_version', command: dh.sshCommand(task.server, `mkdir -p ${shellQuote(remoteReleaseRoot)} ${shellQuote(path.dirname(remoteResult))} && rm -rf ${shellQuote(remoteNext)}`), timeout: 30000 },
                { stage: 'upload_release', command: dh.scpCommand(release.releaseDir, dh.scpRemoteTarget(task.server, remoteNext), { recursive: true }), timeout: 10 * 60 * 1000 },
                { stage: 'verify_remote_manifest', command: dh.sshCommand(task.server, `node ${shellQuote(dh.remoteJoin(remoteNext, 'scripts', 'verify-release-manifest.js'))} ${shellQuote(remoteNext)}`), timeout: 3 * 60 * 1000 },
                { stage: 'start_detached_activation', command: dh.sshCommand(task.server, `systemd-run --unit=${shellQuote(unitName)} --collect --quiet --property=Type=oneshot --property=TimeoutStartSec=1800 /bin/bash ${shellQuote(dh.remoteJoin(remoteNext, 'scripts', 'activate-dashboard-release.sh'))} ${shellQuote(task.appDir)} ${shellQuote(release.releaseId)} ${shellQuote(remoteResult)} ${shellQuote(task.baselineManifestHash)}`), timeout: 30000 },
            ];
            runSafeDeployCommands(task, commands, () => {
                setRemoteDeployStage(task, 'target_activation');
                try {
                    fs.appendFileSync(path.join(DEPLOY_TASKS_DIR, taskId + '.log'), '目标服务器已启动独立发布单元，等待切换、重启和健康检查\n', 'utf8');
                }
                catch (logError) {
                    recordRemoteDeployWarning(task, 'activation_log_write_failed', logError);
                }
            });
        }
        catch (error) {
            json(res, { ok: false, message: sanitizeDeployError(error) }, 400);
        }
    });
}
function handleGetDeployProgress(req, res, pathname) {
    if (!requireAdmin(req, res))
        return;
    const taskId = pathname.split('/').pop();
    if (!taskId || !/^[a-z0-9]+$/.test(taskId))
        return json(res, { ok: false, message: '无效 taskId' }, 400);
    try {
        const logFile = path.join(DEPLOY_TASKS_DIR, taskId + '.log');
        const task = readRemoteDeployTask(taskId);
        if (!task || !fs.existsSync(logFile))
            return json(res, { ok: false, message: '部署任务不存在', code: 'DEPLOY_TASK_NOT_FOUND' }, 404);
        refreshRemoteDeployTask(task);
        const stat = fs.statSync(logFile);
        const start = Math.max(0, stat.size - dh.MAX_DEPLOY_TASK_LOG_BYTES);
        const fd = fs.openSync(logFile, 'r');
        const buffer = Buffer.alloc(stat.size - start);
        try {
            fs.readSync(fd, buffer, 0, buffer.length, start);
        }
        finally {
            fs.closeSync(fd);
        }
        const raw = buffer.toString('utf8').trim();
        const lines = raw ? raw.split('\n') : [];
        return json(res, { ok: true, lines, state: task.state, stage: task.stage, error: task.error, warnings: task.warnings || [], rolledBack: task.rolledBack, rollbackState: task.rollbackState, previewId: task.previewId, releaseId: task.releaseId, startedAt: task.startedAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt, expiresAt: task.expiresAt });
    }
    catch (error) {
        return json(res, { ok: false, message: sanitizeDeployError(error), code: 'DEPLOY_PROGRESS_READ_FAILED' }, 500);
    }
}
function handlePostFrontendRebuild(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (getRebuildStatus().state === 'building')
        return json(res, { ok: false, message: '正在构建中，请等待完成' });
    const started = buildFrontendDist({ log: msg => log('frontend rebuild: ' + msg), updateStatus: status => setRebuildStatus(status) }, (err) => { if (err)
        log('frontend rebuild failed: ' + err.message); });
    if (!started)
        return json(res, { ok: false, message: getRebuildStatus().detail || '前端构建启动失败' }, 500);
    return json(res, { ok: true, message: '前端构建已启动' });
}
function handleGetFrontendRebuildStatus(req, res) { return json(res, getRebuildStatus()); }
function handlePostDeployUpload(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { name, data } = JSON.parse(body);
            if (!name || !data)
                return json(res, { ok: false, message: '文件名或内容为空' }, 400);
            if (name !== 'bilibili-cookies.txt')
                return json(res, { ok: false, message: 'only bilibili-cookies.txt can be uploaded here' }, 400);
            const filePath = path.join(DATA_DIR, 'bilibili-cookies.txt');
            const raw = String(data || '').trim();
            const estimatedBytes = Math.floor(raw.length * 3 / 4);
            if (estimatedBytes > dh.MAX_DEPLOY_UPLOAD_BYTES)
                return json(res, { ok: false, message: '上传文件过大' }, 413);
            const buf = Buffer.from(raw, 'base64');
            if (buf.length > dh.MAX_DEPLOY_UPLOAD_BYTES)
                return json(res, { ok: false, message: '上传文件过大' }, 413);
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(filePath, buf);
            json(res, { ok: true, message: 'bilibili-cookies.txt 已保存到当前主控制台机器，不会随代码部署上传' });
        }
        catch (e) {
            json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handlePostDeployLocal(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const cfg = JSON.parse(body);
            const workDir = path.resolve(KOISHI_DIR);
            const qq = String(cfg.qq || '').trim();
            const provider = String(cfg.provider || 'opencode').trim() || 'opencode';
            const model = String(cfg.model || '').trim();
            const baseUrl = String(cfg.baseUrl || '').trim();
            if (!/^\d+$/.test(qq))
                return json(res, { ok: false, message: 'QQ 号不能为空或格式错误' }, 400);
            if (!/^[A-Za-z0-9._-]+$/.test(provider))
                return json(res, { ok: false, message: '供应商名称格式错误' }, 400);
            if (!model)
                return json(res, { ok: false, message: '模型不能为空' }, 400);
            if (baseUrl) {
                try {
                    const parsed = new URL(baseUrl);
                    if (!['http:', 'https:'].includes(parsed.protocol))
                        throw new Error('bad');
                }
                catch {
                    return json(res, { ok: false, message: 'API 地址必须是 http/https URL' }, 400);
                }
            }
            if (!isInsidePath(KOISHI_DIR, workDir))
                return json(res, { ok: false, message: '本地部署目录必须在当前项目目录内' }, 400);
            dh.writeRuntimeLayout();
            const pkgs = ['koishi-plugin-dongxuelian-ai', 'koishi-plugin-dongxuelian-help', 'koishi-plugin-group-name-at', 'koishi-plugin-defense', 'koishi-plugin-local-video-sender', 'koishi-plugin-group-leave-notice', 'koishi-plugin-dongxuelian-poke', 'koishi-plugin-daily-report'];
            const copiedPlugins = [];
            for (const pkg of pkgs) {
                const src = path.join(PLUGIN_ROOT, '..', pkg);
                const dst = path.join(workDir, 'node_modules', pkg);
                if (fs.existsSync(src)) {
                    copyRecursiveSync(path.join(src, 'lib'), path.join(dst, 'lib'));
                    copyRecursiveSync(path.join(src, 'package.json'), path.join(dst, 'package.json'));
                    const templatesDir = path.join(src, 'templates');
                    if (fs.existsSync(templatesDir))
                        copyRecursiveSync(templatesDir, path.join(dst, 'templates'));
                    copiedPlugins.push(pkg);
                }
            }
            const timestamp = Date.now();
            const files = [];
            files.push(dh.writeTrackedLocalFile('data/ai-provider.txt', provider + '\n', { deleteByDefault: true, kind: 'provider' }, timestamp));
            files.push(dh.writeTrackedLocalFile('data/ai-model.txt', model + '\n', { deleteByDefault: true, kind: 'model' }, timestamp));
            files.push(dh.writeTrackedLocalFile('data/ai-base-url.txt', baseUrl + '\n', { deleteByDefault: true, kind: 'baseUrl' }, timestamp));
            const inputApiKey = String(cfg.apiKey || '').trim();
            const keyFiles = { opencode: 'ai-openai-key.txt', deepseek: 'ai-deepseek-key.txt', dashscope: 'ai-dashscope-key.txt', glm: 'ai-glm-key.txt', mimorium: 'ai-mimorium-key.txt' };
            const keyFile = keyFiles[provider] || keyFiles.opencode;
            if (inputApiKey)
                files.push(dh.writeTrackedLocalFile('data/' + keyFile, inputApiKey + '\n', { deleteByDefault: false, sensitive: true, kind: 'apiKey' }, timestamp));
            if (cfg.adminIds)
                files.push(dh.writeTrackedLocalFile('data/ai-admin-ids.json', JSON.stringify(cfg.adminIds, null, 2) + '\n', { deleteByDefault: false, sensitive: true, kind: 'adminIds' }, timestamp));
            const yml = `port: 5140\nselfUrl: http://localhost:5140\nplugins:\n  adapter-onebot:\n    protocol: ws\n    selfId: '${qq}'\n    endpoint: ws://127.0.0.1:8080/onebot/v11/ws\n    responseTimeout: 240000\n  defense: {}\n  dongxuelian-ai: {}\n  dongxuelian-help: {}\n  group-name-at: {}\n  local-video-sender: {}\n  group-leave-notice: {}\n  dongxuelian-poke: {}\n  daily-report: {}\n`;
            files.push(dh.writeTrackedLocalFile('koishi.yml', yml, { deleteByDefault: true, kind: 'koishiConfig' }, timestamp));
            const helper = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nif exist "%~dp0runtime\\node\\node.exe" set "PATH=%~dp0runtime\\node;%PATH%"\r\nset "KOISHI_DIR=%~dp0"\r\nset "DONGXUELIAN_AI_DATA_DIR=%~dp0data"\r\nif not exist node_modules\\koishi (\r\n  echo [ERROR] Dependencies missing or incomplete. Please run "npm install" first.\r\n  echo Project directory: %~dp0\r\n  pause\r\n  exit /b 1\r\n)\r\nnode start.js\r\n`;
            files.push(dh.writeTrackedLocalFile('start-local.bat', helper, { deleteByDefault: true, kind: 'startScript' }, timestamp));
            const aiKey = dh.getAiKeyStatus(provider);
            const manifest = { version: 1, generatedAt: timestamp, qq, onebotEndpoint: 'ws://127.0.0.1:8080/onebot/v11/ws', aiKeyConfigured: aiKey.configured, files };
            dh.writeLocalDeployManifest(manifest);
            json(res, { ok: true, message: aiKey.configured ? 'Koishi 本地配置已写入，NapCat 使用 8080 OneBot WebSocket' : 'Koishi 本地配置已写入；AI Key 未配置，基础部署可继续，AI 回复暂不可用', files, copiedPlugins, aiKeyConfigured: aiKey.configured, aiKey, manifest: { path: toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE), generatedAt: timestamp } });
        }
        catch (e) {
            json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handleGetLocalConfigPreview(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        return json(res, dh.buildLocalConfigPreview());
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
function handlePostLocalConfigDelete(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    collectBody(req, res, () => {
        try {
            const result = dh.deleteLocalConfigFiles();
            return json(res, { ...result, message: result.errors.length ? '部分配置未能删除' : 'Koishi 本地配置已删除' }, result.errors.length ? 400 : 200);
        }
        catch (e) {
            return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handleGetLocalUninstallPreview(req, res) {
    if (!requireStrictAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        const { buildLocalUninstallPreview } = require('../deploy-uninstall');
        const preview = buildLocalUninstallPreview();
        return json(res, { ...preview });
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
function handlePostLocalUninstall(req, res) {
    if (!requireStrictAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const cfg = JSON.parse(body || '{}');
            if (!cfg.confirm)
                return json(res, { ok: false, message: '缺少一键卸载确认标记' }, 400);
            const { runLocalUninstall } = require('../deploy-uninstall');
            const result = runLocalUninstall(cfg);
            return json(res, { ...result });
        }
        catch (e) {
            return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handlePostNapcatDownload(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { url } = JSON.parse(body);
            if (!url)
                return json(res, { ok: false, message: '下载地址不能为空' }, 400);
            dh.downloadToRuntime(String(url), { preferredName: 'napcat-manual.zip', expectedExt: '.zip', minBytes: 128 * 1024 }, (err, filePath, download) => {
                if (err)
                    return json(res, { ok: false, message: err.message }, 400);
                json(res, { ok: true, message: 'NapCat 包已下载到 ' + filePath, path: filePath, download });
            });
        }
        catch (e) {
            json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handlePostNapcatWindowsDownload(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { installDir } = JSON.parse(body || '{}');
            const targetDir = dh.validateNapcatInstallDir(installDir);
            dh.downloadNapcatWindowsRelease(targetDir, (err, detail = {}) => {
                if (err)
                    return json(res, { ok: false, message: err.message, ...detail }, 400);
                fs.mkdirSync(path.dirname(LOCAL_NAPCAT_DIR_FILE), { recursive: true });
                fs.writeFileSync(LOCAL_NAPCAT_DIR_FILE, targetDir, 'utf8');
                json(res, { ok: true, message: detail.message || 'NapCat（Windows）OneKey 包已下载并解压', ...detail, napcat: detectNapcatInstallation() });
            });
        }
        catch (e) {
            json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handlePostNodeWindowsInstall(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    collectBody(req, res, () => {
        try {
            dh.installPortableNodeWindows((err, detail = {}) => {
                if (err)
                    return json(res, { ok: false, message: err.message, ...detail }, 400);
                json(res, { ok: true, ...detail, message: detail.message || '便携 Node/npm 已安装' });
            });
        }
        catch (e) {
            json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
        }
    });
}
function handlePostNpmInstall(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        const dependencies = dh.getProjectDependencyStatus();
        if (dependencies.ready)
            return json(res, { ok: true, skipped: true, message: '项目依赖已安装', status: dh.getLocalNpmInstallStatus() });
        const npmInfo = getCommandInfo('npm');
        const cwd = path.resolve(KOISHI_DIR);
        const npmCmd = npmInfo.found ? npmInfo.path : 'npm';
        const steps = [{ label: '打开终端（PowerShell 或 CMD）并进入项目目录', command: `cd /d "${cwd}"` }, { label: '执行依赖安装', command: npmInfo.found ? `"${npmCmd}" install` : 'npm install' }];
        if (!npmInfo.found)
            steps.unshift({ label: '先安装 Node.js（包含 npm）', command: '前往 https://nodejs.org 下载安装，或在部署器中安装便携 Node' });
        return json(res, { ok: true, guide: true, message: '请在终端中手动执行以下命令安装依赖', steps, cwd, npmPath: npmCmd, status: dh.getLocalNpmInstallStatus() });
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
function handlePostNpmRepairAndInstall(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        const diagnostics = dh.collectNpmInstallDiagnostics(true);
        const proxy = diagnostics.proxy || dh.diagnoseNpmProxy(diagnostics);
        const cwd = path.resolve(KOISHI_DIR);
        const npmInfo = getCommandInfo('npm');
        const npmCmd = npmInfo.found ? npmInfo.path : 'npm';
        const hasNpmProxy = !!(diagnostics.config?.proxy || diagnostics.config?.httpsProxy);
        const hasEnvProxy = Object.entries(diagnostics.env || {}).some(([key, value]) => !/^no_proxy$/i.test(key) && !!value);
        const repairCommands = dh.commandListForNpmProxyFix(hasNpmProxy, hasEnvProxy);
        const steps = [];
        if (repairCommands.length)
            steps.push({ label: '在终端中执行以下命令清理代理配置', command: repairCommands.join('\n') });
        steps.push({ label: '修复后执行依赖安装', command: npmInfo.found ? `"${npmCmd}" install` : 'npm install' });
        return json(res, { ok: true, guide: true, message: '请在终端中手动执行以下修复和安装命令', steps, cwd, npmPath: npmCmd, proxy, diagnostics, status: dh.getLocalNpmInstallStatus() });
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
function handleGetNpmInstallStatus(req, res) { return json(res, { ok: true, status: dh.getLocalNpmInstallStatus() }); }
function handlePostNapcatStart(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        const current = dh.getLocalNapcatDeployStatus();
        if (current.running)
            return json(res, { ok: true, message: 'NapCat 看起来已经在运行', status: current });
        const { detected, entry } = dh.getNapcatStartEntry();
        if (!detected.found || !entry)
            return json(res, { ok: false, message: detected.reason || '未找到可启动的 NapCat，请先安装官方 Windows 包', napcat: detected }, 400);
        const ext = path.extname(entry).toLowerCase();
        const cwd = path.dirname(entry);
        let command = entry, args = [];
        if (ext === '.bat' || ext === '.cmd') {
            command = 'cmd.exe';
            args = ['/d', '/c', entry];
        }
        else if (/^NapCatWinBootMain\.exe$/i.test(path.basename(entry))) {
            const qq = String(dh.readLocalDeployManifest().qq || '').trim();
            if (!/^\d+$/.test(qq)) {
                const detail = fs.existsSync(LOCAL_DEPLOY_MANIFEST_FILE) ? '本地部署清单中缺少有效 qq 字段或格式错误' : `未找到 ${toProjectRel(LOCAL_DEPLOY_MANIFEST_FILE)}，请先完成本地部署并填写 QQ 号`;
                return json(res, { ok: false, message: `无法启动 NapCat（NapCatWinBootMain 需要登录 QQ 号）：${detail}`, napcat: detected }, 400);
            }
            args = [qq];
        }
        else if (ext === '.js' || ext === '.mjs') {
            command = getLocalToolCommand('node');
            args = [entry];
        }
        const { getLocalTaskOptions } = require('../tools');
        spawnLocalTask('napcat', command, args, getLocalTaskOptions({ cwd }));
        return json(res, { ok: true, message: 'NapCat 已启动，请等待 WebUI 或控制台二维码出现后扫码登录', status: dh.getLocalNapcatDeployStatus() });
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
function handleGetNapcatStatus(req, res) { return json(res, { ok: true, status: dh.getLocalNapcatDeployStatus() }); }
function handlePostKoishiStart(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        const current = dh.getLocalKoishiDeployStatus();
        if (current.running)
            return json(res, { ok: true, message: 'Koishi 看起来已经在运行', status: current });
        const dependencies = dh.getProjectDependencyStatus();
        if (!dependencies.ready)
            return json(res, { ok: false, message: '项目依赖尚未完整安装，请先在终端执行 npm install', dependencies }, 400);
        const { getLocalTaskOptions } = require('../tools');
        if (process.platform === 'win32' && fs.existsSync(path.join(KOISHI_DIR, 'start-local.bat'))) {
            spawnLocalTask('koishi', 'cmd.exe', ['/d', '/c', path.join(KOISHI_DIR, 'start-local.bat')], getLocalTaskOptions({ cwd: KOISHI_DIR }));
        }
        else {
            spawnLocalTask('koishi', getLocalToolCommand('node'), ['start.js'], getLocalTaskOptions({ cwd: KOISHI_DIR, shell: process.platform === 'win32', env: { KOISHI_DIR: path.resolve(KOISHI_DIR), DONGXUELIAN_AI_DATA_DIR: DATA_DIR } }));
        }
        return json(res, { ok: true, message: 'Koishi 已启动，正在等待 ' + dh.resolveKoishiListenPort() + ' 端口和 OneBot 连接', status: dh.getLocalKoishiDeployStatus() });
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
function handleGetKoishiStatus(req, res) { return json(res, { ok: true, status: dh.getLocalKoishiDeployStatus() }); }
function handleGetLocalReadyCheck(req, res) {
    try {
        return json(res, dh.buildLocalReadyCheck());
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) }, 400);
    }
}
/** Resolve a temporary path-encoding probe dir without touching KOISHI_DIR. */
function getEnvCheckPathEncodingDir() {
    return path.join(os.tmpdir(), 'lianlian-path-encoding-check', '中文路径');
}
function handleGetEnvCheck(req, res) {
    if (!requireAdmin(req, res))
        return;
    const localDeployTarget = dh.getLocalDeployTarget();
    const nodeInfo = getCommandInfo('node', 18);
    const npmInfo = getCommandInfo('npm');
    const dependencyStatus = dh.getProjectDependencyStatus();
    const portList = [dh.resolveKoishiListenPort(), Number(PORT), resolveNapcatOnebotListenPort(), resolveNapcatWebuiListenPort()];
    const ports = {};
    for (const port of portList)
        ports[port] = checkPortState(port);
    return json(res, { platform: process.platform, host: { platform: process.platform, arch: process.arch, hostname: os.hostname() }, localDeployTarget, blocked: localDeployTarget.blocked, blockedReason: localDeployTarget.blockedReason, projectDir: path.resolve(KOISHI_DIR), runtimeDir: dh.getLocalDeployTarget().runtimeDir, node: nodeInfo, npm: npmInfo, dependencies: dependencyStatus, localConfig: dh.buildLocalConfigPreview(), managedArtifacts: { deleteItems: 0, userDataItems: 0, deleteSize: 0, userDataSize: 0 }, workDir: { exists: fs.existsSync(KOISHI_DIR), path: path.resolve(KOISHI_DIR), writable: null, reason: '环境检测不写入项目目录' }, pathEncoding: dh.inspectChinesePathWrite(getEnvCheckPathEncodingDir()), ports, napcat: detectNapcatInstallation() });
}
function handleGetBotLocalStatus(req, res) {
    try {
        const target = dh.getLocalDeployTarget();
        if (!target.canRunWindowsLocalDeploy)
            return json(res, { running: false, workers: 0, blocked: true, localDeployTarget: target, message: target.blockedReason });
        if (process.platform === 'win32') {
            const port = checkPortState(dh.resolveKoishiListenPort());
            return json(res, { running: port.status === 'occupied', workers: port.status === 'occupied' ? 1 : 0, port });
        }
        const out = execSync("ps aux | grep 'koishi/lib/worker' | grep -v grep", { encoding: 'utf8', timeout: 3000 }).trim();
        const running = out.split('\n').filter(Boolean).length;
        return json(res, { running: running > 0, workers: running });
    }
    catch {
        return json(res, { running: false, workers: 0 });
    }
}
function handlePostBotLocalStop(req, res) {
    if (!requireAdmin(req, res))
        return;
    if (!dh.requireWindowsLocalDeployTarget(req, res))
        return;
    try {
        stopKoishiProcesses();
        return json(res, { ok: true, message: '本地 Bot 已停止' });
    }
    catch (e) {
        return json(res, { ok: false, message: getLegacyErrorMessage(e) });
    }
}
const routes = {
    'GET /dashboard/api/deploy/config': handleGetDeployConfig,
    'POST /dashboard/api/deploy/preview': handlePostDeployPreview,
    'PUT /dashboard/api/deploy/config': handlePutDeployConfig,
    'POST /dashboard/api/deploy/run': handlePostSafeDeployRun,
    'POST /dashboard/api/deploy/upload': handlePostDeployUpload,
    'POST /dashboard/api/deploy/local': handlePostDeployLocal,
    'GET /dashboard/api/deploy/local-config-preview': handleGetLocalConfigPreview,
    'POST /dashboard/api/deploy/local-config-delete': handlePostLocalConfigDelete,
    'GET /dashboard/api/deploy/local-uninstall-preview': handleGetLocalUninstallPreview,
    'POST /dashboard/api/deploy/local-uninstall': handlePostLocalUninstall,
    'POST /dashboard/api/deploy/napcat-download': handlePostNapcatDownload,
    'POST /dashboard/api/deploy/napcat-windows-download': handlePostNapcatWindowsDownload,
    'POST /dashboard/api/deploy/node-windows-install': handlePostNodeWindowsInstall,
    'POST /dashboard/api/deploy/npm-install': handlePostNpmInstall,
    'POST /dashboard/api/deploy/npm-repair-and-install': handlePostNpmRepairAndInstall,
    'GET /dashboard/api/deploy/npm-install-status': handleGetNpmInstallStatus,
    'POST /dashboard/api/deploy/napcat-start': handlePostNapcatStart,
    'GET /dashboard/api/deploy/napcat-status': handleGetNapcatStatus,
    'POST /dashboard/api/deploy/koishi-start': handlePostKoishiStart,
    'GET /dashboard/api/deploy/koishi-status': handleGetKoishiStatus,
    'GET /dashboard/api/deploy/local-ready-check': handleGetLocalReadyCheck,
    'GET /dashboard/api/env/check': handleGetEnvCheck,
    'POST /dashboard/api/frontend/rebuild': handlePostFrontendRebuild,
    'GET /dashboard/api/frontend/rebuild-status': handleGetFrontendRebuildStatus,
    'GET /dashboard/api/bot/local-status': handleGetBotLocalStatus,
    'POST /dashboard/api/bot/local-stop': handlePostBotLocalStop,
};
const prefixRoutes = [
    { prefix: '/dashboard/api/deploy/progress/', method: 'GET', handler: handleGetDeployProgress },
];
module.exports = { routes, prefixRoutes };
