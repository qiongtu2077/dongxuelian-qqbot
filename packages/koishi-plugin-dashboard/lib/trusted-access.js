"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRUSTED_ACCESS_FILE = void 0;
exports.trustedOrigin = trustedOrigin;
exports.markSshRequest = markSshRequest;
exports.needsSshListener = needsSshListener;
exports.hasTrustedDashboardAccess = hasTrustedDashboardAccess;
const node_fs_1 = require("node:fs");
const node_net_1 = require("node:net");
const node_path_1 = require("node:path");
const paths = require("./paths");
exports.TRUSTED_ACCESS_FILE = (0, node_path_1.join)(paths.DATA_DIR, 'dashboard-trusted-access.json');
let cachedStamp = '';
let cachedPolicy;
const requestTransport = new WeakMap();
const sshRequests = new WeakSet();
// --- 配置和地址规范化 ---
/** 规范化单个裸主机地址，包括映射的 IPv4，拒绝网段、通配和作用域地址。 */
function address(value) {
    if (typeof value !== 'string' || value.includes('%') || !(0, node_net_1.isIP)(value))
        return '';
    if ((0, node_net_1.isIP)(value) === 4)
        return value === '0.0.0.0' ? '' : value;
    const normalized = new URL('http://[' + value + ']').hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(normalized);
    if (!mapped)
        return normalized === '::' ? '' : normalized;
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return address([high >> 8, high & 255, low >> 8, low & 255].join('.'));
}
/** 解析已启用的单地址策略，任何不完整配置都退回口令。 */
function parsePolicy(raw) {
    const data = JSON.parse(raw);
    if (data?.version !== 1 || data.enabled !== true || !['direct', 'proxy', 'ssh'].includes(data.mode))
        return;
    const client = address(data.address);
    if (!client || typeof data.origin !== 'string')
        return;
    const origin = new URL(data.origin);
    if (origin.origin !== data.origin || origin.username || origin.password)
        return;
    const proxy = address(data.proxy);
    if (data.mode === 'proxy' && (!proxy || client === proxy || origin.protocol !== 'https:'))
        return;
    if (data.mode !== 'proxy' && data.proxy !== undefined)
        return;
    if (data.mode === 'ssh') {
        if (client !== '127.0.0.1' || origin.hostname !== client || !origin.port || origin.protocol !== 'http:')
            return;
    }
    else if (origin.protocol !== 'https:')
        return;
    return { mode: data.mode, address: client, proxy, origin };
}
/** POSIX 许可仅接受服务用户或 root 拥有的私有普通文件。 */
function privatePolicyFile(stat) {
    return stat.isFile() && stat.size <= 4096 && (process.platform === 'win32' ||
        (stat.mode & 0o077) === 0 && (stat.uid === 0 || stat.uid === process.getuid?.()));
}
/** 文件原子替换或权限变化后重新读取，禁止沿用已撤销的旧许可。 */
function readPolicy() {
    try {
        const stat = (0, node_fs_1.lstatSync)(exports.TRUSTED_ACCESS_FILE, { throwIfNoEntry: false });
        if (!stat || !privatePolicyFile(stat)) {
            cachedPolicy = undefined;
            cachedStamp = '';
            return;
        }
        const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join('/');
        if (stamp === cachedStamp)
            return cachedPolicy;
        const fd = (0, node_fs_1.openSync)(exports.TRUSTED_ACCESS_FILE, node_fs_1.constants.O_RDONLY | (node_fs_1.constants.O_NOFOLLOW || 0));
        try {
            const opened = (0, node_fs_1.fstatSync)(fd);
            if (!privatePolicyFile(opened) || opened.ino !== stat.ino || opened.dev !== stat.dev)
                return;
            cachedPolicy = parsePolicy((0, node_fs_1.readFileSync)(fd, 'utf8'));
            cachedStamp = stamp;
            return cachedPolicy;
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
    }
    catch {
        cachedPolicy = undefined;
        cachedStamp = '';
        return;
    }
}
// --- 传输和授权边界 ---
/** 单值头必须来自唯一字段，拒绝逗号列表和重复声明。 */
function singleHeader(req, name) {
    const value = req.headers[name];
    if (typeof value !== 'string' || !value || value.includes(','))
        return '';
    const raw = req.rawHeaders || [];
    for (let index = 0, seen = false; index < raw.length; index += 2) {
        if (raw[index].toLowerCase() !== name)
            continue;
        if (seen)
            return '';
        seen = true;
    }
    return value;
}
/** 先验证实际 TCP 对端和目标 Host，再采信专用反代覆盖的协议和单一来源。 */
function verifyTransport(req) {
    const policy = readPolicy();
    if (!policy || singleHeader(req, 'host').toLowerCase() !== policy.origin.host)
        return null;
    const peer = address(req.socket?.remoteAddress);
    if (policy.mode === 'ssh') {
        return sshRequests.has(req) ? { policy, client: '127.0.0.1' } : null;
    }
    if (policy.mode === 'proxy') {
        if (peer !== policy.proxy || req.headers.forwarded !== undefined || req.headers['x-forwarded-for'] !== undefined ||
            singleHeader(req, 'x-forwarded-proto') !== 'https')
            return null;
        const source = address(singleHeader(req, 'x-real-ip'));
        return source ? { policy, client: source } : null;
    }
    return peer && req.socket.encrypted ? { policy, client: peer } : null;
}
/** 同一次请求共享核验结果，下一次请求重新观察配置与对端。 */
function transport(req) {
    if (!requestTransport.has(req))
        requestTransport.set(req, verifyTransport(req));
    return requestTransport.get(req);
}
/** 认可代理的外部站点时仍让普通来源使用口令。 */
function trustedOrigin(req) { return transport(req)?.policy.origin.origin; }
/** 只有服务进程的专用 Unix 监听器能够登记此请求。 */
function markSshRequest(req) { sshRequests.add(req); }
/** 启动阶段启用私有监听器，之后每次授权仍需核对当前配置。 */
function needsSshListener() { return readPolicy()?.mode === 'ssh'; }
/** 只允许控制台操作与自检；凭据管理、第三方代理、扫码桌面保留独立校验。 */
function hasTrustedDashboardAccess(req, pathname) {
    if (!pathname.startsWith('/dashboard/api/') || req.headers['x-dashboard-password-only'] !== undefined ||
        pathname.startsWith('/dashboard/api/auth/') && pathname !== '/dashboard/api/auth/session' ||
        pathname === '/dashboard/api/login' || pathname === '/dashboard/api/admin/verify' ||
        pathname === '/dashboard/api/protocol/sl/desktop')
        return false;
    const connection = transport(req);
    if (!connection || connection.client !== connection.policy.address)
        return false;
    const origin = connection.policy.origin.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const supplied = singleHeader(req, 'origin');
    if (supplied || req.headers.origin !== undefined)
        return supplied === origin;
    return req.method === 'GET' || req.method === 'HEAD';
}
