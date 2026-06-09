"use strict";
/**
 * MODULE: 复读检测。
 * 状态: channelRepeatState（按 channelKey 索引）。
 * 边界: 不调 AI API，不改 conversation，只存当前复读组指纹。
 */
const fs = require('fs');
const { REPEAT_ENABLED_FILE } = require('../core/constants');
const { normalizeText, getSegmentData, getSessionMessageSegments, writeJsonFileSync } = require('../core/utils');
const { extractAttrValue, extractCqAttrValue, } = require('../message/message-segment');
const REPEAT_MATCH_WINDOW_MS = 120000;
const MAX_REPEAT_CONFIG_BYTES = 128 * 1024;
const MAX_REPEAT_STATE_SIZE = 5000;
const channelRepeatState = new Map();
let repeatEnabledCache = {};
function loadRepeatConfig() {
    try {
        const stat = fs.statSync(REPEAT_ENABLED_FILE);
        if (!stat.isFile() || stat.size > MAX_REPEAT_CONFIG_BYTES)
            throw new Error('repeat config too large');
        repeatEnabledCache = JSON.parse(fs.readFileSync(REPEAT_ENABLED_FILE, 'utf8'));
    }
    catch { /* non-critical: missing repeat config disables repeat until configured */
        repeatEnabledCache = {};
    }
}
function getRepeatEnabledCache() {
    return repeatEnabledCache;
}
function clearRepeatState(channelKey) {
    const key = String(channelKey);
    channelRepeatState.delete(key);
}
function pruneRepeatState(now = Date.now()) {
    for (const [key, state] of channelRepeatState) {
        if (!state || now - (state.ts || 0) > REPEAT_MATCH_WINDOW_MS)
            channelRepeatState.delete(key);
    }
    if (channelRepeatState.size <= MAX_REPEAT_STATE_SIZE)
        return;
    const ordered = Array.from(channelRepeatState.entries())
        .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const overflow = channelRepeatState.size - MAX_REPEAT_STATE_SIZE;
    for (let i = 0; i < overflow; i++)
        channelRepeatState.delete(ordered[i][0]);
}
function getRepeatStateSize() {
    return channelRepeatState.size;
}
function setRepeatEnabled(channelKey, enabled) {
    const key = String(channelKey);
    repeatEnabledCache[key] = enabled;
    clearRepeatState(key);
    writeJsonFileSync(REPEAT_ENABLED_FILE, repeatEnabledCache);
}
function extractStructuredFaceIds(session) {
    const segments = getSessionMessageSegments(session);
    if (!segments.length)
        return null;
    const ids = [];
    for (const segment of segments) {
        const type = String(segment?.type || '').toLowerCase();
        const data = getSegmentData(segment);
        if (type === 'text') {
            const dataRecord = data;
            const text = dataRecord.text ?? dataRecord.content ?? '';
            if (!normalizeText(String(text)))
                continue;
            return null;
        }
        // @ 段不属于复读内容。主流程已过滤 @bot 和提及他人的消息。
        if (type === 'at')
            continue;
        if (type === 'face') {
            const dataRecord = data;
            const id = String(dataRecord.id ?? dataRecord.qq ?? dataRecord.face_id ?? dataRecord.faceId ?? '').trim();
            if (!/^\d+$/.test(id))
                return null;
            ids.push(id);
            continue;
        }
        return null;
    }
    return ids.length ? ids : null;
}
function extractContentFaceIds(content = '') {
    const value = String(content || '');
    if (!value.trim())
        return null;
    const ids = [];
    const tokenRe = /(\[CQ:face,[^\]]*?\bid=(\d+)[^\]]*\])|(<face\b[^>]*?\bid="(\d+)"[^>]*\/?>)/gi;
    const remainder = value.replace(tokenRe, (_token, cqToken, cqId, htmlToken, htmlId) => {
        ids.push(cqId || htmlId);
        return '';
    });
    return ids.length && !remainder.trim() ? ids : null;
}
function normalizeMfaceData(data) {
    const emojiId = String(data.emoji_id ?? data.emojiId ?? data.id ?? '').trim();
    if (!/^\d+$/.test(emojiId))
        return null;
    const emojiPackageId = String(data.emoji_package_id ?? data.emojiPackageId ?? data.package_id ?? data.packageId ?? '').trim();
    const key = String(data.key ?? data.file ?? '').trim();
    const summary = String(data.summary ?? data.text ?? data.name ?? '').trim();
    const normalized = { emoji_id: emojiId };
    if (/^\d+$/.test(emojiPackageId))
        normalized.emoji_package_id = emojiPackageId;
    if (key)
        normalized.key = key;
    if (summary)
        normalized.summary = summary;
    return normalized;
}
function inspectStructuredMfaceSegments(session) {
    const segments = getSessionMessageSegments(session);
    if (!segments.length)
        return { segments: null, invalidPure: false };
    const mfaces = [];
    for (const segment of segments) {
        const type = String(segment?.type || '').toLowerCase();
        const data = getSegmentData(segment);
        if (type === 'text') {
            const text = data.text ?? data.content ?? '';
            if (!normalizeText(String(text)))
                continue;
            return { segments: null, invalidPure: false };
        }
        if (type === 'at')
            continue;
        if (type === 'mface') {
            const normalized = normalizeMfaceData(data);
            if (!normalized)
                return { segments: null, invalidPure: true };
            mfaces.push({ type: 'mface', data: normalized });
            continue;
        }
        return { segments: null, invalidPure: false };
    }
    return { segments: mfaces.length ? mfaces : null, invalidPure: false };
}
function inspectContentMfaceSegments(content = '') {
    const value = String(content || '');
    if (!value.trim())
        return { segments: null, invalidPure: false };
    const segments = [];
    let invalidPure = false;
    const tokenRe = /\[CQ:mface,([^\]]+)\]|(<mface\b[^>]*\/?>)/gi;
    const remainder = value.replace(tokenRe, (_token, cqBody, htmlToken) => {
        const normalized = normalizeMfaceData({
            emoji_package_id: cqBody ? extractCqAttrValue(cqBody, 'emoji_package_id') : extractAttrValue(htmlToken, 'emoji_package_id'),
            emoji_id: cqBody ? extractCqAttrValue(cqBody, 'emoji_id') : extractAttrValue(htmlToken, 'emoji_id'),
            key: cqBody ? extractCqAttrValue(cqBody, 'key') : extractAttrValue(htmlToken, 'key'),
            summary: cqBody ? extractCqAttrValue(cqBody, 'summary') : extractAttrValue(htmlToken, 'summary'),
        });
        if (!normalized)
            invalidPure = true;
        else
            segments.push({ type: 'mface', data: normalized });
        return '';
    });
    if (remainder.trim())
        return { segments: null, invalidPure: false };
    if (segments.length)
        return invalidPure ? { segments: null, invalidPure: true } : { segments, invalidPure: false };
    return { segments: null, invalidPure, };
}
function buildFaceRepeatCandidate(faceIds) {
    const ids = faceIds.map(id => String(id));
    return {
        key: ids.map(id => `face:${id}`).join('|'),
        reply: ids.map(id => `<face id="${id}"/>`).join(''),
        kind: 'face',
        supported: true,
    };
}
function buildMfaceRepeatCandidate(message) {
    return {
        key: message.map(item => `mface:${item.data.emoji_id}`).join('|'),
        reply: '【QQ表情包】',
        kind: 'mface',
        supported: true,
        payload: {
            type: 'mface',
            message,
        },
    };
}
function buildUnsupportedRepeatCandidate(reason) {
    return {
        key: '',
        reply: '',
        kind: 'unsupported',
        supported: false,
        reason,
    };
}
function buildRepeatCandidate(session, plain, analyzed = {}) {
    const structuredFaceIds = extractStructuredFaceIds(session);
    if (structuredFaceIds)
        return buildFaceRepeatCandidate(structuredFaceIds);
    const contentFaceIds = extractContentFaceIds(session?.content || '');
    if (contentFaceIds)
        return buildFaceRepeatCandidate(contentFaceIds);
    const structuredMface = inspectStructuredMfaceSegments(session);
    if (structuredMface.segments)
        return buildMfaceRepeatCandidate(structuredMface.segments);
    if (structuredMface.invalidPure)
        return buildUnsupportedRepeatCandidate('mface');
    const contentMface = inspectContentMfaceSegments(session?.content || '');
    if (contentMface.segments)
        return buildMfaceRepeatCandidate(contentMface.segments);
    if (contentMface.invalidPure)
        return buildUnsupportedRepeatCandidate('mface');
    if (analyzed.hasFile)
        return buildUnsupportedRepeatCandidate('file');
    if (analyzed.hasEmbed || analyzed.hasMessageRecordCue)
        return buildUnsupportedRepeatCandidate('embed');
    if (analyzed.hasVisual)
        return buildUnsupportedRepeatCandidate('visual');
    const text = normalizeText(String(plain || '')).trim();
    if (!text)
        return buildUnsupportedRepeatCandidate('empty');
    return {
        key: `text:${text}`,
        reply: text,
        kind: 'text',
        supported: true,
    };
}
function checkGroupRepeat(session, candidate, channelKey, currentUserId, now = Date.now()) {
    if (session.isDirect)
        return null;
    if (!repeatEnabledCache[channelKey])
        return null;
    pruneRepeatState(now);
    if (!candidate || !candidate.supported || !candidate.key || !candidate.reply) {
        channelRepeatState.delete(channelKey);
        return null;
    }
    const last = channelRepeatState.get(channelKey);
    const startsNewGroup = !last || last.key !== candidate.key || now - last.ts > REPEAT_MATCH_WINDOW_MS;
    if (startsNewGroup) {
        channelRepeatState.set(channelKey, {
            key: candidate.key,
            reply: candidate.reply,
            kind: candidate.kind,
            userId: currentUserId,
            ts: now,
            fired: false,
        });
        return null;
    }
    const nextState = {
        key: candidate.key,
        reply: candidate.reply,
        kind: candidate.kind,
        userId: currentUserId,
        ts: now,
        fired: !!last.fired,
    };
    if (!last.fired &&
        last.userId !== currentUserId &&
        now - last.ts <= REPEAT_MATCH_WINDOW_MS) {
        nextState.fired = true;
        channelRepeatState.set(channelKey, nextState);
        return candidate;
    }
    channelRepeatState.set(channelKey, nextState);
    return null;
}
module.exports = {
    loadRepeatConfig,
    setRepeatEnabled,
    getRepeatEnabledCache,
    clearRepeatState,
    pruneRepeatState,
    getRepeatStateSize,
    buildRepeatCandidate,
    checkGroupRepeat,
};
