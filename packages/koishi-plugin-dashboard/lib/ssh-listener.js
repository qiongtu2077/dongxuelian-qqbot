"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSshListener = startSshListener;
/** SSH stream-local 转发的私有 HTTP 入口，独立于公网监听。 */
const node_fs_1 = require("node:fs");
const node_http_1 = require("node:http");
const node_path_1 = require("node:path");
const node_net_1 = require("node:net");
const paths = require("./paths");
const trusted_access_1 = require("./trusted-access");
/** 为已经启用隧道模式的服务创建用户私有套接字。 */
function startSshListener(handler) {
    if (process.platform === 'win32' || !(0, trusted_access_1.needsSshListener)())
        return;
    const directory = (0, node_path_1.join)(paths.DATA_DIR, 'dashboard-tunnel');
    const socket = (0, node_path_1.join)(directory, 'console.sock');
    let stale;
    try {
        (0, node_fs_1.mkdirSync)(directory, { recursive: true, mode: 0o700 });
        const dir = (0, node_fs_1.lstatSync)(directory);
        if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077))
            throw new Error('入口目录权限无效');
        stale = (0, node_fs_1.lstatSync)(socket, { throwIfNoEntry: false });
        if (stale && (!stale.isSocket() || stale.uid !== dir.uid))
            throw new Error('入口路径已被其他文件占用');
    }
    catch (error) {
        console.error('[dashboard] SSH 私有入口停用', error instanceof Error ? error.message : '目录检查失败');
        return;
    }
    const server = (0, node_http_1.createServer)((req, res) => {
        (0, trusted_access_1.markSshRequest)(req);
        handler(req, res);
    });
    server.on('error', (error) => console.error('[dashboard] SSH 私有入口启动失败', error.message));
    // 异常退出会留下 socket 节点；只有探测为无监听者且身份未变化时才回收。
    const listen = () => server.listen(socket, () => {
        try {
            (0, node_fs_1.chmodSync)(socket, 0o600);
        }
        catch {
            server.close();
            console.error('[dashboard] SSH 私有入口权限设置失败');
        }
    });
    if (!stale)
        listen();
    else {
        const probe = (0, node_net_1.createConnection)(socket);
        probe.once('connect', () => { probe.end(); console.error('[dashboard] SSH 私有入口已在使用'); });
        probe.once('error', (error) => {
            if (error.code !== 'ECONNREFUSED')
                return;
            try {
                const current = (0, node_fs_1.lstatSync)(socket, { throwIfNoEntry: false });
                if (current?.ino === stale.ino && current?.dev === stale.dev) {
                    (0, node_fs_1.unlinkSync)(socket);
                    listen();
                }
            }
            catch {
                console.error('[dashboard] SSH 私有入口旧节点回收失败');
            }
        });
    }
    return server;
}
