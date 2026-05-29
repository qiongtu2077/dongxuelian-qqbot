'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { isInsidePath, removePathWithRetry, uniquePaths, sleepSync } = require('./utils');
const { KOISHI_DIR, DATA_DIR, LOCAL_NAPCAT_DIR_FILE, isPackagedLocalWorkspace, toProjectRel, resolveProjectRel, runtimePath } = require('./paths');
const { getCommandInfo, getPortableNodeDir } = require('./tools');
const { detectNapcatInstallation, inspectNapcatCandidate } = require('./napcat');
const { localTasks } = require('./deploy-state');
const { psQuote, getLocalDeployTarget } = require('./deploy-helpers');
function readFileSync(p) {
    try {
        return fs.readFileSync(p, 'utf8').trim();
    }
    catch {
        return '';
    }
}
function projectDisplayPath(filePath) {
    const resolved = path.resolve(filePath);
    return isInsidePath(KOISHI_DIR, resolved) ? toProjectRel(resolved) : resolved;
}
function safeLstat(filePath) {
    try {
        return fs.lstatSync(filePath);
    }
    catch {
        return null;
    }
}
function summarizePath(filePath, limit = 50000) {
    const rootStat = safeLstat(filePath);
    if (!rootStat)
        return { exists: false, size: 0, count: 0, truncated: false };
    let size = 0, count = 0, truncated = false;
    const stack = [{ filePath, stat: rootStat }];
    while (stack.length) {
        const item = stack.pop();
        count += 1;
        size += Number(item.stat.size) || 0;
        if (count > limit) {
            truncated = true;
            break;
        }
        if (!item.stat.isDirectory() || item.stat.isSymbolicLink())
            continue;
        let entries = [];
        try {
            entries = fs.readdirSync(item.filePath, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const child = path.join(item.filePath, entry.name);
            const childStat = safeLstat(child);
            if (childStat)
                stack.push({ filePath: child, stat: childStat });
        }
    }
    return { exists: true, size, count, truncated, directory: rootStat.isDirectory(), symlink: rootStat.isSymbolicLink() };
}
function uniqueTargets(targets) {
    const seen = new Set();
    return targets.filter(target => {
        if (!target?.fullPath)
            return false;
        const key = path.resolve(target.fullPath).toLowerCase();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function createUninstallItem(key, label, reason, paths, options = {}) {
    const targets = uniqueTargets(paths.map(item => {
        const fullPath = path.resolve(item.fullPath || item);
        const summary = summarizePath(fullPath);
        if (!summary.exists)
            return null;
        return { path: item.path || projectDisplayPath(fullPath), fullPath, scope: item.scope || 'project', size: summary.size, count: summary.count, truncated: summary.truncated, directory: summary.directory, symlink: summary.symlink };
    }).filter(Boolean));
    if (!targets.length)
        return null;
    return { key, label, action: options.action || 'delete', kind: options.kind || 'environment', reason, defaultKeep: !!options.defaultKeep, size: targets.reduce((sum, t) => sum + (t.size || 0), 0), count: targets.reduce((sum, t) => sum + (t.count || 0), 0), truncated: targets.some(t => t.truncated), paths: targets.map(t => ({ path: t.path, size: t.size, count: t.count, truncated: t.truncated, directory: t.directory, symlink: t.symlink })), targets };
}
function pushUninstallItem(list, item) { if (item)
    list.push(item); }
function projectTarget(rel) {
    return { fullPath: resolveProjectRel(rel), path: rel, scope: 'project' };
}
function existingProjectTarget(rel) {
    const target = projectTarget(rel);
    return fs.existsSync(target.fullPath) ? target : null;
}
function listExistingDataChildren(excludedRels) {
    if (!isInsidePath(KOISHI_DIR, DATA_DIR) || !fs.existsSync(DATA_DIR))
        return [];
    const result = [];
    let entries = [];
    try {
        entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    }
    catch {
        return result;
    }
    for (const entry of entries) {
        const rel = path.posix.join('data', entry.name);
        if (excludedRels.has(rel))
            continue;
        result.push(projectTarget(rel));
    }
    return result;
}
function listReleaseArtifacts() {
    const releaseDir = path.join(KOISHI_DIR, 'local-deployer', 'release');
    if (!fs.existsSync(releaseDir))
        return [];
    let entries = [];
    try {
        entries = fs.readdirSync(releaseDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries.filter(entry => entry.name !== 'README.txt').map(entry => projectTarget(path.posix.join('local-deployer', 'release', entry.name))).filter(target => fs.existsSync(target.fullPath));
}
function listExistingProjectChildren(parentRel, matcher) {
    const parent = resolveProjectRel(parentRel);
    if (!fs.existsSync(parent))
        return [];
    let entries = [];
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries.filter(entry => matcher(entry.name, entry)).map(entry => projectTarget(path.posix.join(parentRel, entry.name))).filter(target => fs.existsSync(target.fullPath));
}
function listPackagedWorkspaceResourceTargets() {
    if (!isPackagedLocalWorkspace())
        return [];
    return ['packages', 'scripts', 'package.json', 'package-lock.json', 'start.js', 'koishi.example.yml', '.lianlian-workspace.json'].map(existingProjectTarget).filter(Boolean);
}
function isBlockedDeletePath(filePath) {
    const resolved = path.resolve(filePath);
    const lower = resolved.toLowerCase();
    const root = path.parse(resolved).root;
    if (lower === path.resolve(root).toLowerCase())
        return '不能删除磁盘根目录';
    const blocked = [process.env.WINDIR, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, os.homedir()].filter(Boolean).map(item => path.resolve(item).toLowerCase());
    const hit = blocked.find(item => lower === item || lower.startsWith(item + path.sep.toLowerCase()));
    if (hit && (lower === hit || ['windows', 'program files', 'program files (x86)', 'programdata'].some(name => hit.endsWith(path.sep + name))))
        return '不能删除系统目录或用户主目录根';
    return '';
}
function assertSafeProjectDeletePath(filePath) {
    const resolved = path.resolve(filePath);
    const projectRoot = path.resolve(KOISHI_DIR);
    if (resolved === projectRoot)
        throw new Error('不能删除项目根目录');
    if (!isInsidePath(projectRoot, resolved))
        throw new Error('删除路径不在当前项目目录内');
    const blocked = isBlockedDeletePath(resolved);
    if (blocked)
        throw new Error(blocked);
    const stat = safeLstat(resolved);
    if (!stat)
        return;
    if (stat.isSymbolicLink())
        throw new Error('拒绝删除符号链接或 junction');
    let real = '';
    try {
        real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    }
    catch {
        real = resolved;
    }
    if (!isInsidePath(projectRoot, real))
        throw new Error('真实路径指向项目目录外');
}
function assertSafeExternalNapcatDeletePath(filePath) {
    const resolved = path.resolve(filePath);
    const recorded = path.resolve(readFileSync(LOCAL_NAPCAT_DIR_FILE) || '');
    if (!recorded || resolved.toLowerCase() !== recorded.toLowerCase())
        throw new Error('外部 NapCat 目录未由本工具记录');
    const blocked = isBlockedDeletePath(resolved);
    if (blocked)
        throw new Error(blocked);
    const stat = safeLstat(resolved);
    if (!stat)
        throw new Error('路径不存在');
    if (stat.isSymbolicLink())
        throw new Error('拒绝删除符号链接或 junction');
    const inspected = inspectNapcatCandidate(resolved);
    if (!inspected.exists || (!inspected.found && inspected.status !== 'partial'))
        throw new Error('路径无法验证为 NapCat 安装目录');
}
function assertSafeUninstallTarget(target) {
    if (target.scope === 'externalNapcat')
        return assertSafeExternalNapcatDeletePath(target.fullPath);
    return assertSafeProjectDeletePath(target.fullPath);
}
function buildLocalUninstallPreview() {
    const deleteItems = [];
    const userDataItems = [];
    const keepItems = [];
    const warnings = [];
    const excludedData = new Set(['data/ai-provider.txt', 'data/ai-model.txt', 'data/ai-base-url.txt', 'data/dashboard-local-deploy-manifest.json', 'data/dashboard-napcat-dir.txt', 'data/backups/dashboard-local-deploy']);
    pushUninstallItem(deleteItems, createUninstallItem('root-node-modules', '项目依赖 node_modules', '本项目 npm install 产生的依赖目录，可重新安装', [existingProjectTarget('node_modules')].filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('dashboard-frontend-node-modules', 'Dashboard 前端依赖', '前端构建依赖，可重新安装', [existingProjectTarget('packages/koishi-plugin-dashboard/frontend/node_modules')].filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('local-deployer-node-modules', '本地部署器依赖', 'Electron 本地部署器依赖，可重新安装', [existingProjectTarget('local-deployer/node_modules')].filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('local-deployer-dist', '本地部署器构建产物', '打包输出，可重新构建', [existingProjectTarget('local-deployer/dist')].filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('local-deployer-release-artifacts', '本地部署器发布包', '保留 release/README.txt，只清理生成的发布附件', listReleaseArtifacts()));
    pushUninstallItem(deleteItems, createUninstallItem('packaged-workspace-resources', '部署器同步的运行资源', '打包版 EXE 自动同步出来的 packages、scripts 和项目清单，可由部署器重新生成', listPackagedWorkspaceResourceTargets()));
    pushUninstallItem(deleteItems, createUninstallItem('runtime-node', '项目便携 Node', '仅删除项目 runtime/node 中由本项目管理的 Node', [existingProjectTarget('runtime/node')].filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('runtime-install-staging', '安装临时解压目录', 'NapCat/Node 安装过程中产生的 napcat-install-* 与 node-install-* 暂存目录', listExistingProjectChildren('runtime', name => /^(?:napcat|node)-install-/i.test(name))));
    pushUninstallItem(deleteItems, createUninstallItem('local-koishi-config', 'Koishi 本地配置', '本地部署生成的 Koishi 配置和启动脚本', ['koishi.yml', 'start-local.bat'].map(existingProjectTarget).filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('local-deploy-runtime-config', '本地部署运行配置', '供应商、模型、baseUrl、部署清单和备份', ['data/ai-provider.txt', 'data/ai-model.txt', 'data/ai-base-url.txt', 'data/dashboard-local-deploy-manifest.json', 'data/dashboard-napcat-dir.txt', 'data/backups/dashboard-local-deploy'].map(existingProjectTarget).filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('napcat-runtime', 'NapCat 安装目录', '默认 runtime/napcat 安装目录', [existingProjectTarget('runtime/napcat'), existingProjectTarget('runtime/NapCat')].filter(Boolean)));
    pushUninstallItem(deleteItems, createUninstallItem('napcat-downloads', 'NapCat 下载缓存', '本工具下载的 NapCat 安装包缓存', [existingProjectTarget('runtime/downloads')].filter(Boolean)));
    const recordedNapcat = readFileSync(LOCAL_NAPCAT_DIR_FILE);
    if (recordedNapcat && fs.existsSync(recordedNapcat) && !isInsidePath(KOISHI_DIR, recordedNapcat)) {
        try {
            assertSafeExternalNapcatDeletePath(recordedNapcat);
            pushUninstallItem(deleteItems, createUninstallItem('external-napcat', '自定义 NapCat 安装目录', '本工具记录过的项目外 NapCat 目录', [{ fullPath: recordedNapcat, path: recordedNapcat, scope: 'externalNapcat' }]));
        }
        catch (e) {
            warnings.push({ key: 'external-napcat', path: recordedNapcat, reason: '项目外 NapCat 目录未自动删除：' + e.message });
        }
    }
    const keyTargets = [];
    if (fs.existsSync(DATA_DIR) && isInsidePath(KOISHI_DIR, DATA_DIR)) {
        let entries = [];
        try {
            entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
        }
        catch { /* non-critical: optional data scan */ }
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            if (/(?:key|token|pwd|password|cookie)/i.test(entry.name)) {
                const rel = path.posix.join('data', entry.name);
                excludedData.add(rel);
                keyTargets.push(projectTarget(rel));
            }
        }
    }
    pushUninstallItem(userDataItems, createUninstallItem('api-secrets', 'API Key 与登录凭据', 'AI Key、Dashboard 密码、重置令牌、cookies 等敏感文件，默认保留', keyTargets, { kind: 'userData', defaultKeep: true }));
    const adminTarget = existingProjectTarget('data/ai-admin-ids.json');
    if (adminTarget)
        excludedData.add('data/ai-admin-ids.json');
    pushUninstallItem(userDataItems, createUninstallItem('admin-ids', '管理员 ID', '机器人管理员列表，默认保留', [adminTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }));
    const profileTarget = existingProjectTarget('data/user-profiles');
    if (profileTarget)
        excludedData.add('data/user-profiles');
    pushUninstallItem(userDataItems, createUninstallItem('user-profiles', '用户资料', '用户画像、偏好和长期资料，默认保留', [profileTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }));
    const conversationTarget = existingProjectTarget('data/conversations');
    if (conversationTarget)
        excludedData.add('data/conversations');
    pushUninstallItem(userDataItems, createUninstallItem('conversations', '会话与记忆', '聊天上下文、会话缓存和记忆数据，默认保留', [conversationTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }));
    const galleryTarget = existingProjectTarget('data/gallery');
    if (galleryTarget)
        excludedData.add('data/gallery');
    pushUninstallItem(userDataItems, createUninstallItem('gallery-images', '莲莲图集', '用户上传的图集图片，默认保留', [galleryTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }));
    const logTarget = existingProjectTarget('runtime/logs');
    pushUninstallItem(userDataItems, createUninstallItem('runtime-logs', '运行日志', 'Koishi、Dashboard 和部署过程日志，默认保留', [logTarget].filter(Boolean), { kind: 'userData', defaultKeep: true }));
    const otherDataTargets = listExistingDataChildren(excludedData);
    pushUninstallItem(userDataItems, createUninstallItem('other-data', '其他 data 用户数据', '白名单、黑名单、暂停状态、缓存和其他运行数据，默认保留', otherDataTargets, { kind: 'userData', defaultKeep: true }));
    const nodeInfo = getCommandInfo('node', 18);
    const npmInfo = getCommandInfo('npm');
    for (const tool of [nodeInfo, npmInfo]) {
        if (tool.found && !tool.ownedByProject)
            keepItems.push({ action: 'keep', kind: 'systemTool', label: tool === nodeInfo ? '系统 Node.js' : '系统 npm', path: tool.sourcePath || 'PATH', reason: '系统级工具未由本项目安装，一键卸载只报告不删除', version: tool.version });
    }
    return { ok: true, deleteItems, userDataItems, keepItems, warnings, stats: { deleteSize: deleteItems.reduce((s, i) => s + i.size, 0), userDataSize: userDataItems.reduce((s, i) => s + i.size, 0), deleteCount: deleteItems.reduce((s, i) => s + i.count, 0), userDataCount: userDataItems.reduce((s, i) => s + i.count, 0) }, systemTools: { node: nodeInfo, npm: npmInfo }, projectDir: path.resolve(KOISHI_DIR) };
}
function stopLocalDeployProcessesForUninstall() {
    if (process.platform !== 'win32')
        return [{ type: 'info', message: '非 Windows 后端未执行进程停止' }];
    const roots = uniquePaths([path.resolve(KOISHI_DIR), runtimePath(), runtimePath('napcat'), runtimePath('NapCat'), readFileSync(LOCAL_NAPCAT_DIR_FILE)].filter(Boolean));
    const psPaths = roots.map(item => psQuote(path.resolve(item))).join(',');
    const script = `$self = ${process.pid}; $paths = @(${psPaths}); $procs = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and ($_.Name -match 'node|napcat|qq|electron|koishi') }; foreach ($proc in $procs) { $text = (($proc.CommandLine, $proc.ExecutablePath) -join ' '); foreach ($item in $paths) { if ($item -and $item.Length -gt 3 -and $text -like ('*' + $item + '*')) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue; break } } }`;
    try {
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
        sleepSync(600);
        return [];
    }
    catch (e) {
        return [{ type: 'warning', message: '停止本项目相关进程时遇到问题：' + String(e.stderr || e.message || '').trim() }];
    }
}
function removeTarget(target) {
    assertSafeUninstallTarget(target);
    const summary = summarizePath(target.fullPath);
    removePathWithRetry(target.fullPath);
    if (fs.existsSync(target.fullPath))
        throw new Error('目标仍然存在，可能被占用：' + target.fullPath);
    return { path: target.path, size: summary.size, count: summary.count, status: 'ok' };
}
function pruneEmptyProjectDirs(removeWorkspaceRoot = false) {
    for (const rel of ['runtime/downloads', 'runtime/logs', 'runtime', 'data/backups/dashboard-local-deploy', 'data/backups', 'data']) {
        try {
            fs.rmdirSync(resolveProjectRel(rel));
        }
        catch { /* non-critical: prune empty dir best effort */ }
    }
    if (removeWorkspaceRoot && isPackagedLocalWorkspace()) {
        try {
            fs.rmdirSync(path.resolve(KOISHI_DIR));
        }
        catch { /* non-critical: prune workspace best effort */ }
    }
}
function runLocalUninstall(options = {}) {
    const preview = buildLocalUninstallPreview();
    const deleteUserDataKeys = new Set(Array.isArray(options.deleteUserDataKeys) ? options.deleteUserDataKeys.map(String) : []);
    const deleteAllUserData = preview.userDataItems.every(item => deleteUserDataKeys.has(item.key));
    const selectedItems = preview.deleteItems.concat(preview.userDataItems.filter(item => deleteUserDataKeys.has(item.key)));
    const deleted = [], kept = preview.keepItems.concat(preview.userDataItems.filter(item => !deleteUserDataKeys.has(item.key))), errors = [];
    const warnings = [...(preview.warnings || []), ...stopLocalDeployProcessesForUninstall()];
    for (const item of selectedItems) {
        for (const target of item.targets || []) {
            try {
                deleted.push({ ...removeTarget(target), item: item.key, label: item.label });
            }
            catch (e) {
                errors.push({ path: target.path, item: item.key, label: item.label, reason: e.message });
            }
        }
    }
    for (const target of listExistingProjectChildren('runtime', name => /^(?:napcat|node)-install-/i.test(name)).concat(['runtime/napcat', 'runtime/NapCat'].map(existingProjectTarget).filter(Boolean))) {
        if (!fs.existsSync(target.fullPath))
            continue;
        if (selectedItems.some(item => item.key === 'runtime-install-staging' || item.key === 'napcat-runtime'))
            errors.push({ path: target.path, item: 'residual-runtime', label: '残留运行环境', reason: '卸载后路径仍存在，可能被 NapCat/QQ/Node 占用：' + target.fullPath });
    }
    pruneEmptyProjectDirs(deleteAllUserData);
    return { ok: errors.length === 0, deleted, kept, warnings, errors, message: errors.length ? '一键卸载完成，但有项目未能删除' : '一键卸载完成' };
}
module.exports = {
    projectDisplayPath, safeLstat, summarizePath, uniqueTargets,
    createUninstallItem, pushUninstallItem, projectTarget, existingProjectTarget,
    listExistingDataChildren, listReleaseArtifacts, listExistingProjectChildren, listPackagedWorkspaceResourceTargets,
    isBlockedDeletePath, assertSafeProjectDeletePath, assertSafeExternalNapcatDeletePath, assertSafeUninstallTarget,
    buildLocalUninstallPreview, stopLocalDeployProcessesForUninstall, removeTarget, pruneEmptyProjectDirs, runLocalUninstall,
};
