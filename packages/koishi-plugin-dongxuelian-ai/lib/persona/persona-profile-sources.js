"use strict";
/**
 * MODULE: Persona profile source readers.
 * Responsibility: Read legacy persona profile source files through sanitized paths.
 * Boundary: Does not build persona blocks, select prompt facts, or write diagnostics.
 */
const fsp = require('fs/promises');
const path = require('path');
const { USER_PROFILE_DIR } = require('../core/constants');
const MAX_PROFILE_SOURCE_FILE_BYTES = 512 * 1024;
function sanitizePersonaProfileKey(value = '') {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}
function safePersonaProfileFile(userId, channelKey, rootDir = USER_PROFILE_DIR) {
    const safeChannel = sanitizePersonaProfileKey(channelKey);
    const safeUser = sanitizePersonaProfileKey(userId);
    return path.join(rootDir, safeChannel, `${safeUser}.json`);
}
async function readLegacyPersonaProfileData({ userId, channelKey, rootDir = USER_PROFILE_DIR } = {}) {
    try {
        const normalizedUserId = String(userId || '');
        const normalizedChannelKey = String(channelKey || '');
        const file = safePersonaProfileFile(normalizedUserId, normalizedChannelKey, rootDir);
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > MAX_PROFILE_SOURCE_FILE_BYTES)
            return null;
        const data = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
        return data && typeof data === 'object' ? data : null;
    }
    catch { /* non-critical: missing/oversized/invalid legacy profile reads as no profile data */
        return null;
    }
}
module.exports = {
    MAX_PROFILE_SOURCE_FILE_BYTES,
    sanitizePersonaProfileKey,
    safePersonaProfileFile,
    readLegacyPersonaProfileData,
};
