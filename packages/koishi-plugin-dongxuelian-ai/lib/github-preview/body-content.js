"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanGithubBody = cleanGithubBody;
exports.isGithubBodyImageUrl = isGithubBodyImageUrl;
exports.prepareGithubBody = prepareGithubBody;
/**
 * MODULE: 官方正文与附件。
 * 职责: 复用白名单解析器清理正文，并将有界公开附件转为本地图片。
 * 边界: 不启动浏览器、不持有长期缓存，不向附件转发接口认证。
 */
const xss = __importStar(require("xss"));
const models_1 = require("./models");
const renderer_1 = require("./renderer");
const sharp = require('sharp');
const { validatePublicHttpUrl, resolveAndValidateHostname } = require('../core/utils');
const IMAGE_HOSTS = new Set(['private-user-images.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'avatars.githubusercontent.com', 'github-production-user-asset-6210df.s3.amazonaws.com']);
// --- 正文结构 --- //
// Decode attributes with the existing parser rather than interpreting HTML with regular expressions.
function tagAttributes(tag, html) {
    const result = Object.create(null);
    xss.parseAttr(html.slice(tag.length + 1, -1), (name, value) => { result[name] = xss.friendlyAttrValue(value); return ''; });
    return result;
}
// Preserve original text/GFM structure while replacing image nodes with trusted placeholders.
function cleanGithubBody(raw, base) {
    const images = [];
    const whiteList = {};
    for (const tag of ['p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'b', 'em', 'i', 'del', 's', 'sub', 'sup', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'summary', 'details', 'a', 'kbd'])
        whiteList[tag] = [];
    whiteList.a = ['href', 'title'];
    whiteList.ol = ['start'];
    whiteList.td = ['colspan', 'rowspan'];
    whiteList.th = ['colspan', 'rowspan'];
    const html = new xss.FilterXSS({
        whiteList, stripIgnoreTag: true, stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed'],
        onTag(tag, source, options) {
            if (tag === 'details' && !options.isClosing)
                return '<details open>';
            if (tag === 'img' && !options.isClosing) {
                const attributes = tagAttributes(tag, source);
                images.push({ url: attributes.src || '', alt: attributes.alt || '正文图片' });
                return `<!--github-asset:${images.length - 1}-->`;
            }
            if (tag === 'input' && !options.isClosing) {
                const attributes = tagAttributes(tag, source);
                return attributes.type === 'checkbox' ? `<span class="task-check">${Object.hasOwnProperty.call(attributes, 'checked') ? '☑' : '☐'}</span>` : '';
            }
            if ((tag === 'video' || tag === 'audio') && !options.isClosing)
                return '<span class="attachment-note">［媒体附件请查看原文］</span>';
        },
        onTagAttr(tag, name, value) {
            if (name === 'href') {
                try {
                    const url = new URL(value, base);
                    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? `href="${(0, renderer_1.escapeGithubText)(url.href)}"` : '';
                }
                catch {
                    return '';
                }
            }
            if (['start', 'colspan', 'rowspan'].includes(name))
                return /^\d{1,3}$/.test(value) ? `${name}="${value}"` : '';
        },
    }).process(raw);
    return { html, images };
}
// --- 有界附件下载 --- //
// DNS cannot be cancelled by Node; bound its wait while all actual HTTP work receives the signal.
async function waitBodySignal(pending, signal) {
    signal.throwIfAborted();
    let abort;
    try {
        return await Promise.race([pending, new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            })]);
    }
    finally {
        if (abort)
            signal.removeEventListener('abort', abort);
    }
}
// Match observed platform image origins; arbitrary public sites and asset pages are not fetched.
function isGithubBodyImageUrl(raw) {
    try {
        const url = validatePublicHttpUrl(raw);
        return url.protocol === 'https:' && !url.port && (IMAGE_HOSTS.has(url.hostname) || (url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/assets/')));
    }
    catch {
        return false;
    }
}
// Fetch one image with validated redirects and streamed byte limits, then decode and resample it.
async function fetchBodyImage(raw, signal, budget, transport, resolve) {
    let url = raw;
    for (let hop = 0; hop <= 3; hop++) {
        signal.throwIfAborted();
        if (!isGithubBodyImageUrl(url))
            throw new Error('附件来源不受支持');
        await waitBodySignal(resolve(url), signal);
        signal.throwIfAborted();
        const response = await transport(url, { redirect: 'manual', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = new URL(response.headers.get('location') || '', url).href;
            continue;
        }
        if (!response.ok || !response.body || !/^image\//i.test(response.headers.get('content-type') || '')) {
            await response.body?.cancel();
            throw new Error('附件不是可用图片');
        }
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done)
                    break;
                signal.throwIfAborted();
                bytes += part.value.length;
                budget.bytes += part.value.length;
                if (bytes > 2 * 1024 * 1024 || budget.bytes > 8 * 1024 * 1024)
                    throw new Error('附件超过大小限制');
                chunks.push(part.value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        const source = Buffer.concat(chunks);
        const metadata = await sharp(source, { limitInputPixels: 4000000, animated: false }).metadata();
        if (!['png', 'jpeg', 'webp', 'gif', 'heif'].includes(metadata.format || ''))
            throw new Error('附件图片格式不受支持');
        signal.throwIfAborted();
        const buffer = await sharp(source, { limitInputPixels: 4000000, animated: false }).resize({ width: 776, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        signal.throwIfAborted();
        return { data: 'data:image/webp;base64,' + buffer.toString('base64'), animated: (metadata.pages || 1) > 1 };
    }
    throw new Error('附件跳转次数过多');
}
// Download at most eight unique images with two workers and one shared bounded asset budget.
async function prepareGithubBody(raw, base, context, transport = fetch, resolve = resolveAndValidateHostname) {
    (0, models_1.assertGithubWork)(context);
    const clean = cleanGithubBody(raw, base);
    const urls = [...new Set(clean.images.map(image => image.url))].filter(isGithubBodyImageUrl).slice(0, 8);
    const assets = new Map();
    const controller = new AbortController(), budget = { bytes: 0 };
    const cancel = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', cancel, { once: true });
    const remaining = Math.min(models_1.GITHUB_LIMITS.assetMs, context.deadline - Date.now() - models_1.GITHUB_LIMITS.captureMs);
    const timer = setTimeout(() => controller.abort(new Error('附件下载到期')), Math.max(0, remaining));
    let next = 0;
    // Workers share the total byte counter; failures preserve their original positions as placeholders.
    const worker = async () => {
        while (next < urls.length && !controller.signal.aborted && remaining > 0) {
            const url = urls[next++];
            try {
                assets.set(url, await fetchBodyImage(url, controller.signal, budget, transport, resolve));
            }
            catch (error) {
                const known = ['附件来源不受支持', '附件不是可用图片', '附件超过大小限制', '附件图片格式不受支持', '附件跳转次数过多'];
                const reason = controller.signal.aborted ? '附件下载到期或取消' : error instanceof Error && known.includes(error.message) ? error.message : '附件网络或解码失败';
                console.warn(`github-preview asset_failed index=${urls.indexOf(url)} reason=${reason}`);
            }
        }
    };
    try {
        await Promise.all([worker(), worker()]);
    }
    finally {
        clearTimeout(timer);
        controller.abort();
        context.signal.removeEventListener('abort', cancel);
    }
    (0, models_1.assertGithubWork)(context);
    let missing = 0, animations = 0, embeddedBytes = Buffer.byteLength(clean.html, 'utf8');
    const html = clean.html.replace(/<!--github-asset:(\d+)-->/g, (_marker, index) => {
        const image = clean.images[Number(index)], asset = assets.get(image.url);
        // Leave room for the fixed header/footer and avatar inside the shared renderer's HTML cap.
        if (asset && embeddedBytes + asset.data.length < models_1.GITHUB_LIMITS.htmlBytes - 48 * 1024) {
            embeddedBytes += asset.data.length;
            if (asset.animated)
                animations++;
            return `<figure><img alt="${(0, renderer_1.escapeGithubText)(image.alt)}" src="${asset.data}">${asset.animated ? '<figcaption>动画首帧；完整内容请查看原文</figcaption>' : ''}</figure>`;
        }
        missing++;
        return `<span class="image-missing">图片未载入，请查看原文 · ${(0, renderer_1.escapeGithubText)(image.alt)}</span>`;
    });
    return { html, missing, animations };
}
