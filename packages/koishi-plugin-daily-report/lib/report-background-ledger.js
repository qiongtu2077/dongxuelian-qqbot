"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportBackgroundLedger = exports.ReportBackgroundLedgerError = void 0;
exports.provisionReportBackgroundLedger = provisionReportBackgroundLedger;
const report_cache_provenance_1 = require("./report-cache-provenance");
const report_request_pool_1 = require("./report-request-pool");
const report_exchange_1 = require("./report-exchange");
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { createReportPeriod } = loadManagementModule('daily.reportPeriod');
const LEDGER_HASH = /^[a-f0-9]{64}$/;
const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
class ReportBackgroundLedgerError extends report_request_pool_1.ReportRequestBoundaryError {
    // 总账/准入错误停止当前请求，不能被模型格式恢复吞掉。
    constructor(code, message) {
        super(['group_limit', 'global_limit', 'task_limit', 'cooldown', 'foreground', 'paused'].includes(code) ? 'budget' : 'contract', message);
        this.code = code;
        this.name = 'ReportBackgroundLedgerError';
    }
}
exports.ReportBackgroundLedgerError = ReportBackgroundLedgerError;
// --- 可信业务日与结构 ---
// 计额业务日由实际请求时刻的既有四点窗口计算，不沿用聊天快照截止。
function ledgerScope(nowMs) {
    if (!Number.isSafeInteger(nowMs))
        throw new ReportBackgroundLedgerError('contract', '后台总账需要明确毫秒时刻，不能猜当前业务日');
    const period = createReportPeriod(nowMs);
    return { date: period.reportDate, startMs: period.periodStartMs, endMs: period.periodEndMs };
}
// 持久化范围必须逐项匹配既有业务窗口，不能接受仅格式像日期的对象。
function assertLedgerScope(value) {
    (0, report_exchange_1.assertReportFields)(value, ['date', 'startMs', 'endMs'], '后台总账业务日');
    if (!Number.isSafeInteger(value.startMs) || (0, report_cache_provenance_1.reportCacheDigest)(value) !== (0, report_cache_provenance_1.reportCacheDigest)(ledgerScope(value.startMs)))
        throw new Error('总账业务日不一致');
}
// 可读与未知用量明确区分，不以缺失为零，也不把token数当金额上限。
function assertLedgerUsage(value) {
    if (value === null)
        return;
    (0, report_exchange_1.assertReportFields)(value, ['readable', 'promptTokens', 'completionTokens', 'totalTokens'], '后台用量');
    if (typeof value.readable !== 'boolean' || [value.promptTokens, value.completionTokens, value.totalTokens].some(count => !Number.isSafeInteger(count) || count < 0))
        throw new Error('后台用量无效');
}
// 全部预留均计额，包含失败/取消/结果未知；结构损坏不允许从零计数。
function decodeLedgerDay(control, expected) {
    try {
        const value = control.value;
        (0, report_exchange_1.assertReportFields)(value, ['version', 'scope', 'entries', 'schedules', 'pausedGroups', 'globalPaused'], '后台日账');
        assertLedgerScope(value.scope);
        if (value.version !== 'background-ledger-day-2' || (0, report_cache_provenance_1.reportCacheDigest)(value.scope) !== (0, report_cache_provenance_1.reportCacheDigest)(expected)
            || control.retainUntilMs !== control.createdAtMs + LEDGER_RETENTION_MS
            || !Array.isArray(value.entries) || value.entries.length > 80 || !Array.isArray(value.pausedGroups) || value.pausedGroups.length > 80
            || new Set(value.pausedGroups).size !== value.pausedGroups.length || value.pausedGroups.some(group => !LEDGER_HASH.test(group)) || typeof value.globalPaused !== 'boolean')
            throw new Error('后台日账结构无效');
        if (!Array.isArray(value.schedules))
            throw new Error('后台调度记录缺失');
        const scheduledChannels = new Set();
        for (const schedule of value.schedules) {
            (0, report_exchange_1.assertReportFields)(schedule, ['channel', 'owner', 'scheduledAtMs'], '后台调度');
            if (!LEDGER_HASH.test(schedule.channel) || !LEDGER_HASH.test(schedule.owner) || scheduledChannels.has(schedule.channel)
                || !Number.isSafeInteger(schedule.scheduledAtMs) || schedule.scheduledAtMs < expected.startMs || schedule.scheduledAtMs >= expected.endMs
                || schedule.scheduledAtMs > control.updatedAtMs)
                throw new Error('后台调度身份或时刻无效');
            scheduledChannels.add(schedule.channel);
        }
        const ids = new Set(), groups = new Map(), owners = new Map(), attempts = new Set(), ownerScopes = new Map();
        for (const entry of value.entries) {
            (0, report_exchange_1.assertReportFields)(entry, ['id', 'owner', 'channel', 'unit', 'attempt', 'requestIdentity', 'policyIdentity', 'routeIdentity', 'configurationIdentity',
                'startedAtMs', 'deadlineMs', 'reservedAtMs', 'status', 'settledAtMs', 'usage', 'quotaFailure'], '后台预留');
            if ([entry.id, entry.owner, entry.channel, entry.unit, entry.requestIdentity, entry.policyIdentity, entry.routeIdentity, entry.configurationIdentity].some(id => !LEDGER_HASH.test(id))
                || ![1, 2].includes(entry.attempt) || ids.has(entry.id) || !Number.isSafeInteger(entry.startedAtMs) || entry.deadlineMs !== entry.startedAtMs + 90000
                || !Number.isSafeInteger(entry.reservedAtMs) || entry.reservedAtMs < expected.startMs || entry.reservedAtMs >= expected.endMs
                || entry.reservedAtMs < entry.startedAtMs || entry.reservedAtMs >= entry.deadlineMs || !['reserved', 'returned', 'failed', 'cancelled'].includes(entry.status)
                || !['none', 'group', 'global'].includes(entry.quotaFailure))
                throw new Error('后台预留记录无效');
            if (attempts.has(entry.owner + ':' + entry.attempt) || entry.id !== (0, report_cache_provenance_1.reportCacheDigest)({ date: expected.date, owner: entry.owner,
                unit: entry.unit, attempt: entry.attempt, requestIdentity: entry.requestIdentity, routeIdentity: entry.routeIdentity }))
                throw new Error('后台预留身份或轮次重复');
            const ownerScope = (0, report_cache_provenance_1.reportCacheDigest)({ channel: entry.channel, unit: entry.unit, policyIdentity: entry.policyIdentity, startedAtMs: entry.startedAtMs, deadlineMs: entry.deadlineMs });
            if (ownerScopes.has(entry.owner) && ownerScopes.get(entry.owner) !== ownerScope)
                throw new Error('后台同任务来源或原截止不一致');
            ownerScopes.set(entry.owner, ownerScope);
            if (entry.status === 'reserved' ? entry.settledAtMs !== null || entry.usage !== null || entry.quotaFailure !== 'none'
                : !Number.isSafeInteger(entry.settledAtMs) || entry.settledAtMs < entry.reservedAtMs || entry.settledAtMs >= entry.deadlineMs)
                throw new Error('后台预留结算状态无效');
            assertLedgerUsage(entry.usage);
            if (entry.quotaFailure !== 'none' && (entry.status !== 'failed' || !value.pausedGroups.includes(entry.channel)
                || entry.quotaFailure === 'global' && !value.globalPaused))
                throw new Error('后台额度暂停状态丢失');
            ids.add(entry.id);
            attempts.add(entry.owner + ':' + entry.attempt);
            groups.set(entry.channel, (groups.get(entry.channel) || 0) + 1);
            owners.set(entry.owner, (owners.get(entry.owner) || 0) + 1);
        }
        if ([...groups.values()].some(count => count > 20) || [...owners.values()].some(count => count > 2))
            throw new Error('后台总账已超硬额度');
        return value;
    }
    catch {
        throw new ReportBackgroundLedgerError('untrusted', '后台日账结构或计额不可验证，停止后台请求');
    }
}
// 可信锚点只允许日序向前，普通缓存清理不能删除或重建它。
function decodeLedgerAnchor(control) {
    try {
        const value = control.value;
        (0, report_exchange_1.assertReportFields)(value, ['version', 'latest', 'previous'], '后台总账锚点');
        if (value.version !== 'background-ledger-anchor-1')
            throw new Error('未知锚点');
        assertLedgerScope(value.latest);
        if (value.previous !== null) {
            assertLedgerScope(value.previous);
            if (value.previous.startMs >= value.latest.startMs)
                throw new Error('后台业务日倒退');
        }
        return value;
    }
    catch {
        throw new ReportBackgroundLedgerError('untrusted', '后台总账锚点不可验证，停止后台请求');
    }
}
// 日账缺失时只有未初始化的新日可以创建空账；已经声明的当日日账缺失必须停手。
function emptyLedgerDay(scope) {
    return { version: 'background-ledger-day-2', scope, entries: [], schedules: [], pausedGroups: [], globalPaused: false };
}
// --- 显式首次启用与日滚动 ---
// 仅交付首次启用步骤调用，运行/重启路径不得调用此函数；中断只恢复可证明的同日空账。
function provisionReportBackgroundLedger(store) {
    const now = store.currentTimeMs(), scope = ledgerScope(now);
    if (store.readPreanalysisControl({ kind: 'anchor' }))
        throw new ReportBackgroundLedgerError('already_initialized', '后台总账已初始化，禁止清零');
    const keys = store.listPreanalysisControlKeys();
    if (keys.some(key => key.kind !== 'day' || key.date !== scope.date) || keys.length > 1)
        throw new ReportBackgroundLedgerError('untrusted', '缺失锚点但已有历史日账，禁止重新建零账');
    const existing = store.readPreanalysisControl({ kind: 'day', date: scope.date });
    if (existing) {
        const value = decodeLedgerDay(existing, scope);
        if (value.entries.length || value.schedules.length || value.pausedGroups.length || value.globalPaused)
            throw new ReportBackgroundLedgerError('untrusted', '缺失锚点且日账非空，禁止重新初始化');
    }
    else if (keys.length)
        throw new ReportBackgroundLedgerError('untrusted', '已发布日账不可读取，禁止重新初始化');
    else
        store.writePreanalysisControl({ kind: 'day', date: scope.date }, null, emptyLedgerDay(scope));
    store.writePreanalysisControl({ kind: 'anchor' }, null, { version: 'background-ledger-anchor-1', latest: scope, previous: null });
}
class ReportBackgroundLedger {
    // 每个后台任务只有一个封闭分类单元，原九十秒与冻结政策不能被新实例续期。
    constructor(options) {
        this.options = options;
        this.options = Object.freeze({ ...options });
        this.policy = JSON.parse(JSON.stringify(options.policy));
        (0, report_cache_provenance_1.assertReportCachePolicy)(this.policy);
        if (!Number.isSafeInteger(options.startedAtMs) || options.store.taskIdentity.deadlineMs !== options.startedAtMs + 90000
            || !LEDGER_HASH.test(options.unitIdentity) || typeof options.hasForegroundPending !== 'function')
            throw new ReportBackgroundLedgerError('contract', '后台任务必须使用原九十秒和一个明确单元');
        this.owner = (0, report_cache_provenance_1.reportCacheDigest)(options.store.taskIdentity.taskId);
        this.channel = (0, report_cache_provenance_1.reportCacheDigest)(options.store.taskIdentity.channelKey);
    }
    // 可信锚点向当前新日推进，先写空日账再更新锚点；不能重新补建已声明当日。
    activeDay() {
        const now = this.options.store.currentTimeMs(), scope = ledgerScope(now);
        const anchorControl = this.options.store.readPreanalysisControl({ kind: 'anchor' });
        if (!anchorControl)
            throw new ReportBackgroundLedgerError('not_initialized', '后台总账锚点缺失，停止后台请求；不能运行时自动建账');
        let anchor = decodeLedgerAnchor(anchorControl);
        if (scope.startMs < anchor.latest.startMs)
            throw new ReportBackgroundLedgerError('clock_rewind', '后台业务日回拨，停止请求');
        let control = this.options.store.readPreanalysisControl({ kind: 'day', date: scope.date });
        if (scope.startMs > anchor.latest.startMs) {
            if (control) {
                const existing = decodeLedgerDay(control, scope);
                if (existing.entries.length || existing.schedules.length || existing.pausedGroups.length || existing.globalPaused)
                    throw new ReportBackgroundLedgerError('untrusted', '新业务日已有非空孤立账本，禁止覆盖');
            }
            else
                control = this.options.store.writePreanalysisControl({ kind: 'day', date: scope.date }, null, emptyLedgerDay(scope));
            anchor = { version: 'background-ledger-anchor-1', latest: scope, previous: anchor.latest };
            this.options.store.writePreanalysisControl({ kind: 'anchor' }, anchorControl.identity, anchor);
        }
        if (!control)
            throw new ReportBackgroundLedgerError('missing_day', '锚点已声明的当日日账缺失，停止后台请求');
        return { control, value: decodeLedgerDay(control, scope), anchor, now };
    }
    // 四点边界附近读取前一可信日账，保留五分钟间隔及跨日同任务两次上限。
    relatedDays(active) {
        const previous = active.anchor.previous;
        if (!previous || previous.endMs !== active.value.scope.startMs
            || active.now - active.value.scope.startMs >= 300000 && this.options.startedAtMs >= active.value.scope.startMs)
            return [active.value];
        const control = this.options.store.readPreanalysisControl({ kind: 'day', date: previous.date });
        if (!control)
            throw new ReportBackgroundLedgerError('missing_day', '业务日交界的前一账本不可读，停止后台请求');
        return [decodeLedgerDay(control, previous), active.value];
    }
    // 排队前使用可信日账，未发请求的失败提交也保留跨重启的五分钟调度间隔。
    schedulingState() {
        const active = this.activeDay(), days = this.relatedDays(active);
        const schedules = days.flatMap(day => day.schedules).filter(row => row.channel === this.channel);
        const entries = days.flatMap(day => day.entries).filter(row => row.channel === this.channel);
        const lastScheduledAtMs = schedules.length ? Math.max(...schedules.map(row => row.scheduledAtMs)) : null;
        const reason = this.options.hasForegroundPending() ? 'foreground'
            : active.value.globalPaused || active.value.pausedGroups.includes(this.channel) ? 'paused'
                : active.value.entries.length >= 80 ? 'global_limit'
                    : active.value.entries.filter(row => row.channel === this.channel).length >= 20 ? 'group_limit'
                        : active.value.entries.some(row => row.channel === this.channel && row.status === 'reserved') ? 'unresolved'
                            : schedules.some(row => active.now - row.scheduledAtMs < 300000) || entries.some(row => active.now - row.startedAtMs < 300000) ? 'cooldown' : '';
        return { allowed: !reason, reason, lastScheduledAtMs };
    }
    // 必须先落调度记录再提交S2；提交失败不撤销间隔，记录不占实际上游请求额度。
    recordSchedule() {
        const state = this.schedulingState();
        if (!state.allowed)
            throw new ReportBackgroundLedgerError(state.reason, '后台排队条件未满足：' + state.reason);
        const active = this.activeDay();
        const value = { ...active.value, schedules: [...active.value.schedules.filter(row => row.channel !== this.channel),
                { channel: this.channel, owner: this.owner, scheduledAtMs: active.now }] };
        decodeLedgerDay({ ...active.control, updatedAtMs: active.now, value }, active.value.scope);
        this.options.store.writePreanalysisControl({ kind: 'day', date: active.value.scope.date }, active.control.identity, value);
    }
    // 返回当前已持久化计数，未知预留继续占额，历史用量不计入前台请求。
    snapshot() {
        const { value } = this.activeDay();
        return { groupUsed: value.entries.filter(entry => entry.channel === this.channel).length, globalUsed: value.entries.length,
            groupPaused: value.pausedGroups.includes(this.channel), globalPaused: value.globalPaused,
            unresolved: value.entries.filter(entry => entry.channel === this.channel && entry.status === 'reserved').length };
    }
    // 在真实上游回调之前原子预留一个请求，任一门槛失败都不允许提交网络请求。
    reserve(attempt, requestIdentity, step) {
        if (this.options.hasForegroundPending())
            throw new ReportBackgroundLedgerError('foreground', '前台日报待运行，后台不启动新请求');
        const active = this.activeDay(), days = this.relatedDays(active), related = days.flatMap(day => day.entries), own = related.filter(entry => entry.owner === this.owner);
        const node = attempt === 1 ? this.policy.first : this.policy.recovery;
        if (![1, 2].includes(attempt) || !LEDGER_HASH.test(requestIdentity) || !step || step.routeIdentity !== node.routeIdentity
            || step.routeRevision !== node.routeRevision || step.provider !== node.provider || step.model !== node.model || step.protocol !== node.protocol
            || step.stepIndex !== 0 || step.priorityIndex !== 0 || !LEDGER_HASH.test(step.configurationIdentity))
            throw new ReportBackgroundLedgerError('contract', '后台预留节点或实际请求身份不属于冻结单节点政策');
        if (active.now < this.options.startedAtMs || own.length !== attempt - 1 || own.some(entry => entry.attempt !== 1 || entry.channel !== this.channel || entry.unit !== this.options.unitIdentity
            || entry.policyIdentity !== this.policy.identity || entry.startedAtMs !== this.options.startedAtMs || entry.deadlineMs !== this.options.store.taskIdentity.deadlineMs)) {
            throw new ReportBackgroundLedgerError('task_limit', '后台同一原任务最多两次实际请求，不能重复领取或另开单元');
        }
        if (own.some(entry => entry.status === 'reserved'))
            throw new ReportBackgroundLedgerError('in_flight', '后台上一请求尚未结算，不能并发启动恢复');
        if (attempt === 1 && related.some(entry => entry.channel === this.channel && this.options.startedAtMs - entry.startedAtMs < 300000))
            throw new ReportBackgroundLedgerError('cooldown', '同群两次后台任务起点必须至少相隔五分钟');
        if (attempt === 1 && days.some(day => day.schedules.some(row => row.channel === this.channel && row.owner !== this.owner
            && this.options.startedAtMs - row.scheduledAtMs < 300000)))
            throw new ReportBackgroundLedgerError('cooldown', '其他后台任务已占本群五分钟调度间隔');
        if (active.value.globalPaused || active.value.pausedGroups.includes(this.channel))
            throw new ReportBackgroundLedgerError('paused', '后台本业务日已因明确额度错误暂停');
        if (active.value.entries.length >= 80)
            throw new ReportBackgroundLedgerError('global_limit', '后台全局本业务日八十次额度已用尽');
        if (active.value.entries.filter(entry => entry.channel === this.channel).length >= 20)
            throw new ReportBackgroundLedgerError('group_limit', '后台单群本业务日二十次额度已用尽');
        const id = (0, report_cache_provenance_1.reportCacheDigest)({ date: active.value.scope.date, owner: this.owner, unit: this.options.unitIdentity, attempt, requestIdentity, routeIdentity: node.routeIdentity });
        const entry = { id, owner: this.owner, channel: this.channel, unit: this.options.unitIdentity, attempt, requestIdentity,
            policyIdentity: this.policy.identity, routeIdentity: node.routeIdentity, configurationIdentity: step.configurationIdentity,
            startedAtMs: this.options.startedAtMs, deadlineMs: this.options.store.taskIdentity.deadlineMs, reservedAtMs: active.now,
            status: 'reserved', settledAtMs: null, usage: null, quotaFailure: 'none' };
        if (this.options.hasForegroundPending())
            throw new ReportBackgroundLedgerError('foreground', '前台日报已到达，后台不预留新请求');
        const value = { ...active.value, entries: [...active.value.entries, entry] };
        decodeLedgerDay({ ...active.control, value }, active.value.scope);
        this.options.store.writePreanalysisControl({ kind: 'day', date: active.value.scope.date }, active.control.identity, value);
        return { date: active.value.scope.date, id };
    }
    // 记录实际上游返回/失败/取消与可读用量；不退款，只有明确额度分类才暂停当日后台。
    settle(reservation, status, usage, quotaFailure = 'none') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(reservation.date) || !LEDGER_HASH.test(reservation.id))
            throw new ReportBackgroundLedgerError('contract', '后台结算引用无效');
        const now = this.options.store.currentTimeMs(), scope = ledgerScope(Date.parse(reservation.date + 'T04:00:00+08:00'));
        if (scope.date !== reservation.date)
            throw new ReportBackgroundLedgerError('contract', '后台结算日期无效');
        const control = this.options.store.readPreanalysisControl({ kind: 'day', date: scope.date });
        if (!control)
            throw new ReportBackgroundLedgerError('missing_day', '预留所属日账不可读，不能伪造结算');
        const value = decodeLedgerDay(control, scope), entry = value.entries.find(item => item.id === reservation.id);
        if (!entry || entry.owner !== this.owner || entry.channel !== this.channel || entry.unit !== this.options.unitIdentity || entry.policyIdentity !== this.policy.identity
            || entry.startedAtMs !== this.options.startedAtMs || entry.deadlineMs !== this.options.store.taskIdentity.deadlineMs || !['returned', 'failed', 'cancelled'].includes(status)
            || !['none', 'group', 'global'].includes(quotaFailure) || quotaFailure !== 'none' && status !== 'failed')
            throw new ReportBackgroundLedgerError('contract', '后台结算不属于本次原任务或明确状态');
        assertLedgerUsage(usage);
        if (entry.status !== 'reserved') {
            if (entry.status === status && (0, report_cache_provenance_1.reportCacheDigest)(entry.usage) === (0, report_cache_provenance_1.reportCacheDigest)(usage) && entry.quotaFailure === quotaFailure)
                return;
            throw new ReportBackgroundLedgerError('contract', '后台预留已结算，不能改写历史结果');
        }
        const entries = value.entries.map(item => item === entry ? { ...item, status, usage, quotaFailure, settledAtMs: now } : item);
        const updated = { ...value, entries, pausedGroups: quotaFailure === 'none' ? value.pausedGroups : [...new Set([...value.pausedGroups, this.channel])],
            globalPaused: value.globalPaused || quotaFailure === 'global' };
        decodeLedgerDay({ ...control, value: updated }, scope);
        this.options.store.writePreanalysisControl({ kind: 'day', date: scope.date }, control.identity, updated);
    }
}
exports.ReportBackgroundLedger = ReportBackgroundLedger;
