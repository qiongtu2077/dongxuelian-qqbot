'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { json, log, collectBody, isInsidePath, parsePositiveInt } = require('../utils');
const { requireAdmin } = require('../auth');
const { GALLERY_DIR, GALLERY_METADATA_FILE, GALLERY_MAX_BYTES, GALLERY_MIME_EXT, GALLERY_FOIL_STYLES } = require('../paths');
const MAX_GALLERY_METADATA_BYTES = parsePositiveInt(process.env.DASHBOARD_GALLERY_METADATA_MAX_BYTES, 256 * 1024, 16 * 1024, 1024 * 1024);
const MAX_GALLERY_UPLOAD_BODY_BYTES = parsePositiveInt(process.env.DASHBOARD_GALLERY_UPLOAD_BODY_MAX_BYTES, Math.ceil(GALLERY_MAX_BYTES * 1.45) + 64 * 1024, 1024 * 1024, 16 * 1024 * 1024);
function resolveGalleryId(id) {
    const value = String(id || '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(value) || value !== path.basename(value))
        throw new Error('图像 ID 无效');
    const fullPath = path.join(GALLERY_DIR, value);
    if (!isInsidePath(GALLERY_DIR, fullPath))
        throw new Error('图像路径越界');
    return fullPath;
}
function galleryMimeFromName(name) {
    const ext = path.extname(String(name || '')).toLowerCase();
    return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'application/octet-stream';
}
function normalizeGalleryStyle(value) {
    const text = String(value ?? '').trim().toUpperCase();
    if (!text || text === 'NONE' || text === 'NULL')
        return null;
    if (!GALLERY_FOIL_STYLES.has(text))
        throw new Error('闪卡样式无效');
    return text;
}
function readGalleryMetadata() {
    try {
        const stat = fs.statSync(GALLERY_METADATA_FILE);
        if (!stat.isFile() || stat.size > MAX_GALLERY_METADATA_BYTES)
            return {};
        const data = JSON.parse(fs.readFileSync(GALLERY_METADATA_FILE, 'utf8') || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }
    catch {
        return {};
    }
}
function writeGalleryMetadata(metadata) {
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
    const tmp = GALLERY_METADATA_FILE + '.tmp';
    const text = JSON.stringify(metadata || {}, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_GALLERY_METADATA_BYTES)
        throw new Error('图集元数据过大，请先清理图集');
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, GALLERY_METADATA_FILE);
}
function galleryImageUrl(fileName, stat) {
    const version = stat?.mtimeMs ? String(Math.floor(stat.mtimeMs)) : String(Date.now());
    return '/dashboard/api/gallery/image/' + encodeURIComponent(fileName) + '?v=' + version;
}
function getGalleryFoilStyle(metadata, fileName) {
    try {
        return normalizeGalleryStyle(metadata?.[fileName]?.foilStyle);
    }
    catch {
        return null;
    }
}
function toGalleryItem(fileName, metadata = null) {
    const galleryMetadata = metadata || readGalleryMetadata();
    const fullPath = resolveGalleryId(fileName);
    const stat = fs.statSync(fullPath);
    return {
        id: fileName,
        name: fileName.replace(/^\d+-[a-f0-9]+-/, ''),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mime: galleryMimeFromName(fileName),
        url: galleryImageUrl(fileName, stat),
        foilStyle: getGalleryFoilStyle(galleryMetadata, fileName),
    };
}
function validateGalleryImageMagic(buffer, mime) {
    if (mime === 'image/png' && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return true;
    if (mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.length > 3)
        return true;
    if (mime === 'image/gif' && /^(?:GIF87a|GIF89a)$/.test(buffer.slice(0, 6).toString('ascii')))
        return true;
    if (mime === 'image/webp' && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP')
        return true;
    return false;
}
function sanitizeGalleryBaseName(name) {
    const base = path.basename(String(name || 'image')).replace(/\.[^.]+$/, '');
    return (base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'image');
}
function listGalleryImages() {
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
    const metadata = readGalleryMetadata();
    let entries = [];
    try {
        entries = fs.readdirSync(GALLERY_DIR, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter(entry => entry.isFile() && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name))
        .map(entry => {
        try {
            return toGalleryItem(entry.name, metadata);
        }
        catch {
            return null;
        }
    })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function writeGalleryImage(input = {}) {
    const mime = String(input.type || '').toLowerCase();
    const ext = GALLERY_MIME_EXT[mime];
    if (!ext)
        throw new Error('只支持 PNG、JPG、WebP 或 GIF 图片');
    const raw = String(input.data || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    if (!raw)
        throw new Error('图片内容为空');
    const estimatedBytes = Math.floor(raw.replace(/\s+/g, '').length * 3 / 4);
    if (estimatedBytes > GALLERY_MAX_BYTES)
        throw new Error('图片不能超过 8MB');
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length)
        throw new Error('图片内容为空');
    if (buffer.length > GALLERY_MAX_BYTES)
        throw new Error('图片不能超过 8MB');
    if (!validateGalleryImageMagic(buffer, mime))
        throw new Error('图片格式校验失败，请上传真实的 PNG、JPG、WebP 或 GIF 图片');
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
    const safeName = sanitizeGalleryBaseName(input.name);
    const fileName = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName}.${ext}`;
    const fullPath = resolveGalleryId(fileName);
    fs.writeFileSync(fullPath, buffer);
    const written = fs.statSync(fullPath);
    if (!written.isFile() || written.size <= 0) {
        try {
            fs.unlinkSync(fullPath);
        }
        catch { /* non-critical: cleanup best effort */ }
        throw new Error('图片写入失败，请检查 data/gallery 目录权限');
    }
    const metadata = readGalleryMetadata();
    metadata[fileName] = { ...(metadata[fileName] || {}), foilStyle: null };
    writeGalleryMetadata(metadata);
    return toGalleryItem(fileName, metadata);
}
function deleteGalleryImage(id) {
    const fullPath = resolveGalleryId(id);
    if (!fs.existsSync(fullPath))
        throw new Error('图片不存在');
    fs.unlinkSync(fullPath);
    return { id };
}
function deleteGalleryImages(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const metadata = readGalleryMetadata();
    let metadataChanged = false;
    const deleted = [];
    const errors = [];
    for (const id of list) {
        try {
            deleted.push(deleteGalleryImage(id));
            if (Object.prototype.hasOwnProperty.call(metadata, id)) {
                delete metadata[id];
                metadataChanged = true;
            }
        }
        catch (e) {
            errors.push({ id, message: e.message });
        }
    }
    if (metadataChanged)
        writeGalleryMetadata(metadata);
    return { deleted, errors };
}
function updateGalleryImageStyle(id, foilStyle) {
    const fullPath = resolveGalleryId(id);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile())
        throw new Error('图片不存在');
    const metadata = readGalleryMetadata();
    metadata[id] = { ...(metadata[id] || {}), foilStyle: normalizeGalleryStyle(foilStyle) };
    writeGalleryMetadata(metadata);
    return toGalleryItem(id, metadata);
}
// --- Route Handlers ---
function handleGetGallery(req, res) {
    try {
        return json(res, { ok: true, images: listGalleryImages(), maxBytes: GALLERY_MAX_BYTES });
    }
    catch (e) {
        return json(res, { ok: false, message: e.message }, 400);
    }
}
function handlePostGallery(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const item = writeGalleryImage(JSON.parse(body || '{}'));
            return json(res, { ok: true, image: item, message: '图片已加入莲莲图集' });
        }
        catch (e) {
            return json(res, { ok: false, message: e.message }, 400);
        }
    }, { maxBytes: MAX_GALLERY_UPLOAD_BODY_BYTES });
}
function handleDeleteGallery(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { id, ids } = JSON.parse(body || '{}');
            const result = deleteGalleryImages(Array.isArray(ids) ? ids : id);
            const ok = result.errors.length === 0;
            return json(res, { ok, ...result, message: ok ? `已删除 ${result.deleted.length} 张图片` : `已删除 ${result.deleted.length} 张图片，${result.errors.length} 张删除失败` }, ok ? 200 : 400);
        }
        catch (e) {
            return json(res, { ok: false, message: e.message }, 400);
        }
    });
}
function handlePutGalleryStyle(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { id, foilStyle } = JSON.parse(body || '{}');
            const image = updateGalleryImageStyle(id, foilStyle);
            return json(res, { ok: true, image, message: '闪卡样式已保存' });
        }
        catch (e) {
            return json(res, { ok: false, message: e.message }, 400);
        }
    });
}
function handleGetGalleryImage(req, res, pathname) {
    try {
        const id = decodeURIComponent(pathname.slice('/dashboard/api/gallery/image/'.length));
        const filePath = resolveGalleryId(id);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            log('gallery image not found: ' + filePath);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Gallery image not found');
            return;
        }
        const stat = fs.statSync(filePath);
        if (stat.size > GALLERY_MAX_BYTES) {
            res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Gallery image is too large');
            return;
        }
        res.writeHead(200, { 'Content-Type': galleryMimeFromName(id), 'Cache-Control': 'public, max-age=3600' });
        fs.createReadStream(filePath).pipe(res);
    }
    catch (e) {
        log('gallery image request failed: ' + (e.message || e));
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Gallery image request failed: ' + (e.message || 'Bad Request'));
    }
}
const routes = {
    'GET /dashboard/api/gallery': handleGetGallery,
    'POST /dashboard/api/gallery': handlePostGallery,
    'DELETE /dashboard/api/gallery': handleDeleteGallery,
    'PUT /dashboard/api/gallery/style': handlePutGalleryStyle,
};
const prefixRoutes = [
    { prefix: '/dashboard/api/gallery/image/', method: 'GET', handler: handleGetGalleryImage },
];
module.exports = { routes, prefixRoutes, listGalleryImages, resolveGalleryId, galleryMimeFromName };
