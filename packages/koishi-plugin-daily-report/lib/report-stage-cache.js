"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportStageCache = void 0;
/**
 * MODULE: 日报整理、选题及四类输出的可信交换缓存。
 * 职责: 永久绑定表、原生成快照、实际节点和原读取器共同校验/重放。
 * 边界: 当前上游必须重建相同实际供料；不猜字段、不请求模型或改写自由文字。
 */
const util_1 = require("util");
const report_storage_1 = require("./report-storage");
const report_snapshots_1 = require("./report-snapshots");
const report_stage_bindings_1 = require("./report-stage-bindings");
const report_cache_provenance_1 = require("./report-cache-provenance");
const report_exchange_1 = require("./report-exchange");
const STAGE_CACHE_HASH = /^[a-f0-9]{64}$/;
const CACHED_STAGES = ['grouping', 'selection', 'overview', 'quotes', 'portraits', 'review'];
// --- 分页交换记录 ---
// 永久表逐完整记录分页，避免大概述将数千来源塞进单个元数据对象。
function stageCacheRecords(bindings, exchange) {
    return [{ type: 'header', version: bindings.version, material: bindings.material },
        ...bindings.fragments.map(value => ({ type: 'fragment', value })), ...bindings.provenance.map(key => ({ type: 'provenance', key })),
        ...bindings.sources.map(value => ({ type: 'source', value })), ...bindings.candidates.map(value => ({ type: 'candidate', value })),
        ...bindings.members.map(value => ({ type: 'member', value })), ...bindings.targets.map(alias => ({ type: 'target', alias })),
        ...bindings.statistics.map(value => ({ type: 'statistic', value })), { type: 'exchange', value: exchange }];
}
// 根结构只有一种版本与明确标签；未知记录不能作为空模块或旧缓存兼容读取。
function decodeStageCacheRecords(records) {
    const first = records[0];
    (0, report_exchange_1.assertReportFields)(first, ['type', 'version', 'material'], '阶段缓存头');
    if (first.type !== 'header' || first.version !== 'stage-bindings-1' || !['topic-raw', 'topic-summary', 'topic-comparison', 'output'].includes(first.material))
        throw new Error('阶段缓存绑定版本或材料类型无效');
    const bindings = { version: 'stage-bindings-1', material: first.material,
        fragments: [], provenance: [], sources: [], candidates: [], members: [], targets: [], statistics: [] };
    let exchange;
    for (const row of records.slice(1)) {
        const record = row;
        if (!record || typeof record.type !== 'string' || exchange)
            throw new Error('阶段缓存记录类型或顺序无效');
        if (record.type === 'provenance') {
            (0, report_exchange_1.assertReportFields)(record, ['type', 'key'], '阶段来源引用');
            if (typeof record.key !== 'string')
                throw new Error('阶段来源引用无效');
            bindings.provenance.push(record.key);
            continue;
        }
        if (record.type === 'target') {
            (0, report_exchange_1.assertReportFields)(record, ['type', 'alias'], '阶段成员目标');
            if (typeof record.alias !== 'string')
                throw new Error('阶段成员目标无效');
            bindings.targets.push(record.alias);
            continue;
        }
        (0, report_exchange_1.assertReportFields)(record, ['type', 'value'], '阶段交换记录');
        if (record.type === 'fragment')
            bindings.fragments.push(record.value);
        else if (record.type === 'source')
            bindings.sources.push(record.value);
        else if (record.type === 'candidate')
            bindings.candidates.push(record.value);
        else if (record.type === 'member')
            bindings.members.push(record.value);
        else if (record.type === 'statistic')
            bindings.statistics.push(record.value);
        else if (record.type === 'exchange')
            exchange = record.value;
        else
            throw new Error('阶段缓存含未知记录');
    }
    if (!exchange)
        throw new Error('阶段缓存缺少完整交换结果');
    return { bindings, exchange };
}
// 重放相同读取器和唯一恢复，所有结构化成员/来源均由本次上下文恢复。
function replayStageExchange(exchange, count, validate, recover) {
    (0, report_exchange_1.assertReportFields)(exchange, ['recovery', 'responses'], '阶段恢复交换');
    if (!Array.isArray(exchange.responses) || exchange.responses.some(response => typeof response !== 'string'))
        throw new Error('阶段缓存交换正文无效');
    if (count === 1 && exchange.recovery === 'none' && exchange.responses.length === 1)
        return validate(exchange.responses[0]);
    if (count === 2 && exchange.recovery === 'full' && exchange.responses.length === 1)
        return validate(exchange.responses[0]);
    if (count === 2 && exchange.recovery === 'targeted' && exchange.responses.length === 2) {
        let error;
        try {
            validate(exchange.responses[0]);
        }
        catch (failure) {
            error = failure;
        }
        const repair = error !== undefined ? recover?.(error) : undefined;
        if (!repair)
            throw new Error('阶段缓存定向恢复不能在当前契约重建');
        return repair.validate(exchange.responses[1]);
    }
    throw new Error('阶段缓存实际次数与恢复交换不一致');
}
// 只保留恢复确实需要的合法首轮片段；完整恢复的非法原返回不重复保存。
function createStageExchange(attempts, value, validate, recover, requireNormalFinish = false) {
    let exchange = { recovery: 'none', responses: [attempts[0].response] };
    if (attempts.length === 2) {
        let failure;
        if (attempts[0].execution?.finishReason !== 'length' && (!requireNormalFinish || (attempts[0].execution?.finishReasonReadable && attempts[0].execution.finishReason === 'stop'))) {
            try {
                validate(attempts[0].response);
            }
            catch (error) {
                failure = error;
            }
            if (!failure)
                throw new Error('阶段缓存首轮已成功却出现额外恢复');
        }
        const targeted = failure !== undefined ? recover?.(failure) : undefined;
        exchange = targeted ? { recovery: 'targeted', responses: attempts.map(attempt => attempt.response) }
            : { recovery: 'full', responses: [attempts[1].response] };
    }
    if (!(0, util_1.isDeepStrictEqual)(replayStageExchange(exchange, attempts.length, validate, recover), value))
        throw new Error('阶段缓存重建结果与当前合法结果不一致');
    return exchange;
}
// --- 可信缓存入口 ---
class ReportStageCache {
    // 当前完整来源先冻结并保护；历史未知来源保持禁用，不借缓存提升完整性。
    constructor(options) {
        this.options = options;
        this.candidates = [];
        this.options = Object.freeze({ ...options, context: JSON.parse(JSON.stringify(options.context)) });
        this.taskIdentity = options.store.taskIdentity;
        this.policies = JSON.parse(JSON.stringify(options.policies));
        CACHED_STAGES.forEach(stage => (0, report_cache_provenance_1.assertReportCachePolicy)(this.policies[stage]));
        this.enabled = options.context.sourceCompleteness === 'complete' && options.snapshot.hasStableMessageIds;
        if (!this.enabled)
            return;
        const current = options.store.read(options.snapshotCommit, 'snapshot', (metadata, records) => {
            const decoded = (0, report_snapshots_1.decodeReportSnapshot)(metadata, records);
            if (!(0, util_1.isDeepStrictEqual)(decoded.context, options.context) || !(0, util_1.isDeepStrictEqual)(decoded.evidence.sources, options.snapshot.sources))
                throw new Error('阶段缓存缺少本次完整真实来源');
        });
        if (!current)
            throw new Error('阶段缓存必要来源快照缺失或过期');
        const index = options.store.listUnitLocators();
        if (!index.publishable) {
            this.enabled = false;
            this.diagnostic('locator_unavailable', '', '定位索引发布失败，禁用本次跨任务缓存');
            return;
        }
        this.candidates.push(...index.candidates);
        index.invalidIds.forEach(id => this.diagnostic('invalid_commit', id, '阶段定位清单损坏'));
    }
    // 可选审计不能覆盖实际任务或文件错误，不输出正文、凭据或未知文件名。
    diagnostic(code, id, message) {
        try {
            this.options.onDiagnostic?.(code, STAGE_CACHE_HASH.test(id) ? id : 'invalid-file', message.slice(0, 200));
        }
        catch { /* 可选审计不改变任务结果。 */ }
    }
    // 实际请求、永久绑定、报告模式、规则及单节点政策共同决定身份，不含任务编号或截止。
    identity(snapshot, request) {
        if (!(0, util_1.isDeepStrictEqual)(snapshot.sources, this.options.snapshot.sources) || !(0, util_1.isDeepStrictEqual)(snapshot.fragments, this.options.snapshot.fragments))
            throw new Error('阶段缓存不属于当前固定输入');
        if (!CACHED_STAGES.includes(request.stage) || !['ordinary', 'detailed'].includes(request.mode) || !request.system || !request.input
            || request.maxTokens !== (['grouping', 'selection'].includes(request.stage) ? 4096 : 2048))
            throw new Error('阶段缓存实际请求条件无效');
        (0, report_stage_bindings_1.verifyReportStageOrigin)(snapshot, request.bindings);
        return (0, report_cache_provenance_1.reportCacheDigest)({ version: 'stage-request-1', analysisVersion: 'grounded-report-1', stage: request.stage, mode: request.mode,
            channelKey: this.taskIdentity.channelKey, periodStartMs: this.options.context.period.periodStartMs, periodEndMs: this.options.context.period.periodEndMs,
            system: request.system, input: request.input, bindings: request.bindings, policyIdentity: this.policies[request.stage].identity,
            parameters: { temperature: 0.2, thinking: false, maxTokens: request.maxTokens,
                ...(request.requireNormalFinish ? { requireNormalFinish: true } : {}) } });
    }
    // 输出摘要和永久表均须匹配当前实际材料，再重放原契约恢复本次来源/成员。
    validate(metadata, records, identity, request, validate, recover) {
        (0, report_exchange_1.assertReportFields)(metadata, ['version', 'stage', 'mode', 'requestIdentity', 'policyIdentity', 'sourceSnapshotCommit', 'origin', 'productIdentity', 'actualAttempts'], '阶段缓存清单');
        const value = metadata, policy = this.policies[request.stage];
        if (value.version !== 'stage-cache-1' || value.stage !== request.stage || value.mode !== request.mode || value.requestIdentity !== identity
            || value.policyIdentity !== policy.identity || !STAGE_CACHE_HASH.test(value.sourceSnapshotCommit) || !value.origin?.taskId
            || !Number.isFinite(value.origin.deadlineMs))
            throw new Error('阶段缓存版本、实际条件或来源任务不一致');
        (0, report_cache_provenance_1.assertReportCacheAttempts)(value.actualAttempts, policy);
        const lastExecution = value.actualAttempts[value.actualAttempts.length - 1].execution;
        if (request.requireNormalFinish && (!lastExecution.finishReasonReadable || lastExecution.finishReason !== 'stop'))
            throw new Error('阶段缓存缺少可验证的正常结束');
        if (value.productIdentity !== (0, report_cache_provenance_1.reportCacheDigest)({ requestIdentity: identity, policyIdentity: policy.identity, records, actualAttempts: value.actualAttempts }))
            throw new Error('阶段可信产物摘要不一致');
        const decoded = decodeStageCacheRecords(records);
        if (!(0, util_1.isDeepStrictEqual)(decoded.bindings, request.bindings))
            throw new Error('阶段缓存永久来源或人物别名所有权变化');
        return replayStageExchange(decoded.exchange, value.actualAttempts.length, validate, recover);
    }
    // 原始见证必须完整且同业务范围；摘要还必须由当前已成功上游重建相同请求才能命中。
    validateSource(metadata, records, bindings) {
        const original = (0, report_snapshots_1.decodeReportSnapshot)(metadata, records);
        if (original.context.sourceCompleteness !== 'complete' || original.context.period.periodStartMs !== this.options.context.period.periodStartMs
            || original.context.period.periodEndMs !== this.options.context.period.periodEndMs)
            throw new Error('阶段缓存原始来源完整性或业务窗口变化');
        (0, report_stage_bindings_1.verifyReportStageOrigin)(original.evidence, bindings);
    }
    // 只读预检可明确失效损坏缓存；采用时再次保护与校验，必要发布失败必须传播。
    read(snapshot, request, validate, recover) {
        if (!this.enabled)
            return null;
        const identity = this.identity(snapshot, request), policy = this.policies[request.stage];
        const candidates = this.candidates.filter(candidate => {
            const value = candidate.metadata;
            return value?.version === 'stage-cache-1' && value.requestIdentity === identity && value.policyIdentity === policy.identity;
        }).sort((a, b) => {
            const rank = (metadata) => metadata.lastRouteIdentity === policy.first.routeIdentity ? 0 : 1;
            return rank(a.metadata) - rank(b.metadata) || a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id);
        });
        for (const candidate of candidates) {
            let value;
            try {
                const unit = this.options.store.inspect(candidate.id, 'unit', (metadata, records) => this.validate(metadata, records, identity, request, validate, recover));
                if (!unit)
                    continue;
                value = unit.metadata;
                if (!this.options.store.inspect(value.sourceSnapshotCommit, 'snapshot', (metadata, records) => this.validateSource(metadata, records, request.bindings))) {
                    this.diagnostic('source_unavailable', candidate.id, '阶段原始来源快照已缺失或过期');
                    continue;
                }
            }
            catch (error) {
                if (!(error instanceof report_storage_1.ReportStoredDataError))
                    throw error;
                this.diagnostic('invalid_cache_data', candidate.id, error.message);
                continue;
            }
            if (!this.options.store.read(value.sourceSnapshotCommit, 'snapshot', (metadata, records) => this.validateSource(metadata, records, request.bindings)))
                throw new Error('阶段缓存采用前原来源失效');
            let restored;
            const unit = this.options.store.read(candidate.id, 'unit', (metadata, records) => { restored = this.validate(metadata, records, identity, request, validate, recover); });
            if (!unit)
                throw new Error('阶段缓存采用前提交失效');
            return { value: restored, history: { stage: request.stage, commitId: candidate.id, sourceSnapshotCommit: value.sourceSnapshotCommit,
                    origin: value.origin, actualAttempts: value.actualAttempts } };
        }
        return null;
    }
    // 校验实际节点与可重建交换后保存，成功返回前必须完成末尾清单及任务保护发布。
    save(snapshot, request, attempts, result, validate, recover) {
        if (!this.enabled)
            return null;
        const identity = this.identity(snapshot, request), policy = this.policies[request.stage];
        let actualAttempts;
        try {
            actualAttempts = (0, report_cache_provenance_1.verifyReportCacheAttempts)(attempts, policy, request.system, request.input, request.maxTokens);
        }
        catch (error) {
            this.diagnostic('actual_model_unverified', identity, error instanceof Error ? error.message : String(error));
            return null;
        }
        const exchange = createStageExchange(attempts, result, validate, recover, request.requireNormalFinish), records = stageCacheRecords(request.bindings, exchange);
        const metadata = { version: 'stage-cache-1', stage: request.stage, mode: request.mode, requestIdentity: identity,
            policyIdentity: policy.identity, sourceSnapshotCommit: this.options.snapshotCommit,
            origin: { taskId: this.taskIdentity.taskId, deadlineMs: this.taskIdentity.deadlineMs }, actualAttempts,
            productIdentity: (0, report_cache_provenance_1.reportCacheDigest)({ requestIdentity: identity, policyIdentity: policy.identity, records, actualAttempts }) };
        const id = this.options.store.commit('unit', metadata, records, (value, rows) => this.validate(value, rows, identity, request, validate, recover), 'unit-record-fragments-1');
        const committed = this.options.store.inspect(id, 'unit', (value, rows) => this.validate(value, rows, identity, request, validate, recover));
        const locator = (0, report_storage_1.projectReportUnitLocator)(metadata);
        if (locator)
            this.candidates.push({ id, metadata: locator, createdAtMs: committed.createdAtMs });
        return id;
    }
}
exports.ReportStageCache = ReportStageCache;
