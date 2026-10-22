"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGithubIssueHtml = buildGithubIssueHtml;
exports.renderGithubIssue = renderGithubIssue;
const models_1 = require("./models");
const renderer_1 = require("./renderer");
const body_content_1 = require("./body-content");
const { renderHtmlToImage } = require('../../../koishi-plugin-daily-report/lib/html-renderer');
const { readLinuxMeminfo } = require('../resource-scheduler/resource-snapshot');
// --- 固定模板 --- //
// Build the yellow/gray/white/black card with original metadata and already cleaned HTML only.
function buildGithubIssueHtml(metadata, body, avatar, note = '') {
    const kind = metadata.target.kind === 'pull' ? 'PULL REQUEST' : 'ISSUE';
    const author = metadata.author || '';
    const image = avatar ? `<img class="avatar" alt="${(0, renderer_1.escapeGithubText)(author)}" src="data:image/png;base64,${avatar.toString('base64')}">` : '<span class="avatar avatar-placeholder">GH</span>';
    const labels = (metadata.labels || []).map(label => `<span class="label"${/^[0-9a-f]{6}$/i.test(label.color) ? ` style="border-left-color:#${label.color}"` : ''}>${(0, renderer_1.escapeGithubText)(label.name)}</span>`).join('');
    const date = metadata.createdAt ? new Date(metadata.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    return (0, renderer_1.buildGithubCardFrame)(metadata, kind, `<section class="heading"><div class="eyebrow"><span>${(0, renderer_1.escapeGithubText)(metadata.target.owner + '/' + metadata.target.repo)}</span><span class="number">#${metadata.target.number}</span><span class="state">${(0, renderer_1.escapeGithubText)(metadata.state || '')}</span></div><h1>${(0, renderer_1.escapeGithubText)(metadata.title)}</h1></section>${labels ? `<div class="labels">${labels}</div>` : ''}<div class="author-row">${image}<div><div class="author">${(0, renderer_1.escapeGithubText)(author)}</div><div class="date">${(0, renderer_1.escapeGithubText)(date)} · 发起者正文</div></div></div><article class="body">${body || '<p>作者未填写正文</p>'}</article>`, note);
}
// Render through the existing browser lifecycle while preserving cancellation and memory protection.
async function renderGithubIssue(metadata, context) {
    (0, models_1.assertGithubWork)(context);
    if (typeof metadata.bodyHtml !== 'string')
        throw new Error('官方正文数据不可用');
    const available = readLinuxMeminfo().availableMb;
    if (available !== null && available < models_1.GITHUB_LIMITS.minMemoryMb)
        throw new Error('可用内存不足，改用文字信息');
    const controller = new AbortController();
    // Preserve the outer cancellation reason for downloads and the owned browser lifecycle.
    const cancelGithubIssueRender = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', cancelGithubIssueRender, { once: true });
    const work = { ...context, signal: controller.signal };
    const monitor = setInterval(() => {
        const memory = readLinuxMeminfo().availableMb;
        if (memory !== null && memory < models_1.GITHUB_LIMITS.stopMemoryMb)
            controller.abort(new Error('可用内存过低，已停止正文渲染'));
    }, 500);
    try {
        const [body, avatar] = await Promise.all([(0, body_content_1.prepareGithubBody)(metadata.bodyHtml, metadata.url, work), metadata.avatar ? (0, renderer_1.loadGithubAvatar)(metadata.avatar, work) : Promise.resolve(null)]);
        (0, models_1.assertGithubWork)(work);
        const avatarMissing = Boolean(metadata.avatar && !avatar);
        const note = [body.missing ? `正文附件未完整载入：${body.missing} 处图片未载入，请查看原文。` : '', avatarMissing ? '头像暂未载入，请查看原文。' : ''].filter(Boolean).join(' ');
        const html = buildGithubIssueHtml(metadata, body.html, avatar, note);
        if (Buffer.byteLength(html, 'utf8') > models_1.GITHUB_LIMITS.htmlBytes)
            throw new Error('正文模板超过大小限制，请查看原文');
        const raw = await renderHtmlToImage(html, { signal: work.signal, deadlineMs: work.deadline, workDeadlineMs: work.deadline, taskId: work.taskId, source: 'github-preview', networkPolicy: 'offline', captureSelector: '#github-preview' });
        const images = await (0, renderer_1.splitGithubImage)(raw, work);
        (0, models_1.assertGithubWork)(work);
        return { images, capturedAt: Date.now(), incomplete: body.missing > 0 || avatarMissing, note };
    }
    catch (error) {
        if (work.signal.aborted)
            throw work.signal.reason;
        if (Date.now() >= work.deadline)
            throw new Error('GitHub 正文渲染超时（最多30秒）');
        throw error;
    }
    finally {
        clearInterval(monitor);
        context.signal.removeEventListener('abort', cancelGithubIssueRender);
    }
}
