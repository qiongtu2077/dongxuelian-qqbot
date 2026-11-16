"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearSlSession = clearSlSession;
exports.slLoginState = slLoginState;
exports.acceptSlAgreements = acceptSlAgreements;
exports.readSlQqPid = readSlQqPid;
exports.readOnebotTarget = readOnebotTarget;
exports.connectSlAccount = connectSlAccount;
/** 对接固定版本 SnowLuma v2.4.2 的登录、协议确认和当前 QQ 会话。 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const protocol_runtime_1 = require("./protocol-runtime");
const napcatService = require("./napcat-service");
const { waitForKoishiOnebot } = napcatService;
const yaml = require('js-yaml');
let sessionToken = '';
let sessionUntil = 0;
// --- 固定协议 HTTP 适配 ---
/** 请求本机 SnowLuma；限制响应和超时，保留上游错误及首次协议确认状态。 */
function requestApi(endpoint, body, authenticated = true) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const request = http.request({ host: '127.0.0.1', port: 5099, path: '/api' + endpoint,
            method: body === undefined ? 'GET' : 'POST', agent: false,
            headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'x-snowluma-token': sessionToken } : {}) },
        }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                text += chunk;
                if (text.length > 2 * 1024 * 1024)
                    request.destroy(new Error('SnowLuma 响应超出限制'));
            });
            response.on('error', reject);
            response.on('end', () => {
                try {
                    const data = JSON.parse(text);
                    if (response.statusCode === 401) {
                        sessionToken = '';
                        sessionUntil = 0;
                    }
                    if ((response.statusCode || 500) >= 400)
                        throw new Error(String(data.message || `SnowLuma HTTP ${response.statusCode}`));
                    resolve(data);
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(8000, () => request.destroy(new Error('SnowLuma API 请求超时')));
        request.on('error', reject);
        request.end(payload);
    });
}
/** 使用安装时生成的独立凭据登录，仅缓存在服务端，不返回到浏览器。 */
async function ensureSession() {
    if ((0, protocol_runtime_1.selectedProtocol)() !== 'sl')
        throw new Error('请先切换到 SnowLuma');
    const state = await (0, protocol_runtime_1.serviceState)('lian-snowluma.service');
    if (state.state !== 'active')
        throw new Error('SnowLuma 服务未运行，请从顶部菜单重新启动');
    if (sessionToken && Date.now() < sessionUntil)
        return;
    const password = fs.readFileSync(path.join(protocol_runtime_1.slRoot, 'bootstrap-password'), 'utf8').trim();
    const data = await requestApi('/login', { password }, false);
    if (data.success !== true || typeof data.token !== 'string')
        throw new Error('SnowLuma 管理凭据已变更，请恢复安装凭据后重试');
    if (data.mustChangePassword)
        throw new Error('SnowLuma 要求修改初始密码，请先完成官方 WebUI 密码设置');
    sessionToken = data.token;
    sessionUntil = Date.now() + 30 * 60 * 1000;
}
/** 切换或重启后丢弃旧运行时的会话令牌。 */
function clearSlSession() { sessionToken = ''; sessionUntil = 0; }
/** 返回协议文本和真实会话；协议确认前不请求受限的会话接口。 */
async function slLoginState() {
    await ensureSession();
    const agreements = await requestApi('/agreements');
    if (agreements.consentRequired)
        return { agreements, accounts: [], processes: [] };
    const [accounts, processes] = await Promise.all([requestApi('/qq-list'), requestApi('/processes')]);
    const pid = readSlQqPid();
    return { agreements, accounts: accounts.list, processes: processes.list.filter(item => item.pid === pid) };
}
/** 仅在用户明确点击同意后记录当前版本的官方协议。 */
async function acceptSlAgreements(version) {
    await ensureSession();
    return requestApi('/agreements/record-consent', { version });
}
// --- 当前实例接入与 OneBot 配置 ---
/** 核实 PID 指向独立 SL 目录的 QQ，拒绝接入同服务器的其他 QQ 实例。 */
function readSlQqPid() {
    const pid = Number(fs.readFileSync(path.join(protocol_runtime_1.slRoot, 'qq.pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1)
        throw new Error('SnowLuma QQ 进程尚未启动');
    const executable = fs.realpathSync(`/proc/${pid}/exe`);
    if (executable !== path.join(protocol_runtime_1.slRoot, 'qq/opt/QQ/qq'))
        throw new Error('QQ PID 不属于当前 SnowLuma 实例');
    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    if (!cgroup.includes('/lian-snowluma.service'))
        throw new Error('QQ 进程不在 SnowLuma 受管服务内');
    return pid;
}
/** 从现有 Koishi 配置读取唯一 OneBot 正向连接，保留账号、路径和 Token。 */
function readOnebotTarget() {
    const configuration = yaml.load(fs.readFileSync(path.join(protocol_runtime_1.koishiDir, 'koishi.yml'), 'utf8'));
    const adapters = [];
    /** 按 Koishi 插件分组遍历配置，只识别已启用的 adapter-onebot。 */
    function walk(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return;
        for (const [key, child] of Object.entries(value)) {
            if (key.split(':')[0] === 'adapter-onebot' && child && typeof child === 'object')
                adapters.push(child);
            else if (key === 'plugins' || key.startsWith('group:'))
                walk(child);
        }
    }
    walk(configuration);
    if (adapters.length !== 1)
        throw new Error('当前项目必须配置唯一的 OneBot 适配器');
    const adapter = adapters[0];
    const endpoint = new URL(String(adapter.endpoint));
    const selfId = String(adapter.selfId);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !/^\d+$/.test(selfId))
        throw new Error('当前 OneBot 连接必须是本机正向 WebSocket，且配置有效 QQ 号');
    return { selfId, endpoint, token: String(adapter.token || '') };
}
/** 接入自己的 QQ 进程，账号匹配后配置 OneBot 并验证 Koishi 的实际连接。 */
async function connectSlAccount() {
    await ensureSession();
    const pid = readSlQqPid();
    const loaded = await requestApi(`/processes/${pid}/load`, {});
    if (loaded.success !== true)
        throw new Error('SnowLuma 接入 QQ 失败，请查看服务日志');
    const { selfId, endpoint, token } = readOnebotTarget();
    const accounts = await requestApi('/qq-list');
    if (!accounts.list.some(account => String(account.uin) === selfId)) {
        return { connected: false, message: `QQ 进程已接入，请在扫码桌面登录 ${selfId} 后再次完成连接` };
    }
    const config = (await requestApi(`/config/${selfId}`)).config;
    // 仅给该账号设置本项目的入口，避免默认监听器或其他账号占用同一端口。
    const saved = await requestApi(`/config/${selfId}`, { ...config, networks: {
            httpServers: [], httpClients: [], wsClients: [], wsServers: [{ name: 'lian-dashboard', host: '127.0.0.1',
                    port: Number(endpoint.port), path: endpoint.pathname, role: 'Universal', accessToken: token,
                    messageFormat: 'array', reportSelfMessage: false }],
        } });
    if (saved.success !== true || saved.applied !== true)
        throw new Error('SnowLuma OneBot 配置未成功应用');
    const bot = await (0, protocol_runtime_1.serviceState)('lian-koishi.service');
    if (bot.state !== 'active')
        return { connected: false, message: 'QQ 已登录且 OneBot 已配置，请启动机器人引擎后完成连接' };
    await (0, protocol_runtime_1.systemctl)('restart', 'lian-koishi.service');
    await waitForKoishiOnebot(protocol_runtime_1.koishiDir, Number(endpoint.port));
    return { connected: true, message: `SnowLuma 已登录 ${selfId}，机器人 OneBot 连接已恢复` };
}
