'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const MANIFEST_NAME = 'release-manifest.json';
const DASHBOARD_PACKAGE = 'koishi-plugin-dashboard';
const RELEASE_PACKAGES = [
    'koishi-plugin-dashboard',
    'koishi-plugin-dongxuelian-ai',
    'koishi-plugin-dongxuelian-help',
    'koishi-plugin-group-name-at',
    'koishi-plugin-defense',
    'koishi-plugin-local-video-sender',
    'koishi-plugin-group-leave-notice',
    'koishi-plugin-dongxuelian-poke',
    'koishi-plugin-pet-bridge',
    'koishi-plugin-daily-report',
];
// --- Path and hashing helpers ---
// Rejects any relative path that could escape a release root.
function assertReleaseRelativePath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').includes('..'))
        throw new Error('发布文件路径无效');
}
// Resolves a verified release-relative path under one explicit root.
function resolveReleasePath(root, relativePath) {
    assertReleaseRelativePath(relativePath);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(path.resolve(root), target);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw new Error('发布文件超出发布目录');
    return target;
}
// Calculates one file hash without loading configuration values into logs.
function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        let read = 0;
        do {
            read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (read > 0)
                hash.update(buffer.subarray(0, read));
        } while (read > 0);
    }
    finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}
// Lists every payload file in stable relative-path order, excluding the self-referential manifest.
function listReleaseFiles(root) {
    const files = [];
    // Walks one release subtree and records regular files only.
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(fullPath);
            else if (entry.isFile()) {
                const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
                if (relativePath === MANIFEST_NAME)
                    continue;
                const stat = fs.statSync(fullPath);
                files.push({ path: relativePath, size: stat.size, sha256: sha256File(fullPath) });
            }
        }
    }
    walk(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}
// Hashes the immutable manifest payload fields in a deterministic order.
function computeManifestHash(manifest) {
    return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
// Retries a same-directory Windows rename only for transient file-indexing contention.
function renameReleaseDirectory(source, target) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            fs.renameSync(source, target);
            return;
        }
        catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(code) || attempt === 9)
                throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
        }
    }
}
// --- Release assembly ---
// Copies one optional file or directory into its app-relative release location.
function copyReleaseEntry(repoRoot, releaseRoot, relativePath, required = false) {
    const source = resolveReleasePath(repoRoot, relativePath);
    const target = resolveReleasePath(releaseRoot, relativePath);
    if (!fs.existsSync(source)) {
        if (required)
            throw new Error(`发布源缺失: ${relativePath}`);
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}
// Copies only runtime and Dashboard browser sources, never project data or credentials.
function copyReleasePayload(repoRoot, releaseRoot) {
    for (const packageName of RELEASE_PACKAGES) {
        const packageRoot = `packages/${packageName}`;
        copyReleaseEntry(repoRoot, releaseRoot, `${packageRoot}/package.json`, true);
        copyReleaseEntry(repoRoot, releaseRoot, `${packageRoot}/lib`, true);
        for (const optional of ['assets', 'templates'])
            copyReleaseEntry(repoRoot, releaseRoot, `${packageRoot}/${optional}`);
    }
    const dashboardRoot = `packages/${DASHBOARD_PACKAGE}`;
    for (const file of ['index.js', 'index.d.ts', 'standalone.js', 'standalone.d.ts'])
        copyReleaseEntry(repoRoot, releaseRoot, `${dashboardRoot}/${file}`, true);
    for (const entry of ['frontend/src', 'frontend/public', 'frontend/dist', 'frontend/index.html', 'frontend/package.json', 'frontend/vite.config.ts', 'frontend/tsconfig.json'])
        copyReleaseEntry(repoRoot, releaseRoot, `${dashboardRoot}/${entry}`, true);
    for (const script of ['activate-dashboard-release.sh', 'verify-release-manifest.js', 'restart-bot.sh', 'seal-data-dir.sh', 'watchdog.sh', 'install-dashboard-service.sh', 'install-logrotate.sh'])
        copyReleaseEntry(repoRoot, releaseRoot, `scripts/${script}`, true);
    for (const packageName of RELEASE_PACKAGES) {
        const source = path.join(releaseRoot, 'packages', packageName);
        const target = path.join(releaseRoot, 'node_modules', packageName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    }
}
// Reads the current Git commit without including repository remotes or credentials.
function readCommit(repoRoot) {
    return String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}
// Creates one immutable local release directory and its complete payload manifest.
function buildDashboardRelease(repoRoot, outputRoot) {
    const root = path.resolve(repoRoot);
    const releasesRoot = path.resolve(outputRoot);
    fs.mkdirSync(releasesRoot, { recursive: true });
    const commit = readCommit(root);
    const releaseId = `${Date.now().toString(36)}-${commit.slice(0, 12)}`;
    const nextDir = path.join(releasesRoot, releaseId + '.next');
    const releaseDir = path.join(releasesRoot, releaseId);
    if (fs.existsSync(nextDir) || fs.existsSync(releaseDir))
        throw new Error('发布版本目录已存在');
    fs.mkdirSync(nextDir, { recursive: true });
    try {
        copyReleasePayload(root, nextDir);
        const version = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '');
        const files = listReleaseFiles(nextDir);
        const contentHash = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
        const manifestBase = { schemaVersion: 1, releaseId, version, commit, builtAt: new Date().toISOString(), files, contentHash };
        const manifest = { ...manifestBase, manifestHash: computeManifestHash(manifestBase) };
        fs.writeFileSync(path.join(nextDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
        verifyReleaseManifest(nextDir);
        renameReleaseDirectory(nextDir, releaseDir);
        return { releaseDir, manifestPath: path.join(releaseDir, MANIFEST_NAME), manifest };
    }
    catch (error) {
        try {
            fs.rmSync(nextDir, { recursive: true, force: true });
        }
        catch { /* preserve the original build error */ }
        throw error;
    }
}
// --- Release verification ---
// Confirms that browser entry assets resolve inside the release and appear in the manifest.
function verifyBrowserAssets(releaseRoot, manifest) {
    const indexRelative = `packages/${DASHBOARD_PACKAGE}/frontend/dist/index.html`;
    const indexPath = resolveReleasePath(releaseRoot, indexRelative);
    const html = fs.readFileSync(indexPath, 'utf8');
    const listed = new Set(manifest.files.map(item => item.path));
    const assetReferences = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]).filter(value => !/^(?:https?:|data:|#)/i.test(value));
    for (const reference of assetReferences) {
        const cleanReference = reference.split(/[?#]/, 1)[0];
        const assetPath = cleanReference.startsWith('/dashboard/')
            ? cleanReference.slice('/dashboard/'.length)
            : cleanReference.replace(/^\.\//, '');
        if (cleanReference.startsWith('/') && !cleanReference.startsWith('/dashboard/'))
            throw new Error(`浏览器入口引用超出 Dashboard 路径: ${reference}`);
        const relativeAsset = path.posix.normalize(path.posix.join(path.posix.dirname(indexRelative), assetPath));
        assertReleaseRelativePath(relativeAsset);
        if (!fs.existsSync(resolveReleasePath(releaseRoot, relativeAsset)) || !listed.has(relativeAsset))
            throw new Error(`浏览器入口引用未进入发布清单: ${reference}`);
    }
}
// Verifies the manifest hash, exact payload file set, sizes, hashes, and browser entry references.
function verifyReleaseManifest(releaseRoot) {
    const root = path.resolve(releaseRoot);
    const manifestPath = path.join(root, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || !manifest.releaseId || !manifest.commit || !manifest.contentHash || !Array.isArray(manifest.files))
        throw new Error('发布清单结构无效');
    const { manifestHash, ...manifestBase } = manifest;
    if (computeManifestHash(manifestBase) !== manifestHash)
        throw new Error('发布清单哈希不一致');
    const actualFiles = listReleaseFiles(root);
    if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files))
        throw new Error('发布物文件清单不一致');
    if (crypto.createHash('sha256').update(JSON.stringify(actualFiles)).digest('hex') !== manifest.contentHash)
        throw new Error('发布内容哈希不一致');
    verifyBrowserAssets(root, manifest);
    return manifest;
}
module.exports = {
    MANIFEST_NAME,
    RELEASE_PACKAGES,
    buildDashboardRelease,
    verifyReleaseManifest,
    verifyBrowserAssets,
};
