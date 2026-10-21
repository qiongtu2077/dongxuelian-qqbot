"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeGithubText = escapeGithubText;
exports.loadGithubAvatar = loadGithubAvatar;
exports.buildGithubCardHtml = buildGithubCardHtml;
exports.renderGithubCard = renderGithubCard;
exports.githubTextFallback = githubTextFallback;
const models_1 = require("./models");
const sharp = require('sharp');
const { renderHtmlToImage } = require('../../../koishi-plugin-daily-report/lib/html-renderer');
const avatarCache = new Map();
// Escape all official strings before inserting into fixed template text slots.
function escapeGithubText(value) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
// Read and resample a bounded public avatar without ever forwarding API credentials.
async function loadGithubAvatar(raw, context, transport = fetch) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    if (url.origin !== 'https://avatars.githubusercontent.com' || url.username || url.password)
        return null;
    const cached = avatarCache.get(url.href);
    if (cached && Date.now() - cached.capturedAt < 86400000)
        return cached.image;
    const controller = new AbortController();
    const cancelGithubAvatarRequest = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', cancelGithubAvatarRequest, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(3000, context.deadline - Date.now())));
    try {
        (0, models_1.assertGithubWork)(context);
        const response = await transport(url, { redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body)
            return null;
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done)
                    break;
                bytes += part.value.length;
                if (bytes > 2 * 1024 * 1024)
                    return null;
                chunks.push(part.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        const image = await sharp(Buffer.concat(chunks), { limitInputPixels: 4000000, animated: false }).resize(64, 64).png().toBuffer();
        (0, models_1.assertGithubWork)(context);
        avatarCache.set(url.href, { image, capturedAt: Date.now() });
        while (avatarCache.size > 100 || [...avatarCache.values()].reduce((sum, entry) => sum + entry.image.length, 0) > 10 * 1024 * 1024)
            avatarCache.delete(avatarCache.keys().next().value);
        return image;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', cancelGithubAvatarRequest);
    }
}
// --- 固定卡片与文字降级 --- //
// Render original descriptions and verified metadata; there is no summary/model branch.
function buildGithubCardHtml(metadata, avatar) {
    const esc = escapeGithubText;
    const description = metadata.description || '未提供公开简介';
    const truncated = description.length > 600;
    const image = avatar ? `<img src="data:image/png;base64,${avatar.toString('base64')}" alt="头像">` : '<span class="avatar">GH</span>';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:28px;background:#edf2f8;color:#172337;font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif}main{background:white;border-radius:22px;overflow:hidden}header{padding:25px 30px;background:#172337;color:white;font-size:22px;font-weight:700}article{padding:30px}h1{font-size:34px;margin:0 0 25px;overflow-wrap:anywhere}img,.avatar{width:64px;height:64px;border-radius:50%;object-fit:cover;float:right;margin-left:20px}.avatar{background:#edf2f8;padding-top:17px;text-align:center;font-size:22px}.description{font-size:23px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:200px 1fr;font-size:21px;line-height:1.8}dt{color:#6d7890}dd{margin:0;overflow-wrap:anywhere}footer{border-top:1px solid #e5eaf2;padding-top:20px;color:#6d7890;font-size:17px;overflow-wrap:anywhere}.url{font-size:19px;color:#526c99;margin-bottom:15px}</style></head><body><main><header>GitHub ${metadata.target.kind === 'repository' ? '项目' : '用户'}</header><article>${image}<h1>${esc(metadata.title)}</h1><div class="description">${esc(description.slice(0, 600))}${truncated ? '…（原文已截断，请查看来源）' : ''}</div><dl>${metadata.facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl><footer><div class="url">${esc(metadata.url)}</div>官方公开数据 · 获取于 ${esc(new Date(metadata.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}（北京时间）</footer></article></main></body></html>`;
}
// Render repository/user cards through the existing protected template renderer.
async function renderGithubCard(metadata, context) {
    (0, models_1.assertGithubWork)(context);
    const avatar = metadata.avatar ? await loadGithubAvatar(metadata.avatar, context) : null;
    (0, models_1.assertGithubWork)(context);
    const image = await renderHtmlToImage(buildGithubCardHtml(metadata, avatar), { signal: context.signal, deadlineMs: context.deadline, workDeadlineMs: context.deadline, taskId: context.taskId, source: 'github-preview' });
    return { images: [image], capturedAt: Date.now() };
}
// A readable official-field fallback never invents an answer or exposes response bodies.
function githubTextFallback(metadata) {
    return [metadata.title, metadata.state ? `${metadata.target.owner}/${metadata.target.repo} #${metadata.target.number} · ${metadata.state}` : '', metadata.description || '', ...metadata.facts.map(([label, value]) => `${label}：${value}`), metadata.url].filter(Boolean).join('\n');
}
