"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildGithubIssueHtml = buildGithubIssueHtml;
exports.splitGithubImage = splitGithubImage;
exports.renderGithubIssue = renderGithubIssue;
const models_1 = require("./models");
const renderer_1 = require("./renderer");
const body_content_1 = require("./body-content");
const sharp = require('sharp');
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
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
  *{box-sizing:border-box}body{margin:0;background:white;color:#1c1d1f;font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif}
  #github-preview{width:880px;background:#fafaf7;border:1px solid #26282a}.masthead{background:#202224;color:#f7f7f0;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:7px solid #f5d531;font:700 15px monospace;letter-spacing:2px}.masthead b{color:#f5d531;font-size:21px}.marks{color:#9da19f;letter-spacing:5px}
  .heading{padding:28px 30px 22px}.eyebrow{display:flex;gap:12px;align-items:center;font:700 16px monospace;color:#656865;margin-bottom:17px}.number{background:#f5d531;color:#18191b;padding:5px 11px}.state{border:1px solid #9b9e97;padding:4px 10px;font:600 15px sans-serif}h1{font-size:30px;line-height:1.4;margin:0;overflow-wrap:anywhere;letter-spacing:.2px}
  .author-row{display:flex;gap:13px;align-items:center;padding:16px 30px;background:#e8e9e3;border-top:1px solid #c8cac2;border-bottom:1px solid #c8cac2}.avatar{width:48px;height:48px;object-fit:cover;border-radius:2px}.avatar-placeholder{display:grid;place-items:center;background:#2a2d2d;color:#f5d531;font:700 18px monospace}.author{font-size:18px;font-weight:700;overflow-wrap:anywhere}.date{font-size:13px;color:#676c67;margin-top:5px}.labels{display:flex;gap:8px;flex-wrap:wrap;padding:0 30px 20px}.label{background:#e8e9e3;border:1px solid #d2d4cc;border-left:5px solid #757970;padding:5px 9px;font-size:13px;overflow-wrap:anywhere;max-width:100%}
  .body{padding:10px 30px 24px;font-size:19px;line-height:1.75;overflow-wrap:anywhere}.body>:first-child{margin-top:15px}.body h1,.body h2,.body h3{font-size:23px;margin:26px 0 12px;padding-bottom:6px;border-bottom:1px solid #d9dbd2}.body h4,.body h5,.body h6{font-size:20px;margin:22px 0 10px}.body p{margin:13px 0}.body a{color:#555d4f;text-decoration:underline;text-underline-offset:3px}.body blockquote{margin:16px 0;border-left:4px solid #e6c72e;background:#efefe8;padding:8px 18px;color:#50554e}.body ul,.body ol{padding-left:28px}.body pre{padding:16px;background:#e9eae4;border:1px solid #d3d5cc;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;line-height:1.55;font-size:14px}.body code,.body kbd{font-family:Consolas,monospace;font-size:.88em;background:#e9eae4;padding:2px 4px}.body pre code{padding:0;background:none}.body table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:15px}.body th,.body td{border:1px solid #bfc3b8;padding:8px;overflow-wrap:anywhere}.body th{background:#e5e7dc}.body figure{margin:16px 0}.body img{display:block;max-width:100%;height:auto;border:1px solid #d5d8ce}.body figcaption{font-size:13px;color:#676c67}.body details{border-left:2px solid #c1c5b8;padding-left:14px}.body summary{font-weight:700}.task-check{color:#626b42;margin-right:5px}.image-missing,.attachment-note{display:block;padding:12px 15px;background:#f1edcf;border-left:3px solid #d1b72d;font-size:15px;color:#655c37;margin:12px 0}
  footer{padding:17px 30px 20px;border-top:1px solid #c7cabf;background:#e9eae4;font-size:12px;color:#61665e;line-height:1.8;overflow-wrap:anywhere}.source{font-family:Consolas,monospace;color:#363c33;font-size:13px}.warning{color:#776220;font-weight:700}.footer-row{display:flex;justify-content:space-between;gap:15px}.slash{color:#959a8c;letter-spacing:3px}
  </style></head><body><main id="github-preview"><div class="masthead"><b>GITHUB / ${kind}</b><span class="marks">// PUBLIC RECORD</span></div><section class="heading"><div class="eyebrow"><span>${(0, renderer_1.escapeGithubText)(metadata.target.owner + '/' + metadata.target.repo)}</span><span class="number">#${metadata.target.number}</span><span class="state">${(0, renderer_1.escapeGithubText)(metadata.state || '')}</span></div><h1>${(0, renderer_1.escapeGithubText)(metadata.title)}</h1></section>${labels ? `<div class="labels">${labels}</div>` : ''}<div class="author-row">${image}<div><div class="author">${(0, renderer_1.escapeGithubText)(author)}</div><div class="date">${(0, renderer_1.escapeGithubText)(date)} · 发起者正文</div></div></div><article class="body">${body || '<p>作者未填写正文</p>'}</article><footer>${note ? `<div class="warning">${(0, renderer_1.escapeGithubText)(note)}</div>` : ''}<div class="source">${(0, renderer_1.escapeGithubText)(metadata.url)}</div><div class="footer-row"><span>官方公开原文 · ${(0, renderer_1.escapeGithubText)(new Date(metadata.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}（北京时间）</span><span class="slash">/////</span></div></footer></main></body></html>`;
}
// Split continuous rendered pixels and apply the existing white margins and output limits.
async function splitGithubImage(raw, context) {
    (0, models_1.assertGithubWork)(context);
    const { width, height } = await sharp(raw).metadata();
    if (!width || !height)
        throw new Error('正文图片尺寸无效');
    const count = Math.ceil(height / (models_1.GITHUB_LIMITS.imageHeight - models_1.GITHUB_LIMITS.padding * 2));
    if (count > models_1.GITHUB_LIMITS.maxImages)
        throw new Error('正文过长，请查看原文');
    const sliceHeight = Math.ceil(height / count), images = [];
    let bytes = 0;
    for (let top = 0; top < height; top += sliceHeight) {
        (0, models_1.assertGithubWork)(context);
        const image = await sharp(raw).extract({ left: 0, top, width, height: Math.min(sliceHeight, height - top) }).extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#fff' }).png().toBuffer();
        (0, models_1.assertGithubWork)(context);
        bytes += image.length;
        if (bytes > models_1.GITHUB_LIMITS.imageBytes)
            throw new Error('正文图片超过大小限制，请查看原文');
        images.push(image);
    }
    return images;
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
        const note = body.missing ? `正文附件未完整载入：${body.missing} 处图片未载入，请查看原文。` : '';
        const html = buildGithubIssueHtml(metadata, body.html, avatar, note);
        if (Buffer.byteLength(html, 'utf8') > models_1.GITHUB_LIMITS.htmlBytes)
            throw new Error('正文模板超过大小限制，请查看原文');
        const raw = await renderHtmlToImage(html, { signal: work.signal, deadlineMs: work.deadline, workDeadlineMs: work.deadline, taskId: work.taskId, source: 'github-preview', networkPolicy: 'offline', captureSelector: '#github-preview' });
        const images = await splitGithubImage(raw, work);
        (0, models_1.assertGithubWork)(work);
        return { images, capturedAt: Date.now(), incomplete: body.missing > 0, note };
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
