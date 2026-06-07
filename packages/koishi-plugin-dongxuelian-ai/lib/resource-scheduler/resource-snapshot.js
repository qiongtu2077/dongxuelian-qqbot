"use strict";
/**
 * MODULE: S1 资源快照。
 * 职责: 读取系统内存、S0 锁和维护状态，生成统一资源档位。
 * 边界: 不做任务排队，不修改 S0/S2 状态。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, MAINTENANCE_FILE } = require('../core/constants');
const { readLockMeta } = require('../resource-gate/gate');
const { ensureDir, nowIso, writeJsonAtomic } = require('../resource-common/files');
function isRunningTaskLike(value) {
    return !!value && typeof value === 'object';
}
const SCHEDULER_ROOT = path.join(DATA_DIR, 'resource-scheduler');
const SCHEDULER_STATE_FILE = path.join(SCHEDULER_ROOT, 'state.json');
// 读取显式的低内存故障注入值，便于本地和运维验证 red/black 分支。
function readMeminfoOverride() {
    const rawAvailable = process.env.RESOURCE_SCHEDULER_MEM_AVAILABLE_MB_OVERRIDE;
    if (rawAvailable === undefined || rawAvailable === '')
        return null;
    const availableMb = Math.floor(Number(rawAvailable));
    if (!Number.isFinite(availableMb) || availableMb < 0)
        return null;
    const rawTotal = process.env.RESOURCE_SCHEDULER_MEM_TOTAL_MB_OVERRIDE;
    const parsedTotal = rawTotal === undefined || rawTotal === '' ? null : Math.floor(Number(rawTotal));
    return {
        availableMb,
        totalMb: parsedTotal !== null && Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null,
    };
}
// 读取当前进程 cgroup v2 内存限额，便于 systemd/cgroup 隔离验收。
function readCgroupV2Meminfo() {
    if (process.platform !== 'linux')
        return null;
    try {
        const rawCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
        const line = rawCgroup.split(/\r?\n/).find((item) => item.startsWith('0::'));
        if (!line)
            return null;
        const cgroupPath = line.slice(3).trim();
        const normalized = cgroupPath.startsWith('/') ? cgroupPath.slice(1) : cgroupPath;
        const cgroupRoot = path.join('/sys/fs/cgroup', normalized);
        const maxRaw = fs.readFileSync(path.join(cgroupRoot, 'memory.max'), 'utf8').trim();
        if (!maxRaw || maxRaw === 'max')
            return null;
        const currentRaw = fs.readFileSync(path.join(cgroupRoot, 'memory.current'), 'utf8').trim();
        const maxBytes = Number(maxRaw);
        const currentBytes = Number(currentRaw);
        if (!Number.isFinite(maxBytes) || !Number.isFinite(currentBytes) || maxBytes <= 0 || currentBytes < 0)
            return null;
        const totalMb = Math.floor(maxBytes / 1024 / 1024);
        const availableMb = Math.max(0, Math.floor((maxBytes - currentBytes) / 1024 / 1024));
        return {
            availableMb,
            totalMb,
            source: 'cgroup-v2',
        };
    }
    catch {
        return null;
    }
}
// 读取 Linux /proc/meminfo，非 Linux 或读取失败时返回 null。
function readProcMeminfo() {
    if (process.platform !== 'linux')
        return { availableMb: null, totalMb: null, source: 'not-linux' };
    try {
        const raw = fs.readFileSync('/proc/meminfo', 'utf8');
        const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(raw);
        const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(raw);
        return {
            availableMb: available ? Math.floor(Number(available[1]) / 1024) : null,
            totalMb: total ? Math.floor(Number(total[1]) / 1024) : null,
            source: '/proc/meminfo',
        };
    }
    catch {
        return { availableMb: null, totalMb: null, source: '/proc/meminfo-unavailable' };
    }
}
// 读取统一内存口径；有限 cgroup 限额优先，否则回退到主机 /proc/meminfo。
function readLinuxMeminfo() {
    const override = readMeminfoOverride();
    if (override)
        return { ...override, source: 'env-override' };
    return readCgroupV2Meminfo() || readProcMeminfo();
}
// 根据可用内存归档资源状态；未知内存按 yellow 处理，避免盲目放开。
function classifyResourceState(memAvailableMb) {
    if (memAvailableMb === null)
        return 'yellow';
    if (memAvailableMb >= 900)
        return 'green';
    if (memAvailableMb >= 600)
        return 'yellow';
    if (memAvailableMb >= 300)
        return 'red';
    return 'black';
}
// 根据资源状态、维护文件和 S0 锁推导 Bot 模式。
function classifyBotMode(resourceState, running, maintenance) {
    if (maintenance)
        return 'maintenance';
    if (resourceState === 'black' || resourceState === 'red')
        return 'critical';
    if (isRunningTaskLike(running) && running.kind === 'daily_report')
        return 'report_silent';
    if (running)
        return 'busy';
    return 'normal';
}
// 读取当前资源快照，并写入 state.json 供 Dashboard 低成本读取。
function readResourceSnapshot() {
    ensureDir(SCHEDULER_ROOT);
    const mem = readLinuxMeminfo();
    const running = readLockMeta();
    const resourceState = classifyResourceState(mem.availableMb);
    const maintenance = fs.existsSync(MAINTENANCE_FILE);
    const snapshot = {
        resourceState,
        botMode: classifyBotMode(resourceState, running, maintenance),
        memAvailableMb: mem.availableMb,
        memTotalMb: mem.totalMb,
        memSource: mem.source,
        locked: !!running,
        running,
        maintenance,
        createdAt: nowIso(),
    };
    writeJsonAtomic(SCHEDULER_STATE_FILE, snapshot);
    return snapshot;
}
module.exports = {
    SCHEDULER_ROOT,
    SCHEDULER_STATE_FILE,
    readMeminfoOverride,
    readCgroupV2Meminfo,
    readProcMeminfo,
    readLinuxMeminfo,
    classifyResourceState,
    classifyBotMode,
    readResourceSnapshot,
};
