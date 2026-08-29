'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { shellQuote } = require('./utils');
const { buildDashboardRelease, verifyReleaseManifest, RELEASE_PACKAGES } = require('./release');
const dh = require('./deploy-helpers');
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const STARTED_PREVIEW_RETENTION_MS = 30 * 60 * 1000;
const DISK_SAFETY_BYTES = 64 * 1024 * 1024;
const REMOTE_PROBE_SCRIPT = String.raw `
const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')
const requested = process.argv[2]
const cleanError = error => String(error && (error.stderr || error.message) || error || '').trim().slice(0, 500)
try {
  const appDir = fs.realpathSync(requested)
  const disk = fs.statfsSync(appDir)
  const releaseRoot = path.join(appDir, '.lian-releases')
  const current = path.join(releaseRoot, 'current')
  let release = null
  let releaseError = ''
  try {
    const currentTarget = fs.realpathSync(current)
    const currentRelative = path.relative(releaseRoot, currentTarget)
    if (!currentRelative || currentRelative.startsWith('..' + path.sep) || path.isAbsolute(currentRelative)) throw new Error('current 指向版本目录之外')
    childProcess.execFileSync(process.execPath, [path.join(current, 'scripts', 'verify-release-manifest.js'), current], { stdio: 'ignore', timeout: 180000 })
    release = JSON.parse(fs.readFileSync(path.join(current, 'release-manifest.json'), 'utf8'))
    if (path.basename(currentTarget) !== String(release.releaseId || '')) throw new Error('current 目录名与发布编号不一致')
  } catch (error) {
    releaseError = cleanError(error) || '当前发布不存在或清单校验失败'
  }
  const lockDir = path.join(releaseRoot, 'deploy.lock')
  let owner = ''
  try { owner = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8').trim().slice(0, 500) } catch {}
  process.stdout.write(JSON.stringify({
    ok: true,
    hostname: os.hostname(),
    appDir,
    availableBytes: Number(disk.bavail) * Number(disk.bsize),
    release,
    releaseError,
    lock: { present: fs.existsSync(lockDir), owner },
  }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: cleanError(error) || '远端应用目录探测失败' }))
}
`;
// --- Source and target inspection ---
// Reads the exact repository root, full commit and all worktree changes.
function inspectGitSource(repoRoot) {
    const requestedRoot = path.resolve(repoRoot);
    const actualRoot = path.resolve(String(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: requestedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim());
    if (actualRoot !== requestedRoot)
        throw new Error('发布源不是独立 Git 仓库根目录');
    const commit = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: actualRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(commit))
        throw new Error('无法读取完整 Git 提交号');
    const output = String(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: actualRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const changes = output.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
    return { hostname: os.hostname(), repoRoot: actualRoot, commit, clean: changes.length === 0, changes };
}
// Builds every tracked plugin artifact before the preview freezes a release.
function buildTrackedArtifacts(repoRoot) {
    if (process.platform === 'win32') {
        execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build:plugins'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
        return;
    }
    execFileSync('npm', ['run', 'build:plugins'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
}
// Allows build output changes only inside the release payload's declared generated paths.
function isAllowedBuildChange(statusLine) {
    const paths = String(statusLine || '').slice(3).split(' -> ').map(value => value.replace(/\\/g, '/'));
    return paths.length > 0 && paths.every(relativePath => {
        if (relativePath.startsWith('packages/koishi-plugin-dashboard/frontend/dist/'))
            return true;
        if (['packages/koishi-plugin-dashboard/index.js', 'packages/koishi-plugin-dashboard/index.d.ts', 'packages/koishi-plugin-dashboard/standalone.js', 'packages/koishi-plugin-dashboard/standalone.d.ts'].includes(relativePath))
            return true;
        return RELEASE_PACKAGES.some(packageName => relativePath.startsWith(`packages/${packageName}/lib/`));
    });
}
// Returns the dependency directories that the existing root and frontend build scripts use.
function getBuildDependencyLinks(repoRoot, worktreeRoot) {
    return [
        { source: path.join(repoRoot, 'node_modules'), target: path.join(worktreeRoot, 'node_modules') },
        { source: path.join(repoRoot, 'packages', 'koishi-plugin-dashboard', 'frontend', 'node_modules'), target: path.join(worktreeRoot, 'packages', 'koishi-plugin-dashboard', 'frontend', 'node_modules') },
    ];
}
// Links only the dependency directories required by the existing build scripts.
function linkBuildDependencies(repoRoot, worktreeRoot) {
    for (const link of getBuildDependencyLinks(repoRoot, worktreeRoot)) {
        if (!fs.existsSync(link.source))
            throw new Error(`发布源缺少构建依赖目录: ${path.relative(repoRoot, link.source).replace(/\\/g, '/')}`);
        fs.mkdirSync(path.dirname(link.target), { recursive: true });
        fs.symlinkSync(link.source, link.target, process.platform === 'win32' ? 'junction' : 'dir');
    }
}
// Removes one detached build worktree without following its dependency symlinks.
function removeBuildWorktree(repoRoot, worktreeRoot) {
    for (const link of getBuildDependencyLinks(repoRoot, worktreeRoot).reverse()) {
        try {
            if (fs.existsSync(link.target))
                fs.unlinkSync(link.target);
        }
        catch { /* Git removal below remains authoritative */ }
    }
    try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreeRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch {
        try {
            fs.rmSync(worktreeRoot, { recursive: true, force: true });
        }
        catch { /* prune clears the registration when filesystem cleanup is unavailable */ }
        try {
            execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch { /* later previews use a unique path */ }
    }
}
// Builds a committed snapshot in an isolated worktree and freezes its exact artifacts.
function buildFrozenRelease(repoRoot, worktreeRoot, releasesRoot, commit) {
    fs.mkdirSync(path.dirname(worktreeRoot), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', worktreeRoot, commit], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        linkBuildDependencies(repoRoot, worktreeRoot);
        buildTrackedArtifacts(worktreeRoot);
        const builtSource = inspectGitSource(worktreeRoot);
        const unexpectedChanges = builtSource.changes.filter(change => !isAllowedBuildChange(change));
        if (unexpectedChanges.length)
            return { release: null, changes: unexpectedChanges };
        const built = buildDashboardRelease(worktreeRoot, releasesRoot);
        const files = built.manifest.files.map(file => ({ ...file }));
        return { release: { releaseDir: built.releaseDir, releaseId: built.manifest.releaseId, commit: built.manifest.commit, manifestHash: built.manifest.manifestHash, contentHash: built.manifest.contentHash, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) }, changes: [] };
    }
    finally {
        removeBuildWorktree(repoRoot, worktreeRoot);
    }
}
// Translates known SSH failures while retaining a bounded exact diagnostic.
function describeRemoteProbeFailure(value) {
    const raw = String(value || 'SSH 只读探测失败').trim().slice(-1000);
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(raw))
        return `SSH 主机密钥校验失败，目标身份可能已变化：${raw}`;
    if (/Permission denied/i.test(raw))
        return `SSH 密钥认证失败：${raw}`;
    if (/Could not resolve hostname|Name or service not known/i.test(raw))
        return `SSH 目标主机无法解析：${raw}`;
    if (/Connection timed out|Operation timed out/i.test(raw))
        return `SSH 连接超时：${raw}`;
    if (/Connection refused/i.test(raw))
        return `SSH 连接被拒绝：${raw}`;
    return raw;
}
// Performs one fixed, read-only remote probe through the validated SSH target.
function probeRemoteTarget(server, appDir) {
    const target = dh.validateDeployTarget({ server, appDir, mode: 'update' });
    const encoded = Buffer.from(REMOTE_PROBE_SCRIPT, 'utf8').toString('base64');
    const wrapper = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";
    const command = `node -e ${shellQuote(wrapper)} ${shellQuote(encoded)} ${shellQuote(target.appDir)}`;
    let output = '';
    try {
        output = execSync(dh.sshCommand(target.server, command), { encoding: 'utf8', timeout: 3 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    }
    catch (error) {
        const detail = error;
        throw new Error(describeRemoteProbeFailure(detail.stderr || detail.message));
    }
    const raw = JSON.parse(String(output || '{}'));
    if (!raw.ok)
        throw new Error(String(raw.error || '远端应用目录探测失败'));
    if (!raw.hostname || !raw.appDir || !Number.isFinite(Number(raw.availableBytes)))
        throw new Error('远端探测结果结构无效');
    const release = normalizeReleaseIdentity(raw.release);
    return {
        hostname: String(raw.hostname),
        appDir: String(raw.appDir),
        availableBytes: Number(raw.availableBytes),
        release,
        releaseError: String(raw.releaseError || (raw.release && !release ? '远端发布清单结构无效' : '')),
        lock: { present: !!raw.lock?.present, owner: String(raw.lock?.owner || '') },
    };
}
// --- Preview comparison and persistence ---
// Validates the release fields used as a frozen remote baseline.
function normalizeReleaseIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const raw = value;
    if (raw.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(String(raw.releaseId || '')) || !/^[a-f0-9]{40,64}$/.test(String(raw.commit || '')) || !/^[a-f0-9]{64}$/.test(String(raw.manifestHash || '')) || !/^[a-f0-9]{64}$/.test(String(raw.contentHash || '')) || !Array.isArray(raw.files))
        return null;
    const files = raw.files.map(item => ({ path: String(item.path || ''), size: Number(item.size), sha256: String(item.sha256 || '') }));
    if (files.some(item => !item.path || !Number.isFinite(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)))
        return null;
    return { schemaVersion: 1, releaseId: String(raw.releaseId), version: String(raw.version || ''), commit: String(raw.commit || ''), builtAt: String(raw.builtAt || ''), files, contentHash: String(raw.contentHash), manifestHash: String(raw.manifestHash) };
}
// Compares two complete manifests without reading any user data.
function summarizeReleaseChanges(nextFiles, currentFiles) {
    const current = new Map(currentFiles.map(file => [file.path, file]));
    let added = 0;
    let modified = 0;
    let unchanged = 0;
    let totalBytes = 0;
    for (const file of nextFiles) {
        totalBytes += file.size;
        const previous = current.get(file.path);
        if (!previous)
            added += 1;
        else if (previous.size !== file.size || previous.sha256 !== file.sha256)
            modified += 1;
        else
            unchanged += 1;
        current.delete(file.path);
    }
    return { added, modified, removed: current.size, unchanged, totalFiles: nextFiles.length, totalBytes };
}
// Returns true only when a target is clearly the source machine itself.
function isSelfDeploy(sourceHostname, server, targetHostname) {
    const local = sourceHostname.trim().toLowerCase();
    const remote = targetHostname.trim().toLowerCase();
    const serverHost = server.replace(/^[^@]+@/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return !!local && (local === remote || ['localhost', '127.0.0.1', '::1', local].includes(serverHost));
}
// Produces explicit blockers from one frozen source, release and remote probe.
function collectPreviewBlockers(source, server, requestedAppDir, target, release, remoteError = '') {
    const blockers = [];
    if (!source.clean)
        blockers.push(`发布源工作区不干净（${source.changes.length} 项），请提交或移除改动后重新预览`);
    if (remoteError)
        blockers.push(`远端只读探测失败：${remoteError}`);
    if (target) {
        if (isSelfDeploy(source.hostname, server, target.hostname))
            blockers.push('目标主机与发布源相同，禁止控制台给自身发布');
        if (target.appDir !== requestedAppDir)
            blockers.push(`远端应用目录解析为 ${target.appDir}，与配置值不一致`);
        if (!target.release)
            blockers.push(`远端当前发布无法完整校验：${target.releaseError || '尚无不可变发布记录'}`);
        if (target.lock.present)
            blockers.push(`远端存在发布锁${target.lock.owner ? `：${target.lock.owner}` : ''}`);
        if (release) {
            const requiredBytes = release.totalBytes + Math.max(DISK_SAFETY_BYTES, Math.ceil(release.totalBytes * 0.1));
            if (target.availableBytes < requiredBytes)
                blockers.push(`远端磁盘不足：需要至少 ${requiredBytes} 字节，可用 ${target.availableBytes} 字节`);
        }
    }
    return blockers;
}
// Resolves a preview record path from a strict random identifier.
function previewFile(previewsDir, previewId) {
    const id = String(previewId || '');
    if (!/^[a-f0-9]{32}$/.test(id))
        throw new Error('无效 previewId');
    return path.join(path.resolve(previewsDir), id + '.json');
}
// Writes one preview atomically so a Dashboard restart cannot expose partial JSON.
function writePreview(previewsDir, preview) {
    fs.mkdirSync(previewsDir, { recursive: true });
    const target = previewFile(previewsDir, preview.previewId);
    const next = target + '.tmp';
    fs.writeFileSync(next, JSON.stringify(preview, null, 2), 'utf8');
    fs.renameSync(next, target);
}
// Accepts only one direct immutable release child, never the releases root itself.
function isPreviewReleaseDirectory(releasesRoot, releaseDir, releaseId) {
    const root = path.resolve(releasesRoot);
    const target = path.resolve(releaseDir);
    return /^[a-z0-9-]+$/.test(releaseId) && path.dirname(target) === root && path.basename(target) === releaseId;
}
// Deletes only expired preview records and their validated, task-idle release directories.
function cleanupExpiredPreviews(previewsDir, releasesRoot, now = Date.now()) {
    let entries = [];
    try {
        entries = fs.readdirSync(previewsDir);
    }
    catch {
        return;
    }
    for (const name of entries) {
        if (!/^[a-f0-9]{32}\.json$/.test(name))
            continue;
        const file = path.join(previewsDir, name);
        try {
            const preview = JSON.parse(fs.readFileSync(file, 'utf8'));
            const startedStillActive = preview.startedAt > 0 && now - preview.startedAt <= STARTED_PREVIEW_RETENTION_MS;
            if (preview.expiresAt > now || startedStillActive)
                continue;
            if (preview.release?.releaseDir && isPreviewReleaseDirectory(releasesRoot, preview.release.releaseDir, preview.release.releaseId))
                fs.rmSync(preview.release.releaseDir, { recursive: true, force: true });
            fs.rmSync(file, { force: true });
        }
        catch { /* malformed records are left for explicit operator inspection */ }
    }
}
// --- Preview creation and execution validation ---
// Builds and persists a 30-minute preview without changing the remote server.
function createRemoteReleasePreview(options) {
    const targetConfig = dh.validateDeployTarget({ server: options.server, appDir: options.appDir, mode: 'update' });
    const repoRoot = path.resolve(options.repoRoot);
    const releasesRoot = path.resolve(options.releasesRoot);
    const previewsDir = path.resolve(options.previewsDir);
    const previewId = crypto.randomBytes(16).toString('hex');
    cleanupExpiredPreviews(previewsDir, releasesRoot);
    let source = inspectGitSource(repoRoot);
    let release = null;
    if (source.clean) {
        const frozen = buildFrozenRelease(repoRoot, path.join(previewsDir, 'worktrees', previewId), releasesRoot, source.commit);
        release = frozen.release;
        if (frozen.changes.length)
            source = { ...source, clean: false, changes: frozen.changes };
    }
    let target = null;
    let remoteError = '';
    try {
        target = probeRemoteTarget(targetConfig.server, targetConfig.appDir);
    }
    catch (error) {
        remoteError = String(error?.message || error || '远端只读探测失败').slice(0, 1000);
    }
    const blockers = collectPreviewBlockers(source, targetConfig.server, targetConfig.appDir, target, release, remoteError);
    const currentFiles = target?.release?.files || [];
    const changes = release ? summarizeReleaseChanges(release.files, currentFiles) : { added: 0, modified: 0, removed: 0, unchanged: 0, totalFiles: 0, totalBytes: 0 };
    const preview = {
        schemaVersion: 1,
        previewId,
        createdAt: Date.now(),
        expiresAt: Date.now() + PREVIEW_TTL_MS,
        startedAt: 0,
        source,
        target: {
            server: targetConfig.server,
            requestedAppDir: targetConfig.appDir,
            hostname: target?.hostname || '',
            appDir: target?.appDir || '',
            availableBytes: target?.availableBytes || 0,
            release: target?.release || null,
            releaseError: target?.releaseError || remoteError,
            lock: target?.lock || { present: false, owner: '' },
        },
        release,
        requiredBytes: release ? release.totalBytes + Math.max(DISK_SAFETY_BYTES, Math.ceil(release.totalBytes * 0.1)) : 0,
        changes,
        blockers,
    };
    writePreview(previewsDir, preview);
    return preview;
}
// Reads and structurally validates one private preview record.
function readRemoteReleasePreview(previewsDir, previewId) {
    const preview = JSON.parse(fs.readFileSync(previewFile(previewsDir, previewId), 'utf8'));
    if (preview.schemaVersion !== 1 || preview.previewId !== String(previewId) || !Number.isFinite(preview.createdAt) || !Number.isFinite(preview.expiresAt) || !Number.isFinite(preview.startedAt) || !preview.source || !preview.target || !Array.isArray(preview.blockers) || preview.blockers.some(item => typeof item !== 'string'))
        throw new Error('部署预览记录结构无效');
    if (preview.release && (!/^[a-z0-9-]+$/.test(String(preview.release.releaseId || '')) || !/^[a-f0-9]{64}$/.test(String(preview.release.manifestHash || '')) || !/^[a-f0-9]{64}$/.test(String(preview.release.contentHash || '')) || !Array.isArray(preview.release.files)))
        throw new Error('部署预览发布身份无效');
    return preview;
}
// Confirms the second remote probe still matches every frozen target identity field.
function compareRemoteBaseline(preview, target) {
    const changes = [];
    if (target.hostname !== preview.target.hostname)
        changes.push('远端主机名已变化');
    if (target.appDir !== preview.target.appDir)
        changes.push('远端应用目录已变化');
    if (target.lock.present)
        changes.push(`远端出现发布锁${target.lock.owner ? `：${target.lock.owner}` : ''}`);
    const before = preview.target.release;
    const current = target.release;
    if (!before || !current || before.releaseId !== current.releaseId || before.manifestHash !== current.manifestHash || before.contentHash !== current.contentHash)
        changes.push('远端当前发布基线已变化');
    if (target.availableBytes < preview.requiredBytes)
        changes.push('远端可用磁盘已低于预览要求');
    return changes;
}
// Enforces confirmation, expiry, single use and blocker state before side effects.
function assertPreviewCanStart(preview, confirmed, now = Date.now()) {
    if (confirmed !== true)
        throw new Error('必须确认目标主机、目录和短暂停机影响');
    if (now >= preview.expiresAt)
        throw new Error('部署预览已过期，请重新生成');
    if (preview.startedAt > 0)
        throw new Error('部署预览已经使用，请重新生成');
    if (preview.blockers.length)
        throw new Error(`部署预览存在阻止项：${preview.blockers.join('；')}`);
}
// Revalidates the source, frozen release and remote baseline before creating a task.
function validateRemoteReleasePreview(options) {
    const preview = readRemoteReleasePreview(options.previewsDir, options.previewId);
    assertPreviewCanStart(preview, options.confirmed);
    if (!preview.release)
        throw new Error('部署预览没有冻结发布物');
    if (!isPreviewReleaseDirectory(options.releasesRoot, preview.release.releaseDir, preview.release.releaseId))
        throw new Error('冻结发布目录超出允许范围');
    const source = inspectGitSource(options.repoRoot);
    if (!source.clean || source.commit !== preview.source.commit || source.repoRoot !== preview.source.repoRoot)
        throw new Error('发布源提交或工作区已变化，请重新生成预览');
    const manifest = verifyReleaseManifest(preview.release.releaseDir);
    if (manifest.releaseId !== preview.release.releaseId || manifest.commit !== preview.release.commit || manifest.manifestHash !== preview.release.manifestHash || manifest.contentHash !== preview.release.contentHash)
        throw new Error('冻结发布物已变化，请重新生成预览');
    const target = probeRemoteTarget(preview.target.server, preview.target.requestedAppDir);
    const baselineChanges = compareRemoteBaseline(preview, target);
    if (baselineChanges.length)
        throw new Error(`${baselineChanges.join('；')}，请重新生成预览`);
    preview.startedAt = Date.now();
    writePreview(options.previewsDir, preview);
    return preview;
}
// Removes private paths and full manifests before returning a preview to the browser.
function toPublicRemoteReleasePreview(preview) {
    return {
        ok: true,
        previewId: preview.previewId,
        createdAt: preview.createdAt,
        expiresAt: preview.expiresAt,
        source: { hostname: preview.source.hostname, repoRoot: preview.source.repoRoot, commit: preview.source.commit, clean: preview.source.clean, changeCount: preview.source.changes.length },
        target: {
            server: preview.target.server,
            hostname: preview.target.hostname,
            appDir: preview.target.appDir || preview.target.requestedAppDir,
            availableBytes: preview.target.availableBytes,
            release: preview.target.release ? { releaseId: preview.target.release.releaseId, commit: preview.target.release.commit, builtAt: preview.target.release.builtAt, manifestHash: preview.target.release.manifestHash, contentHash: preview.target.release.contentHash } : null,
            lock: preview.target.lock,
        },
        release: preview.release ? { releaseId: preview.release.releaseId, commit: preview.release.commit, manifestHash: preview.release.manifestHash, contentHash: preview.release.contentHash, totalBytes: preview.release.totalBytes, fileCount: preview.release.files.length } : null,
        requiredBytes: preview.requiredBytes,
        changes: preview.changes,
        blockers: preview.blockers,
        canDeploy: !!preview.release && preview.blockers.length === 0 && Date.now() < preview.expiresAt,
    };
}
module.exports = {
    PREVIEW_TTL_MS,
    DISK_SAFETY_BYTES,
    inspectGitSource,
    isAllowedBuildChange,
    buildFrozenRelease,
    describeRemoteProbeFailure,
    summarizeReleaseChanges,
    isSelfDeploy,
    collectPreviewBlockers,
    compareRemoteBaseline,
    assertPreviewCanStart,
    createRemoteReleasePreview,
    readRemoteReleasePreview,
    validateRemoteReleasePreview,
    toPublicRemoteReleasePreview,
    cleanupExpiredPreviews,
    isPreviewReleaseDirectory,
};
