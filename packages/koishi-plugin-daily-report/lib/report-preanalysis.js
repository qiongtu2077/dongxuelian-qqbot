"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planReportPreanalysisTask = planReportPreanalysisTask;
exports.runReportPreanalysisTask = runReportPreanalysisTask;
/**
 * MODULE: 日报后台任务的真实原始输入与单批执行入口。
 * 边界: 调用方持有S0及有效S2领取；不启用开关、不建账、不投递。
 */
const { collectReportData } = require('./data-collector');
const report_evidence_1 = require("./report-evidence");
const report_storage_1 = require("./report-storage");
const report_snapshots_1 = require("./report-snapshots");
const report_batch_catalog_1 = require("./report-batch-catalog");
const report_model_1 = require("./report-model");
const report_grounded_entry_1 = require("./report-grounded-entry");
const report_background_1 = require("./report-background");
const report_background_ledger_1 = require("./report-background-ledger");
const report_classification_cache_1 = require("./report-classification-cache");
const report_cache_provenance_1 = require("./report-cache-provenance");
const management_runtime_1 = require("koishi-plugin-dongxuelian-ai/lib/public/management-runtime");
const { createReportPeriod } = (0, management_runtime_1.loadManagementModule)('daily.reportPeriod');
// 规划与执行都限定在本次原始时限及既有独占租约内，不能借复验续期。
function preanalysisStore(options) {
    if (options.deadlineMs !== options.startedAtMs + 90000)
        throw new Error('日报预分析必须沿用原九十秒截止');
    const assertActive = () => {
        if (options.signal.aborted)
            throw options.signal.reason || new Error('日报预分析已取消');
        options.assertActive();
        if (Date.now() >= options.deadlineMs)
            throw new Error('日报预分析已超过原九十秒截止');
    };
    return new report_storage_1.PagedReportStore({ ...options, assertActive });
}
// 完整目录与最新分析材料共用一遍真实索引读取；规划结果不证明模型处理完成。
function preparePreanalysisInput(options, store) {
    store.currentTimeMs();
    const fullMessages = [];
    const data = collectReportData(options.channelKey, options.period, (message, record) => {
        store.currentTimeMs();
        // 目录采用完整窗口，窗口外或未入选的损失记录不能被入选完整性掩盖。
        if (record.bodyComplete !== true || record.recordVersion !== 2 || record.realMessageId !== true) {
            throw new Error('日报预分析完整窗口缺少可信完整正文或永久身份');
        }
        fullMessages.push(message);
    });
    if (!data)
        return null;
    if (data.sourceCompleteness !== 'complete' || fullMessages.length !== data.windowMessageCount)
        throw new Error('日报预分析完整窗口收录不一致');
    const full = (0, report_evidence_1.createReportEvidence)(fullMessages), snapshot = (0, report_evidence_1.createReportEvidence)(data.messages);
    const context = { period: options.period, sourceCompleteness: 'complete',
        statistics: { totalMessages: data.totalMessages, activeMembers: data.activeMembers, emojiCount: data.emojiCount,
            totalChars: data.totalChars, hourlyActivity: data.hourlyActivity, peakHour: data.peakHour, topMembers: data.topMembers } };
    // 按可核验代次读取最新目录；同毫秒连续提交也不能依赖摘要字典序。
    const { value: catalog } = (0, report_batch_catalog_1.updateStoredReportBatchCatalog)(store, full, { channelKey: options.channelKey, period: options.period,
        sourceCompleteness: 'complete', inputScope: 'full_business_window', nowMs: store.currentTimeMs() });
    const snapshotCommit = (0, report_snapshots_1.saveReportSnapshot)(store, snapshot, context);
    return { snapshot, context, snapshotCommit, catalog };
}
// 排队前核对预算与真实未完成封闭批次；零模型请求，成功候选先记录持久化调度间隔。
async function planReportPreanalysisTask(options) {
    const configuration = (0, report_grounded_entry_1.readGroundedReportConfiguration)();
    if (!configuration || process.env.DAILY_REPORT_PREANALYSIS_ENABLED !== '1')
        return { ready: false, reason: 'disabled' };
    const store = preanalysisStore(options);
    store.currentTimeMs();
    if (options.hasForegroundPending())
        return { ready: false, reason: 'foreground' };
    const model = await (0, report_model_1.createGroundedModelRequest)({ configuredNode: configuration });
    const ledger = new report_background_ledger_1.ReportBackgroundLedger({ store, startedAtMs: options.startedAtMs,
        unitIdentity: (0, report_cache_provenance_1.reportCacheDigest)({ purpose: 'planning', taskId: options.taskId }),
        policy: model.classificationCachePolicy, hasForegroundPending: options.hasForegroundPending });
    const state = ledger.schedulingState();
    if (!state.allowed)
        return { ready: false, reason: state.reason };
    const input = preparePreanalysisInput(options, store);
    if (!input)
        return { ready: false, reason: 'no_records' };
    const cache = new report_classification_cache_1.ReportClassificationCache({ store, ...input, policy: model.classificationCachePolicy });
    if (!cache.enabled)
        throw new Error('后台规划缺少可信缓存核验资格');
    for (const view of (0, report_batch_catalog_1.selectReportCatalogBatches)(input.catalog, input.snapshot)) {
        store.currentTimeMs();
        if (!view.complete || !view.sealed || !view.batch)
            continue;
        if (cache.read(input.snapshot, view.batch, view.ruleIdentity))
            continue;
        ledger.recordSchedule();
        return { ready: true, reason: 'unfinished_closed_batch', catalogId: view.catalogId };
    }
    return { ready: false, reason: 'no_unfinished_closed_batch' };
}
// 工作器重新读取真实来源及当前可信产物，仍只执行一个分类单元。
async function runReportPreanalysisTask(options) {
    const configuration = (0, report_grounded_entry_1.readGroundedReportConfiguration)();
    if (!configuration || process.env.DAILY_REPORT_PREANALYSIS_ENABLED !== '1')
        return { status: 'idle', reason: 'disabled' };
    const store = preanalysisStore(options);
    store.currentTimeMs();
    if (options.hasForegroundPending())
        return { status: 'idle', reason: 'foreground_pending' };
    const input = preparePreanalysisInput(options, store);
    if (!input)
        return { status: 'idle', reason: 'no_records' };
    const model = await (0, report_model_1.createGroundedModelRequest)({ configuredNode: configuration });
    store.currentTimeMs();
    const result = await (0, report_background_1.runReportBackgroundBatch)({ store, ...input,
        startedAtMs: options.startedAtMs, signal: options.signal, hasForegroundPending: options.hasForegroundPending,
        policy: model.classificationCachePolicy, request: model.request });
    store.currentTimeMs();
    return { ...result, mode: 'daily_report_preanalysis' };
}
