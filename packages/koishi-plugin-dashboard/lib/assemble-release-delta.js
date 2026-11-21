'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
// --- 清单校验与文件复用 ---
// 使用预览中固定的摘要校验清单，再使用其中的路径和内容哈希。
function readPinnedManifest(directory, expectedHash) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
    const { manifestHash, ...body } = manifest;
    if (manifestHash !== expectedHash || crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') !== expectedHash) {
        throw new Error('发布清单与预览不符，请重新生成预览');
    }
    return manifest;
}
// 从已验证基线补齐新目录，只创建目标清单仍需要且内容相同的文件。
function copyUnchangedFiles(baseline, next, oldFiles, nextFiles) {
    const previous = new Map(oldFiles.map(file => [file.path, file]));
    for (const file of nextFiles) {
        const old = previous.get(file.path);
        if (!old || old.size !== file.size || old.sha256 !== file.sha256)
            continue;
        const source = path.resolve(baseline, file.path);
        const target = path.resolve(next, file.path);
        if (!source.startsWith(baseline + path.sep) || !target.startsWith(next + path.sep) || fs.realpathSync(source) !== source) {
            throw new Error('复用文件超出发布目录');
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // 支持写时复制的文件系统可复用磁盘块，独立文件确保后续写入不会修改回滚版本。
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    }
}
// --- 服务器组装入口 ---
// 接收 Dashboard 通过 SSH 标准输入提供的组装程序，兼容尚未安装增量工具的基线。
async function main([rootPath, releaseId, baselineHash, manifestHash, archiveHash]) {
    if (!/^[a-z0-9-]+$/.test(releaseId || '') || ![baselineHash, manifestHash, archiveHash].every(hash => /^[a-f0-9]{64}$/.test(hash || ''))) {
        throw new Error('增量发布标识无效');
    }
    const root = fs.realpathSync(rootPath);
    const current = path.join(root, 'current');
    const baseline = fs.realpathSync(current);
    const next = path.join(root, releaseId + '.next');
    if (path.dirname(baseline) !== root || baseline === next || fs.realpathSync(next) !== next)
        throw new Error('增量发布目录无效');
    const oldManifest = readPinnedManifest(baseline, baselineHash);
    if (oldManifest.releaseId !== path.basename(baseline))
        throw new Error('当前基线目录与清单不一致');
    const archive = path.join(next, '.upload.tgz');
    if (fs.readdirSync(next).length !== 1 || !fs.lstatSync(archive).isFile())
        throw new Error('增量暂存目录内容异常');
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(archive))
        digest.update(chunk);
    if (digest.digest('hex') !== archiveHash)
        throw new Error('上传的增量包校验失败');
    execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', next], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.unlinkSync(archive);
    const manifest = readPinnedManifest(next, manifestHash);
    if (manifest.releaseId !== releaseId)
        throw new Error('增量包版本与任务不一致');
    copyUnchangedFiles(baseline, next, oldManifest.files, manifest.files);
    // 在执行候选版本代码前，使用当前已验证版本的校验器核对完整文件集及前端入口。
    const { verifyReleaseManifest } = require(path.join(baseline, 'packages/koishi-plugin-dashboard/lib/release.js'));
    const verified = verifyReleaseManifest(next);
    if (verified.manifestHash !== manifestHash || fs.realpathSync(current) !== baseline)
        throw new Error('发布基线或候选版本已变化，请重新生成预览');
    console.log(JSON.stringify({ releaseId, manifestHash, files: verified.files.length }));
}
if (require.main === module || module.id === '[stdin]') {
    main(process.argv.slice(2)).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
