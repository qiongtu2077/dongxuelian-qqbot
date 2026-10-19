"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReportBackgroundBatch = runReportBackgroundBatch;
const report_classification_cache_1 = require("./report-classification-cache");
const report_background_ledger_1 = require("./report-background-ledger");
const report_batch_catalog_1 = require("./report-batch-catalog");
const report_bindings_1 = require("./report-bindings");
const report_candidates_1 = require("./report-candidates");
const complete_input_1 = require("./complete-input");
const report_request_pool_1 = require("./report-request-pool");
const report_cache_provenance_1 = require("./report-cache-provenance");
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { createReportAnalysisDiagnostics, ReportAnalysisError } = loadManagementModule('daily.reportAnalysis');
// 一次最多一个完整封闭批次；同一分类输入、永久来源与政策才能被前台精确采用。
async function runReportBackgroundBatch(options) {
    const { store, snapshot, context } = options, { taskId, channelKey, deadlineMs } = store.taskIdentity;
    if (deadlineMs !== options.startedAtMs + 90000 || !Number.isSafeInteger(options.startedAtMs)
        || context.sourceCompleteness !== 'complete' || !snapshot.hasStableMessageIds || options.catalog.scope.channelKey !== channelKey
        || context.period.periodStartMs !== options.catalog.scope.periodStartMs || context.period.periodEndMs !== options.catalog.scope.periodEndMs) {
        throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台批次需要同群完整永久来源、相同业务范围及原九十秒任务');
    }
    const controller = new AbortController(), pool = new report_request_pool_1.ReportRequestPool(1);
    // 检查同时覆盖内存信号、持久任务领取、S0和原时刻，缓存命中也不能绕过。
    const assertWork = () => {
        if (controller.signal.aborted || options.signal?.aborted)
            throw controller.signal.reason || options.signal?.reason || new Error('后台任务已取消');
        const now = store.currentTimeMs();
        if (now < options.startedAtMs)
            throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台任务起点不能在未来');
        return now;
    };
    const onAbort = () => controller.abort(options.signal?.reason || new Error('后台任务已取消'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
        const now = assertWork();
        timer = setTimeout(() => controller.abort(new Error('后台任务原九十秒截止')), deadlineMs - now);
        if (options.hasForegroundPending())
            throw new report_background_ledger_1.ReportBackgroundLedgerError('foreground', '前台日报待运行，后台不启动分类');
        const cache = new report_classification_cache_1.ReportClassificationCache({ store, snapshot, snapshotCommit: options.snapshotCommit, context, policy: options.policy, onDiagnostic: options.onDiagnostic });
        if (!cache.enabled)
            throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台分类必须具备可信缓存发布资格，不能仅生成不可复用结果');
        const views = (0, report_batch_catalog_1.selectReportCatalogBatches)(options.catalog, snapshot);
        let skippedCached = 0;
        for (const view of views) {
            assertWork();
            if (!view.complete || !view.sealed || !view.batch)
                continue;
            if (options.hasForegroundPending())
                throw new report_background_ledger_1.ReportBackgroundLedgerError('foreground', '前台日报已到达，后台不启动下一批');
            const batch = view.batch;
            if (cache.read(snapshot, batch, view.ruleIdentity)) {
                skippedCached++;
                assertWork();
                continue;
            }
            const system = (0, report_candidates_1.getReportClassificationInstructions)();
            const identity = (0, report_bindings_1.createClassificationRequestIdentity)(snapshot, batch, { channelKey, periodStartMs: context.period.periodStartMs,
                periodEndMs: context.period.periodEndMs, sourceCompleteness: context.sourceCompleteness, modelPolicyIdentity: options.policy.identity,
                batchRuleIdentity: view.ruleIdentity, system, maxTokens: 4096 });
            if (!identity)
                throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台分类缺少精确实际请求身份');
            const ledger = new report_background_ledger_1.ReportBackgroundLedger({ store, startedAtMs: options.startedAtMs, unitIdentity: identity,
                policy: options.policy, hasForegroundPending: options.hasForegroundPending });
            if (ledger.snapshot().unresolved)
                throw new report_background_ledger_1.ReportBackgroundLedgerError('unresolved', '当日存在结果未知的后台预留，停止该群新请求');
            const meta = createReportAnalysisDiagnostics({ reportPeriod: context.period, windowMessageCount: snapshot.sources.length,
                selectedMessageCount: batch.fragments.length, sourceCompleteness: 'complete' });
            meta.batchCount = 1;
            meta.analysisState = 'processing';
            let round = 0, responseReceived = false, commitId = null;
            const runtime = {
                deadlineMs, workDeadlineMs: deadlineMs, signal: controller.signal, now: () => store.currentTimeMs(), maxRequestCount: 2,
                recoveryInstructions: '仅返回当前明确契约的一个完整JSON对象，completed必须为true，不使用旧JSONL或end记录。',
                shouldRecover: error => responseReceived && !(error instanceof report_request_pool_1.ReportRequestBoundaryError),
                onUnitCompleted(_unit, attempts, value) {
                    assertWork();
                    commitId = cache.save(snapshot, batch, view.ruleIdentity, attempts, value);
                    if (!commitId)
                        throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台分类实际来源不可验证，禁止标记完成');
                    assertWork();
                },
                request: async (requestSystem, input, maxTokens, extra) => {
                    assertWork();
                    responseReceived = false;
                    const attempt = ++round;
                    if (round > 2 || Array.from(requestSystem + input).length > 16000)
                        throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台分类请求次数或完整材料超限');
                    return pool.run(extra.signal, async () => {
                        let reservation, execution, submitted = false;
                        const onAttempt = extra._onRequestAttempt;
                        const onExecution = extra._onRequestExecution;
                        try {
                            const text = await options.request('classification', attempt, requestSystem, input, maxTokens, { ...extra,
                                _onRequestAttempt(step) {
                                    assertWork();
                                    if (submitted || !step)
                                        throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台请求拒绝隐藏重试及未知执行节点');
                                    reservation = ledger.reserve(attempt, (0, report_cache_provenance_1.reportCacheDigest)({ system: requestSystem, input, maxTokens, identity, attempt }), step);
                                    submitted = true;
                                    onAttempt(step);
                                },
                                _onRequestExecution(value) { execution = value; onExecution(value); },
                            });
                            if (!reservation)
                                throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台请求没有实际提交回调，不能核对计额');
                            assertWork();
                            // 已收到文本但结构无效同样计额；结构读取与唯一恢复在共用引擎内处理。
                            try {
                                ledger.settle(reservation, 'returned', execution?.usage || null);
                            }
                            catch (error) {
                                throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台请求结算持久化失败：' + (error instanceof Error ? error.message : String(error)));
                            }
                            responseReceived = true;
                            return text;
                        }
                        catch (error) {
                            if (reservation && !responseReceived) {
                                // 无法确认仍有效时保留未知预留；失效任务不能借结算写回文件。
                                assertWork();
                                if (error instanceof report_request_pool_1.ReportRequestBoundaryError && error.kind === 'contract')
                                    throw error;
                                const quota = error instanceof report_request_pool_1.ReportRequestBoundaryError ? options.classifyQuotaFailure?.(error) || 'none' : 'none';
                                try {
                                    ledger.settle(reservation, 'failed', execution?.usage || null, quota);
                                }
                                catch (failure) {
                                    throw new report_request_pool_1.ReportRequestBoundaryError('contract', '后台失败结算持久化失败：' + (failure instanceof Error ? failure.message : String(failure)));
                                }
                            }
                            throw error;
                        }
                    });
                },
            };
            await (0, complete_input_1.requestAnalysisUnit)(runtime, meta, { id: view.catalogId, stage: 'classification', sourceIds: [...new Set(batch.fragments.map(fragment => fragment.sourceId))],
                timestamps: batch.fragments.map(fragment => snapshot.sources[fragment.sourceId - 1].ts).filter(Number.isFinite) }, system, batch.input, 4096, 45000, text => (0, report_candidates_1.readReportClassification)(text, batch), error => (0, report_candidates_1.createReportClassificationRepair)(error, batch));
            assertWork();
            if (!commitId)
                throw new ReportAnalysisError('后台分类未发布可信清单', 'generation_failed', 'classification', meta);
            return { status: 'complete', reason: 'classified', catalogId: view.catalogId, commitId, requestCount: meta.requestCount,
                recoveryCount: meta.retryCount, skippedCached, processedMessageCount: new Set(batch.fragments.map(fragment => fragment.sourceId)).size };
        }
        return { status: 'idle', reason: 'no_unfinished_closed_batch', catalogId: null, commitId: null, requestCount: 0, recoveryCount: 0, skippedCached, processedMessageCount: 0 };
    }
    finally {
        if (timer)
            clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        controller.abort(new Error('后台分类已结束'));
        await pool.drain();
    }
}
