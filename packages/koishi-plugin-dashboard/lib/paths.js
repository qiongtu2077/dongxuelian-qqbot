'use strict';
const path = require('path');
const { isInsidePath } = require('./utils');
const PLUGIN_ROOT = path.join(__dirname, '..');
const AI_LIB = path.join(PLUGIN_ROOT, '..', 'koishi-plugin-dongxuelian-ai', 'lib');
const KOISHI_DIR = path.resolve(process.env.KOISHI_DIR || process.env.KOISHI_APP_DIR || path.join(PLUGIN_ROOT, '..', '..'));
const KOISHI_PID_FILE = path.join(path.resolve(KOISHI_DIR), 'koishi.pid');
function resolveRuntimeDataDir() {
    const configured = String(process.env.DONGXUELIAN_AI_DATA_DIR || '').trim();
    if (configured)
        return path.resolve(configured);
    return path.resolve(KOISHI_DIR, 'data');
}
const DATA_DIR = resolveRuntimeDataDir();
const PERSONAS_DIR = path.join(DATA_DIR, 'ai-skills', 'personas');
const CORE_DIR = path.join(DATA_DIR, 'ai-skills', 'core');
const LORES_DIR = path.join(DATA_DIR, 'ai-skills', 'lore');
const MODES_DIR = path.join(DATA_DIR, 'ai-skills', 'modes');
const FE_DIR = path.join(PLUGIN_ROOT, 'frontend');
const DIST_DIR = path.join(FE_DIR, 'dist');
function isGlobalLocalMode() {
    return /^(?:1|true|yes|on)$/i.test(String(process.env.GLOBAL_LOCAL_MODE || '').trim());
}
const AGENT_CONSOLE_DIR = path.join(PLUGIN_ROOT, '..', 'agent-console');
const AGENT_CONSOLE_DIST_DIR = path.join(AGENT_CONSOLE_DIR, 'dist');
const PORT = process.env.DASHBOARD_PORT || 5150;
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD || '';
const ADMIN_PWD_FILE = path.join(DATA_DIR, 'dashboard-admin-pwd.txt');
const ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-access-pwd.txt');
const LEGACY_ACCESS_PWD_FILE = path.join(DATA_DIR, 'dashboard-pwd.txt');
const RESET_TOKEN_FILE = path.join(DATA_DIR, 'password-reset-token.txt');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'dashboard-session-secret.txt');
const CUSTOM_PROVIDERS_FILE = path.join(DATA_DIR, 'ai-providers-custom.json');
const FALLBACK_CHAINS_FILE = path.join(DATA_DIR, 'ai-fallback-chains.json');
const DEBUG_LOG_CONFIG_FILE = path.join(DATA_DIR, 'debug-log-config.json');
const LOCAL_DEPLOY_MANIFEST_FILE = path.join(DATA_DIR, 'dashboard-local-deploy-manifest.json');
const LOCAL_NAPCAT_DIR_FILE = path.join(DATA_DIR, 'dashboard-napcat-dir.txt');
const GALLERY_DIR = path.join(DATA_DIR, 'gallery');
const GALLERY_METADATA_FILE = path.join(GALLERY_DIR, 'metadata.json');
const GALLERY_MAX_BYTES = 8 * 1024 * 1024;
const GALLERY_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const GALLERY_FOIL_STYLES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const NPM_PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_all_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_ALL_PROXY'];
const MAX_LOG_LIMIT = 6000;
function isPackagedLocalWorkspace() {
    return /^(?:1|true|yes|on)$/i.test(String(process.env.LIANLIAN_PACKAGED || '').trim());
}
function getResourceRoot() {
    return path.resolve(process.env.LIANLIAN_RESOURCE_ROOT || path.join(PLUGIN_ROOT, '..', '..'));
}
function isAgentPathInside(target, root) {
    const absTarget = path.resolve(String(target || ''));
    const absRoot = path.resolve(String(root || ''));
    const left = process.platform === 'win32' ? absTarget.toLowerCase() : absTarget;
    const right = process.platform === 'win32' ? absRoot.toLowerCase() : absRoot;
    return left === right || left.startsWith(right + path.sep);
}
function toProjectRel(filePath) {
    return path.relative(path.resolve(KOISHI_DIR), path.resolve(filePath)).replace(/\\/g, '/');
}
function resolveProjectRel(rel) {
    const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..'))
        throw new Error('invalid local deploy path');
    const full = path.resolve(KOISHI_DIR, normalized);
    if (!isInsidePath(KOISHI_DIR, full))
        throw new Error('local deploy path is outside project directory');
    return full;
}
function runtimePath(...parts) {
    return path.join(KOISHI_DIR, 'runtime', ...parts);
}
module.exports = {
    PLUGIN_ROOT,
    AI_LIB,
    KOISHI_DIR,
    KOISHI_PID_FILE,
    DATA_DIR,
    PERSONAS_DIR,
    CORE_DIR,
    LORES_DIR,
    MODES_DIR,
    FE_DIR,
    DIST_DIR,
    AGENT_CONSOLE_DIR,
    AGENT_CONSOLE_DIST_DIR,
    PORT,
    HOST,
    PASSWORD,
    ADMIN_PASSWORD,
    ADMIN_PWD_FILE,
    ACCESS_PWD_FILE,
    LEGACY_ACCESS_PWD_FILE,
    RESET_TOKEN_FILE,
    SESSION_SECRET_FILE,
    CUSTOM_PROVIDERS_FILE,
    FALLBACK_CHAINS_FILE,
    DEBUG_LOG_CONFIG_FILE,
    LOCAL_DEPLOY_MANIFEST_FILE,
    LOCAL_NAPCAT_DIR_FILE,
    GALLERY_DIR,
    GALLERY_METADATA_FILE,
    GALLERY_MAX_BYTES,
    GALLERY_MIME_EXT,
    GALLERY_FOIL_STYLES,
    NPM_PROXY_ENV_KEYS,
    MAX_LOG_LIMIT,
    isGlobalLocalMode,
    isPackagedLocalWorkspace,
    getResourceRoot,
    isAgentPathInside,
    toProjectRel,
    resolveProjectRel,
    runtimePath,
};
