"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportClassificationCache = void 0;
/**
 * MODULE: 日报可信分类产物与精确跨任务缓存。
 * 职责: 原文快照/请求/实际节点共同校验，永久重绑及历史用量来源。
 * 边界: 当前原始输入须先完整读取；不请求模型、不延长任务、不回写原文。
 */
const util_1 = require("util");
const report_storage_1 = require("./report-storage");
const report_snapshots_1 = require("./report-snapshots");
const report_bindings_1 = require("./report-bindings");
const report_evidence_1 = require("./report-evidence");
const report_candidates_1 = require("./report-candidates");
const report_exchange_1 = require("./report-exchange");
const report_cache_provenance_1 = require("./report-cache-provenance");
const CACHE_HASH = /^[a-f0-9]{64}$/;
// --- 明确版本的永久表分页 ---
// 单条核心/成员/分类完整保存，不把可能增长的绑定数组塞进根清单。
function pagedClassificationRecords(permanent) {
    return [...permanent.core.map((value, index) => ({ type: 'core', index, value })),
        ...permanent.members.map((value, index) => ({ type: 'member', index, value })),
        ...permanent.records.map((value, index) => ({ type: 'classification', index, value }))];
}
// 只读取两种明确格式，全部数量和连续索引通过后交原业务校验器核验所有权。
function decodeClassificationPermanent(value, records) {
    if (value.version === 'classification-cache-1') {
        if (value.bindings.version !== 'permanent-classification-1')
            throw new Error('第一版分类缓存只接受原永久绑定版本');
        return { ...value.bindings, records: records };
    }
    if (!['permanent-classification-1', 'permanent-classification-2'].includes(value.bindingVersion) || [value.coreCount, value.memberCount, value.classificationCount].some(count => !Number.isSafeInteger(count) || count < 0)
        || !value.coreCount || value.coreCount + value.memberCount + value.classificationCount !== records.length)
        throw new Error('分类分页数量或绑定版本不一致');
    let cursor = 0;
    // 三类列表有固定标签和各自索引，不允许跨类别或漏项后顺延绑定。
    const readPagedClassificationRows = (type, count) => {
        const rows = [];
        for (let index = 0; index < count; index++) {
            const row = records[cursor++];
            (0, report_exchange_1.assertReportFields)(row, ['type', 'index', 'value'], '分类永久分页记录');
            if (row.type !== type || row.index !== index)
                throw new Error('分类永久分页顺序或类别错误');
            rows.push(row.value);
        }
        return rows;
    };
    return { version: value.bindingVersion, core: readPagedClassificationRows('core', value.coreCount),
        members: readPagedClassificationRows('member', value.memberCount), records: readPagedClassificationRows('classification', value.classificationCount) };
}
// --- 当前输入与候选索引 ---
class ReportClassificationCache {
    // 必要来源快照先校验和保护；不完整/历史未知来源明确禁用跨任务复用。
    constructor(options) {
        this.options = options;
        this.candidates = [];
        this.options = Object.freeze({ ...options, context: JSON.parse(JSON.stringify(options.context)) });
        this.taskIdentity = options.store.taskIdentity;
        this.policy = JSON.parse(JSON.stringify(options.policy));
        (0, report_cache_provenance_1.assertReportCachePolicy)(this.policy);
        this.enabled = options.context.sourceCompleteness === 'complete' && options.snapshot.hasStableMessageIds;
        if (!this.enabled)
            return;
        const source = options.store.read(options.snapshotCommit, 'snapshot', (metadata, records) => {
            const current = (0, report_snapshots_1.decodeReportSnapshot)(metadata, records);
            if (!(0, util_1.isDeepStrictEqual)(current.context, options.context) || !(0, util_1.isDeepStrictEqual)(current.evidence.sources, options.snapshot.sources))
                throw new Error('分类缓存缺少本次完整真实输入快照');
        });
        if (!source)
            throw new Error('分类缓存必要输入快照缺失或过期');
        const index = options.store.listUnitLocators();
        if (!index.publishable) {
            this.enabled = false;
            this.diagnostic('locator_unavailable', '', '定位索引发布失败，禁用本次跨任务缓存');
            return;
        }
        this.candidates.push(...index.candidates);
        index.invalidIds.forEach(id => this.diagnostic('invalid_commit', id, '定位清单损坏，不作为成功缓存'));
    }
    // 可选诊断失败不会覆盖来源、模型、取消或原始落盘错误。
    diagnostic(code, id, message) {
        try {
            this.options.onDiagnostic?.(code, CACHE_HASH.test(id) ? id : 'invalid-file', message.slice(0, 200));
        }
        catch { /* 可选审计不能改变任务成功或失败。 */ }
    }
    // 使用完整实际供料及稳定批次版本，不把任务身份或当前截止加入请求摘要。
    requestIdentity(snapshot, batch, ruleIdentity) {
        return (0, report_bindings_1.createClassificationRequestIdentity)(snapshot, batch, { channelKey: this.options.store.taskIdentity.channelKey,
            periodStartMs: this.options.context.period.periodStartMs, periodEndMs: this.options.context.period.periodEndMs,
            sourceCompleteness: this.options.context.sourceCompleteness, modelPolicyIdentity: this.policy.identity, batchRuleIdentity: ruleIdentity,
            system: (0, report_candidates_1.getReportClassificationInstructions)(), maxTokens: 4096 });
    }
    // 清单业务字段、实际生成节点及永久绑定同时校验，不只信任定位索引。
    validateUnit(metadata, records, snapshot, batch, identity, ruleIdentity) {
        const version = metadata?.version;
        (0, report_exchange_1.assertReportFields)(metadata, ['version', 'requestIdentity', 'policyIdentity', 'batchRuleIdentity', 'sourceSnapshotCommit', 'origin', 'productIdentity', 'actualAttempts',
            ...(version === 'classification-cache-1' ? ['bindings'] : ['bindingVersion', 'coreCount', 'memberCount', 'classificationCount'])], '分类缓存清单');
        const value = metadata;
        if (!['classification-cache-1', 'classification-cache-2'].includes(value.version) || value.requestIdentity !== identity || value.policyIdentity !== this.policy.identity
            || value.batchRuleIdentity !== ruleIdentity || !CACHE_HASH.test(value.sourceSnapshotCommit) || !value.origin?.taskId
            || !Number.isFinite(value.origin.deadlineMs))
            throw new Error('分类缓存请求、版本或原任务条件不一致');
        (0, report_cache_provenance_1.assertReportCacheAttempts)(value.actualAttempts, this.policy);
        const permanent = decodeClassificationPermanent(value, records);
        if (value.productIdentity !== (0, report_cache_provenance_1.reportCacheDigest)({ requestIdentity: identity, policyIdentity: this.policy.identity, permanent, actualAttempts: value.actualAttempts })) {
            throw new Error('分类缓存有效产物摘要不一致');
        }
        return (0, report_bindings_1.restoreReportClassification)(snapshot, batch, permanent);
    }
    // 从原始生成快照重建相同请求，证明产物中的永久来源确实存在，不依赖新任务编号。
    validateOrigin(metadata, records, core, identity, ruleIdentity) {
        const original = (0, report_snapshots_1.decodeReportSnapshot)(metadata, records);
        if (original.context.sourceCompleteness !== 'complete' || original.context.period.periodStartMs !== this.options.context.period.periodStartMs
            || original.context.period.periodEndMs !== this.options.context.period.periodEndMs)
            throw new Error('分类缓存来源快照完整性或业务范围不一致');
        const available = new Map(original.evidence.fragments.map(fragment => [fragment.permanentKey, fragment]));
        const fragments = core.map(binding => available.get(binding.key));
        if (fragments.some(fragment => !fragment))
            throw new Error('分类缓存来源对象缺少原永久片段');
        const batch = (0, report_evidence_1.buildReportEvidenceBatch)(original.evidence, fragments);
        if (this.requestIdentity(original.evidence, batch, ruleIdentity) !== identity)
            throw new Error('分类缓存原始供料无法重建匹配请求');
    }
    // --- 真正命中与发布 ---
    // 候选先只读检查；采用前再保护完整源对象和产物，保护失败必须传播。
    read(snapshot, batch, ruleIdentity) {
        if (!this.enabled)
            return null;
        if (!(0, util_1.isDeepStrictEqual)(snapshot.sources, this.options.snapshot.sources) || !(0, util_1.isDeepStrictEqual)(snapshot.fragments, this.options.snapshot.fragments))
            throw new Error('分类缓存不属于本次固定输入');
        const identity = this.requestIdentity(snapshot, batch, ruleIdentity);
        if (!identity)
            return null;
        const candidates = this.candidates.filter(candidate => {
            const value = candidate.metadata;
            return (value?.version === 'classification-cache-1' || value?.version === 'classification-cache-2') && value.requestIdentity === identity && value.policyIdentity === this.policy.identity;
        }).sort((a, b) => {
            const priority = (metadata) => {
                return metadata.lastRouteIdentity === this.policy.first.routeIdentity ? 0 : 1;
            };
            return priority(a.metadata) - priority(b.metadata) || a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id);
        });
        for (const candidate of candidates) {
            let value;
            let core;
            try {
                const unit = this.options.store.inspect(candidate.id, 'unit', (metadata, records) => this.validateUnit(metadata, records, snapshot, batch, identity, ruleIdentity));
                if (!unit)
                    continue;
                value = unit.metadata;
                core = decodeClassificationPermanent(value, unit.records).core;
                const source = this.options.store.inspect(value.sourceSnapshotCommit, 'snapshot', (metadata, records) => this.validateOrigin(metadata, records, core, identity, ruleIdentity));
                if (!source) {
                    this.diagnostic('source_unavailable', candidate.id, '原来源快照已缺失或过期');
                    continue;
                }
            }
            catch (error) {
                if (!(error instanceof report_storage_1.ReportStoredDataError))
                    throw error;
                this.diagnostic('invalid_cache_data', candidate.id, error.message);
                continue;
            }
            // 以下是必要的活动保护发布边界，取消/容量/租约或二次校验错误不得变成未命中。
            if (!this.options.store.read(value.sourceSnapshotCommit, 'snapshot', (metadata, records) => this.validateOrigin(metadata, records, core, identity, ruleIdentity))) {
                throw new Error('分类缓存采用前来源快照失效');
            }
            let restored = [];
            const committed = this.options.store.read(candidate.id, 'unit', (metadata, records) => { restored = this.validateUnit(metadata, records, snapshot, batch, identity, ruleIdentity); });
            if (!committed)
                throw new Error('分类缓存采用前提交失效');
            return { commitId: candidate.id, sourceSnapshotCommit: value.sourceSnapshotCommit, origin: value.origin,
                actualAttempts: value.actualAttempts, records: restored };
        }
        return null;
    }
    // 有验证来源才发布可信单元；来源未知允许当前任务完成，但不冒称跨任务可信缓存。
    save(snapshot, batch, ruleIdentity, attempts, records) {
        if (!this.enabled)
            return null;
        if (!(0, util_1.isDeepStrictEqual)(snapshot.sources, this.options.snapshot.sources) || !(0, util_1.isDeepStrictEqual)(snapshot.fragments, this.options.snapshot.fragments))
            throw new Error('分类缓存不属于本次固定输入');
        const identity = this.requestIdentity(snapshot, batch, ruleIdentity), permanent = (0, report_bindings_1.bindReportClassification)(snapshot, batch, records);
        if (!identity || !permanent)
            return null;
        let actualAttempts;
        try {
            actualAttempts = (0, report_cache_provenance_1.verifyReportCacheAttempts)(attempts, this.policy, (0, report_candidates_1.getReportClassificationInstructions)(), batch.input, 4096);
        }
        catch (error) {
            this.diagnostic('actual_model_unverified', identity, error instanceof Error ? error.message : String(error));
            return null;
        }
        const { taskId, deadlineMs } = this.options.store.taskIdentity;
        const output = pagedClassificationRecords(permanent);
        const metadata = { version: 'classification-cache-2', requestIdentity: identity, policyIdentity: this.policy.identity, batchRuleIdentity: ruleIdentity,
            sourceSnapshotCommit: this.options.snapshotCommit, origin: { taskId, deadlineMs }, bindingVersion: permanent.version,
            coreCount: permanent.core.length, memberCount: permanent.members.length, classificationCount: permanent.records.length, actualAttempts,
            productIdentity: (0, report_cache_provenance_1.reportCacheDigest)({ requestIdentity: identity, policyIdentity: this.policy.identity, permanent, actualAttempts }) };
        const id = this.options.store.commit('unit', metadata, output, (value, rows) => this.validateUnit(value, rows, snapshot, batch, identity, ruleIdentity), 'unit-record-fragments-1');
        const committed = this.options.store.inspect(id, 'unit', (value, rows) => this.validateUnit(value, rows, snapshot, batch, identity, ruleIdentity));
        const locator = (0, report_storage_1.projectReportUnitLocator)(metadata);
        if (locator)
            this.candidates.push({ id, metadata: locator, createdAtMs: committed.createdAtMs });
        return id;
    }
}
exports.ReportClassificationCache = ReportClassificationCache;
