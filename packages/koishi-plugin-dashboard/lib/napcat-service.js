'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// --- WebUI 健康检查 ---
// 完整读取 WebUI 页面，拒绝端口可连接但无 HTTP 响应的假健康状态。
function probeNapcatWebui(port) {
    return new Promise((resolve) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/webui/', agent: false }, (response) => {
            let bytes = 0;
            response.on('data', (chunk) => { bytes += chunk.length; });
            response.on('end', () => resolve(response.statusCode === 200 && bytes > 0));
            response.on('error', () => resolve(false));
        });
        request.setTimeout(1000, () => request.destroy(new Error('NapCat WebUI 请求超时')));
        request.on('error', () => resolve(false));
    });
}
// 等待新实例真正返回网页，启动失败时保留明确的失败结果。
async function waitForNapcatWebui(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await probeNapcatWebui(port))
            return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error(`NapCat WebUI 健康检查失败：127.0.0.1:${port} 未返回有效页面`);
}
// --- Koishi 实际连接检查 ---
// 只认可当前应用 Koishi worker 到 OneBot 端口的已建立连接。
function hasKoishiOnebotConnection(koishiDir, onebotPort) {
    return new Promise((resolve, reject) => {
        execFile('ss', ['-Hntp', `( dst 127.0.0.1 and dport = :${onebotPort} )`], { timeout: 2000 }, (error, stdout) => {
            if (error)
                return reject(error);
            const worker = path.join(koishiDir, 'node_modules', 'koishi', 'lib', 'worker');
            resolve(stdout.split('\n').some((line) => {
                if (!/^ESTAB\s/.test(line))
                    return false;
                const pid = line.match(/"node",pid=(\d+)/)?.[1];
                if (!pid)
                    return false;
                try {
                    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(worker);
                }
                catch {
                    // 采样期间退出的进程不能作为连接恢复的证据。
                    return false;
                }
            }));
        });
    });
}
// 等待真实的 Koishi 连接，拒绝仅有 OneBot 监听端口的假成功。
async function waitForKoishiOnebot(koishiDir, onebotPort, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await hasKoishiOnebotConnection(koishiDir, onebotPort))
            return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error(`Koishi 的 OneBot 连接未恢复：127.0.0.1:${onebotPort}`);
}
// --- 受托管重启流程 ---
// 通过固定 systemctl 参数操作服务并保留执行失败。
function runSystemctl(args) {
    return new Promise((resolve, reject) => {
        execFile('systemctl', args, { timeout: 30000, maxBuffer: 512 * 1024 }, (error, stdout) => {
            if (error)
                reject(error);
            else
                resolve(stdout.trim());
        });
    });
}
// 恢复 WebUI 后重新启动原本在运行的 Koishi，验证其实际重连再报告成功。
async function restartNapcatService(serviceName, port, koishiDir, onebotPort) {
    const state = await runSystemctl(['show', 'lian-koishi.service', '--property=ActiveState', '--value']);
    if (!['active', 'inactive', 'failed'].includes(state))
        throw new Error(`Koishi 服务状态为 ${state}，请稍后重试`);
    await runSystemctl(['restart', serviceName]);
    await waitForNapcatWebui(port);
    if (state !== 'active')
        return { botReconnected: false };
    // 当前 OneBot 适配器断线后会进入 OFFLINE，必须恢复其连接生命周期。
    await runSystemctl(['restart', 'lian-koishi.service']);
    await waitForKoishiOnebot(koishiDir, onebotPort);
    return { botReconnected: true };
}
module.exports = { restartNapcatService, waitForNapcatWebui, waitForKoishiOnebot };
