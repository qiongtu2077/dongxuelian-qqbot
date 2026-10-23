"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GROUNDED_REPORT_LIMITS = void 0;
exports.runGroundedReport = runGroundedReport;
/**
 * MODULE: 简明有据日报的单一分析编排器。
 * 职责: 完整分类、全文卡片、有界目录整理、一次全局选题及四类独立输出。
 * 边界: 外部模型由明确阶段/轮次注入；不读取凭据、不投递群消息、不隐式切换模型。
 */
const management_runtime_1 = require("koishi-plugin-dongxuelian-ai/lib/public/management-runtime");
const complete_input_1 = require("./complete-input");
const report_evidence_1 = require("./report-evidence");
const report_candidates_1 = require("./report-candidates");
const report_topics_1 = require("./report-topics");
const report_outputs_1 = require("./report-outputs");
const report_progress_1 = require("./report-progress");
const report_request_pool_1 = require("./report-request-pool");
const report_batch_catalog_1 = require("./report-batch-catalog");
const report_stage_bindings_1 = require("./report-stage-bindings");
const { createReportAnalysisDiagnostics, ReportAnalysisError } = (0, management_runtime_1.loadManagementModule)('daily.reportAnalysis');
const RESERVE_CHARACTERS = 512;
exports.GROUNDED_REPORT_LIMITS = Object.freeze({ requestTimeoutMs: 90000, runTimeoutMs: 1800000, saveReserveMs: 30000 });
// --- 固定预算与并发执行 ---
// 缓存读取也沿用原取消、模型阶段截止及总截止，不以本地重放绕过任务预算。
function assertReportWorkBudget(state, stage) {
    if (state.controller.signal.aborted)
        throw state.controller.signal.reason || new Error('日报任务已取消');
    if (state.now() >= state.options.deadlineMs)
        throw new ReportAnalysisError('日报运行总时限已耗尽', 'total_timeout', stage, state.meta);
    if (state.now() >= state.options.workDeadlineMs)
        throw new ReportAnalysisError('日报分析预算已耗尽，已预留结果保存时间', 'generation_failed', stage, state.meta);
}
// 任何阶段只更新实际核心集合，完整处理和展示关联分别计数。
function reportProgress(state) {
    const metrics = (0, report_progress_1.createReportEvidenceMetrics)(state.snapshot, { submitted: [...state.submitted], classified: [...state.classified],
        deterministic: [...state.deterministic], cached: [...state.cached], selected: [...state.selected], deepRead: [...state.deepRead], displayed: [...state.displayed] });
    state.meta.evidence = metrics;
    state.meta.submittedMessageCount = metrics.modelSubmittedMessageCount;
    state.meta.summarizedMessageCount = metrics.processedMessageCount;
    state.meta.unprocessedCount = metrics.unprocessedMessageCount;
    state.options.onProgress?.(state.meta);
}
// 只采用公共接口已确认可恢复的服务端错误，不从正文猜余额或重试资格。
function isTemporaryReportUpstreamFailure(error) {
    return error instanceof report_request_pool_1.ReportRequestBoundaryError && error.kind === 'upstream' && error.upstreamFailure?.retryable === true
        && error.upstreamFailure.status >= 500 && error.upstreamFailure.status <= 599;
}
// 每个逻辑单元最多两轮；所有单元共享实际请求、恢复次数、取消与在途槽位。
async function reportUnit(state, stage, fragments, system, input, validate, recover, serialize = value => value, completion) {
    assertReportWorkBudget(state, stage);
    const limit = stage === 'grouping' || stage === 'selection' ? 32000 : 16000;
    if (Array.from(system + input).length > limit)
        throw new ReportAnalysisError('日报实际系统及用户材料超过阶段上限', 'generation_failed', stage, state.meta);
    const maxTokens = stage === 'classification' || stage === 'grouping' || stage === 'selection' ? 4096 : 2048;
    const cacheRequest = state.options.stageCache && stage !== 'classification' && completion?.bindings
        ? { stage, mode: state.full ? 'detailed' : 'ordinary', system, input, maxTokens, bindings: completion.bindings,
            ...(completion.requireNormalFinish ? { requireNormalFinish: true } : {}) } : undefined;
    if (cacheRequest) {
        const cached = state.options.stageCache.read(state.snapshot, cacheRequest, validate, recover);
        assertReportWorkBudget(state, stage);
        if (cached) {
            state.stageCacheHits.push(cached.history);
            return cached.value;
        }
    }
    const sourceIds = [...new Set(fragments.map(fragment => fragment.sourceId))];
    const unit = { id: stage + ':' + (++state.unitCount), stage, sourceIds,
        timestamps: sourceIds.flatMap(id => state.snapshot.sources[id - 1].ts === null ? [] : [state.snapshot.sources[id - 1].ts]),
        onSubmitted: () => { if (stage === 'classification') {
            fragments.forEach(fragment => state.submitted.add(fragment.id));
            reportProgress(state);
        } } };
    let round = 0, responseReceived = false, pendingRequest;
    const runtime = { ...state.options, signal: state.controller.signal,
        maxRequestCount: Math.min(192, state.options.maxRequestCount ?? 192),
        recoveryInstructions: completion?.recoveryInstructions || '仅返回当前明确契约的一个完整JSON对象，completed必须为true，不使用旧JSONL或end记录。',
        requireNormalFinish: completion?.requireNormalFinish,
        recoveryStepIndex: () => 0,
        shouldRecover: error => error instanceof complete_input_1.AnalysisUnitRequestTimeoutError || isTemporaryReportUpstreamFailure(error)
            || (responseReceived && !(error instanceof report_request_pool_1.ReportRequestBoundaryError)),
        retryOriginalRequest: isTemporaryReportUpstreamFailure,
        onUnitCompleted: (descriptor, attempts, value) => {
            state.options.onUnitCompleted?.(descriptor, attempts, serialize(value));
            completion?.onCompleted?.(attempts, value);
            if (cacheRequest)
                state.options.stageCache.save(state.snapshot, cacheRequest, attempts, value, validate, recover);
        },
        request: async (requestSystem, requestInput, tokens, extra) => {
            const attempt = (++round);
            responseReceived = false;
            if (Array.from(requestSystem + requestInput).length > limit)
                throw new report_request_pool_1.ReportRequestBoundaryError('contract', '日报恢复请求超过同一材料上限');
            let submitted = false;
            const originalAttempt = extra._onRequestAttempt;
            const guarded = { ...extra, _onRequestAttempt: (value) => {
                    if (submitted)
                        throw new report_request_pool_1.ReportRequestBoundaryError('contract', '日报单节点请求拒绝隐藏重试或主备遍历');
                    if (attempt === 1 ? state.firstRequests >= 184 : state.recoveries >= 8)
                        throw new report_request_pool_1.ReportRequestBoundaryError('budget', '日报首轮或恢复实际调用额度已耗尽');
                    originalAttempt(value);
                    submitted = true;
                    if (attempt === 1)
                        state.firstRequests++;
                    else
                        state.recoveries++;
                } };
            pendingRequest = state.options.request(stage, attempt, requestSystem, requestInput, tokens, guarded);
            const text = await pendingRequest;
            responseReceived = true;
            return text;
        } };
    // 等待槽位沿用原任务截止；只有真正开始单元执行才启动单次计时，恢复共用此槽。
    return state.pool.run(state.controller.signal, async () => {
        try {
            assertReportWorkBudget(state, stage);
            return await (0, complete_input_1.requestAnalysisUnit)(runtime, state.meta, unit, system, input, maxTokens, exports.GROUNDED_REPORT_LIMITS.requestTimeoutMs, validate, recover);
        }
        catch (error) {
            // 必须在交槽前取消等待者；外部取消的竞速结束后，仍持槽等实际上游Promise清理。
            state.controller.abort(error);
            await pendingRequest?.then(() => undefined, () => undefined);
            throw error;
        }
    });
}
// 有界阶段工人按输入顺序回收结果；首个失败取消同任务其他单元，不再发新请求。
async function reportMap(state, values, action) {
    const results = new Array(values.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < values.length) {
            if (state.controller.signal.aborted)
                throw state.controller.signal.reason;
            const index = cursor++;
            try {
                results[index] = await action(values[index], index);
            }
            catch (error) {
                state.controller.abort(error);
                throw error;
            }
        }
    };
    const completed = await Promise.allSettled(Array.from({ length: Math.min(state.concurrency, values.length) }, worker));
    const failed = completed.find((value) => value.status === 'rejected');
    if (failed)
        throw state.controller.signal.reason || failed.reason;
    return results;
}
// --- 完整候选与话题材料 ---
// 超长候选只在完整来源片段边界拆分；每组同时限制候选数与完整封装。
function topicGroups(snapshot, candidates, maximum, instructions, layout = 'references', maximumCandidates = 40) {
    const groups = [], leaves = [];
    // 封装与真实提交使用同一阶段投影，不能按删字段前后的不同体量切分。
    const build = (items) => layout === 'cards' ? (0, report_topics_1.createTopicCardContext)(snapshot, items)
        : layout === 'overview' ? (0, report_topics_1.createTopicOverviewContext)(snapshot, items) : (0, report_topics_1.createTopicContext)(snapshot, items, layout);
    const fits = (items) => items.length <= maximumCandidates
        && Array.from(build(items).input + instructions).length + RESERVE_CHARACTERS <= maximum;
    for (const candidate of candidates) {
        if (fits([candidate])) {
            leaves.push(candidate);
            continue;
        }
        let part = [], index = 0;
        for (const fragment of candidate.fragments) {
            if (part.length && !fits([{ id: candidate.id, fragments: [...part, fragment] }])) {
                leaves.push({ ...candidate, id: candidate.id + ':part:' + index++, fragments: part });
                part = [];
            }
            part.push(fragment);
            if (!fits([{ id: candidate.id, fragments: part }]))
                throw new Error('完整话题片段无法容纳于阶段请求');
        }
        if (part.length)
            leaves.push({ ...candidate, id: candidate.id + ':part:' + index, fragments: part });
    }
    let pending = [];
    for (const candidate of leaves) {
        if (pending.length && !fits([...pending, candidate])) {
            groups.push(build(pending));
            pending = [];
        }
        pending.push(candidate);
    }
    if (pending.length)
        groups.push(build(pending));
    return groups;
}
// 已核验卡片仅保存稳定引用和有界文字；不重复持久化完整原始正文。
function serializeTopicCards(cards) {
    return cards.map(card => ({ id: card.candidate.id, leaves: card.leaves, status: card.status, scope: card.scope,
        ...(card.parentId ? { parentId: card.parentId } : {}), fragmentIds: card.candidate.fragments.map(fragment => fragment.id),
        ...(card.formatWarnings?.length ? { formatWarnings: card.formatWarnings } : {}),
        ...(card.unassignedFragments?.length ? { unassignedFragmentIds: card.unassignedFragments.map(fragment => fragment.id) } : {}),
        evidence: card.evidence.map(entry => ({ fragment: entry.fragment.id, text: entry.text, excerptOnly: entry.excerptOnly,
            truncated: entry.truncated, sourceCharacters: entry.sourceCharacters })) }));
}
// 完整目录只按实际长度及输出编号预算分批，未合并卡片不淘汰。
function topicCatalogGroups(state, cards) {
    const groups = [], system = (0, report_topics_1.getTopicCatalogInstructions)('directory');
    let pending = [];
    const topicCatalogFitsRequest = (values) => values.length <= 120
        && values.reduce((sum, _, index) => sum + ('c' + (index + 1)).length, 0) <= 1800
        && Array.from(system + (0, report_topics_1.createTopicCatalogContext)(state.snapshot, values).input).length + RESERVE_CHARACTERS <= 32000;
    for (const card of cards) {
        if (pending.length && !topicCatalogFitsRequest([...pending, card])) {
            groups.push({ cards: pending, context: (0, report_topics_1.createTopicCatalogContext)(state.snapshot, pending) });
            pending = [];
        }
        pending.push(card);
        if (!topicCatalogFitsRequest(pending))
            throw new Error('单张话题目录材料超出固定容量');
    }
    if (pending.length)
        groups.push({ cards: pending, context: (0, report_topics_1.createTopicCatalogContext)(state.snapshot, pending) });
    return groups;
}
// 全文生成材料卡、最多两层无淘汰整理，然后完整目录仅做一次全局选择。
async function reportTopics(state, candidates, full) {
    const scoped = candidates.filter(candidate => candidate.kind !== 'quote').map(candidate => ({ ...candidate, scopeHints: candidate.title ? [candidate.title] : [] }));
    const cardSystem = (0, report_topics_1.getTopicCatalogInstructions)('cards'), contexts = topicGroups(state.snapshot, scoped, 32000, cardSystem, 'cards', 12);
    const results = await reportMap(state, contexts, async (context) => {
        const fragments = [...context.sources.values()].flatMap(value => [...value]);
        return reportUnit(state, 'selection', fragments, cardSystem, context.input, text => (0, report_topics_1.readTopicCards)(text, context), error => (0, report_topics_1.createTopicCardRepair)(error, context), serializeTopicCards, { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindTopicStageRequest)(state.snapshot, context, fragments) : undefined,
            requireNormalFinish: true,
            recoveryInstructions: '整批重新返回一个完整JSON对象，根字段只能有cards，不返回completed或空标点字段。cards的键必须恰好是requiredCandidateRefs；拆卡只在原父数组内增加对象，不创建新父编号或带后缀编号。闭合cards容器后闭合根对象；不使用旧JSONL或end记录。' });
    });
    const cards = results.flat();
    const unassignedCount = new Set(cards.flatMap(card => (card.unassignedFragments || []).map(fragment => fragment.id))).size;
    if (unassignedCount)
        state.meta.warnings.push(unassignedCount + '条原文已完成分类但未归入话题卡，原始来源已单独保留。');
    let current = cards.filter(card => card.status === 'ok');
    if (!current.length)
        return { selected: [], overviews: [], cards, catalog: [] };
    for (let level = 0; level < 2 && current.length > 1; level++) {
        const groups = topicCatalogGroups(state, current), system = (0, report_topics_1.getTopicCatalogInstructions)('directory');
        const values = await reportMap(state, groups, async ({ cards: group, context }) => {
            if (group.length === 1)
                return group;
            const fragments = [...new Map(group.flatMap(card => [...card.candidate.fragments]).map(fragment => [fragment.id, fragment])).values()];
            return reportUnit(state, 'grouping', fragments, system, context.input, text => (0, report_topics_1.readTopicDirectory)(text, context, group), undefined, serializeTopicCards, { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindTopicStageRequest)(state.snapshot, context, fragments) : undefined });
        });
        current = values.flat();
        state.meta.mergeLevels = level + 1;
        // 一组已经共同整理全部目录，无需再次请求相同材料；多组至多再整理一层。
        if (groups.length === 1)
            break;
    }
    const limit = full ? 10 : 5;
    let selectionSystem = (0, report_topics_1.getTopicCatalogInstructions)('selection'), context = (0, report_topics_1.createTopicCatalogContext)(state.snapshot, current, limit);
    if (Array.from(selectionSystem + context.input).length + RESERVE_CHARACTERS > 32000) {
        context = (0, report_topics_1.createTopicCatalogContext)(state.snapshot, current, limit, true);
        selectionSystem += '\n输入topic-selection-4为完整紧凑目录：candidates每行按columns列顺序，行号从1起对应c1、c2等引用。evidence列整数是全局evidence表从0起的索引；表内字符串为未截断摘录，[文字,原字符数]为截断摘录，全部excerptOnly=true。firstMinute/lastMinute为timeOriginMs起的相对分钟，精度timePrecisionMs；null表示时间未知。全部行都须阅读，输出契约仍为selected的c引用与completed。';
    }
    if (Array.from(selectionSystem + context.input).length + RESERVE_CHARACTERS > 32000)
        throw new Error('完整话题目录经过最多两层整理仍超过容量，禁止截取或分批淘汰');
    const fragments = [...new Map(current.flatMap(card => [...card.candidate.fragments]).map(fragment => [fragment.id, fragment])).values()];
    const selected = await reportUnit(state, 'selection', fragments, selectionSystem, context.input, text => (0, report_topics_1.readTopicCatalogSelection)(text, context, limit), undefined, value => value.map(candidate => candidate.id), { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindTopicStageRequest)(state.snapshot, context, fragments) : undefined });
    const selection = { selected };
    selection.selected.forEach(candidate => candidate.fragments.forEach(fragment => state.selected.add(fragment.id)));
    reportProgress(state);
    const overviews = await reportMap(state, selection.selected, async (candidate) => {
        // 用目录明确保留的叶卡恢复原始讨论边界，避免合并范围把多个对象暗示为同一主体。
        const selectedCard = current.find(card => card.candidate.id === candidate.id);
        if (!selectedCard)
            throw new Error('入选话题缺少完整目录来源');
        const leaves = new Set(selectedCard.leaves), originals = cards.filter(card => leaves.has(card.candidate.id)).map(card => card.candidate);
        if (originals.length !== leaves.size)
            throw new Error('入选话题原始全文卡边界缺失');
        const overviewSystem = (0, report_topics_1.getTopicInstructions)('overview'), parts = topicGroups(state.snapshot, originals, 16000, overviewSystem, 'overview');
        const values = await reportMap(state, parts, async (context) => {
            const fragments = [...context.sources.values()].flatMap(value => [...value]);
            const value = await reportUnit(state, 'overview', fragments, overviewSystem, context.input, text => (0, report_topics_1.readTopicOverview)(text, context), undefined, result => ({ title: result.title, summary: result.summary, refs: result.refs, evidence: result.evidence.map(fragment => fragment.id), submitted: result.submitted.map(fragment => fragment.id) }), { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindTopicStageRequest)(state.snapshot, context, fragments) : undefined });
            fragments.forEach(fragment => state.deepRead.add(fragment.id));
            reportProgress(state);
            return value;
        });
        if (values.length === 1)
            return values[0];
        const context = (0, report_topics_1.createTopicOverviewMergeContext)(values);
        return reportUnit(state, 'overview', candidate.fragments, overviewSystem, context.input, text => (0, report_topics_1.readTopicOverview)(text, context, candidate.fragments), undefined, result => ({ title: result.title, summary: result.summary, refs: result.refs, evidence: result.evidence.map(fragment => fragment.id), submitted: result.submitted.map(fragment => fragment.id) }), { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindTopicStageRequest)(state.snapshot, context, candidate.fragments) : undefined });
    });
    overviews.forEach(value => value.evidence.forEach(fragment => state.displayed.add(fragment.id)));
    reportProgress(state);
    return { selected: selection.selected, overviews, cards, catalog: current };
}
// --- 独立输出材料 ---
// 保持源时间覆盖及去重样本，未知时间仅用原始顺序作选样顺序，不伪造展示时间。
function representativeSources(snapshot, userId, count) {
    const items = snapshot.sources.filter(source => source.userId === userId && source.content !== '[图片]')
        .map(source => ({ analysisId: source.sourceId, userId, ts: source.ts ?? source.sourceId, content: source.content }));
    return (0, complete_input_1.selectRepresentativeMessages)(items, userId, count).map(item => item.analysisId);
}
// 金句只供完整短原话；真实邻居合计有界，辅助不能成为本人金句。
function quoteContext(snapshot, sourceIds) {
    const primary = new Set(sourceIds), auxiliary = new Set(), entries = sourceIds.map(sourceId => ({ sourceId }));
    let contextCharacters = 0;
    const material = (0, report_evidence_1.buildReportEvidenceBatch)(snapshot, snapshot.fragments.filter(fragment => primary.has(fragment.sourceId)));
    for (const supplied of material.auxiliary.values()) {
        if (primary.has(supplied.sourceId))
            continue;
        const entry = { sourceId: supplied.sourceId, text: supplied.text, role: 'auxiliary' };
        const length = Array.from(JSON.stringify(entry)).length;
        if (contextCharacters + length > 2000)
            continue;
        entries.push(entry);
        auxiliary.add(entry.sourceId);
        contextCharacters += length;
    }
    for (const sourceId of sourceIds)
        for (const index of [sourceId - 2, sourceId - 1, sourceId + 1, sourceId + 2]) {
            const source = snapshot.sources[index - 1];
            if (!source || primary.has(index) || auxiliary.has(index))
                continue;
            const characters = Array.from(source.content), text = (index < sourceId ? characters.slice(-200) : characters.slice(0, 200)).join('');
            const entry = { sourceId: index, text, role: 'auxiliary' };
            const length = Array.from(JSON.stringify(entry)).length;
            if (contextCharacters + length > 2000)
                continue;
            entries.push(entry);
            auxiliary.add(index);
            contextCharacters += length;
        }
    return (0, report_outputs_1.createGroundedOutputContext)(snapshot, entries);
}
// 分组比较后只保留模型明确选中的候选，完整短原话保证比较池可以收敛。
async function reportQuotes(state, candidates) {
    let ids = [...new Set(candidates.filter(candidate => candidate.kind === 'quote').flatMap(candidate => candidate.fragments.map(fragment => fragment.sourceId)))]
        .filter(id => { const source = state.snapshot.sources[id - 1]; return source.content !== '[图片]' && Array.from(source.content).length <= report_outputs_1.GROUNDED_QUOTE_CHARACTERS; });
    const system = (0, report_outputs_1.getGroundedOutputInstructions)('quotes');
    while (ids.length) {
        const groups = [];
        let pending = [];
        for (const id of ids) {
            const context = quoteContext(state.snapshot, [...pending, id]);
            if (pending.length && Array.from(context.input + system).length + RESERVE_CHARACTERS > 16000) {
                groups.push(pending);
                pending = [];
            }
            pending.push(id);
        }
        if (pending.length)
            groups.push(pending);
        const results = await reportMap(state, groups, async (group) => {
            const context = quoteContext(state.snapshot, group), fragments = state.snapshot.fragments.filter(fragment => group.includes(fragment.sourceId));
            return reportUnit(state, 'quotes', fragments, system, context.input, text => (0, report_outputs_1.readGroundedQuotes)(text, context), undefined, undefined, { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindOutputStageRequest)(state.snapshot, context, fragments) : undefined,
                requireNormalFinish: true,
                recoveryInstructions: '仅返回一个完整JSON对象，根字段只能有items，不返回status或completed。items为空数组表示不足，有内容须三至五条，不凑数、复制或改写原话。' });
        });
        if (groups.length === 1)
            return results[0];
        const next = [...new Set(results.flat().map(value => value.sourceId))];
        if (next.length >= ids.length)
            throw new Error('金句候选比较无法在固定请求预算内收敛');
        ids = next;
    }
    return [];
}
// 每次最多四位实际有本人样本的成员，按窗口活跃量与永久身份固定次序。
async function reportPortraits(state, data) {
    const counts = new Map();
    state.snapshot.sources.forEach(source => counts.set(source.userId, (counts.get(source.userId) || 0) + 1));
    if (data.topMembers)
        for (const member of data.topMembers)
            if (member.userId !== undefined && counts.has(String(member.userId)) && typeof member.msgCount === 'number')
                counts.set(String(member.userId), member.msgCount);
    const users = [...counts].sort(([a, ca], [b, cb]) => cb - ca || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 8).map(([userId]) => userId);
    const entriesByUser = users.map(userId => representativeSources(state.snapshot, userId, 15).map(sourceId => ({ sourceId,
        text: Array.from(state.snapshot.sources[sourceId - 1].content).slice(0, 200).join('') }))).filter(entries => entries.length);
    const groups = [], system = (0, report_outputs_1.getGroundedOutputInstructions)('portraits');
    let pending = [];
    for (const entries of entriesByUser) {
        if (pending.length && (pending.length >= 4 || Array.from((0, report_outputs_1.createGroundedOutputContext)(state.snapshot, [...pending, entries].flat()).input + system).length + RESERVE_CHARACTERS > 16000)) {
            groups.push(pending);
            pending = [];
        }
        pending.push(entries);
    }
    if (pending.length)
        groups.push(pending);
    const results = await reportMap(state, groups, async (group) => {
        const entries = group.flat(), context = (0, report_outputs_1.createGroundedOutputContext)(state.snapshot, entries);
        const fragments = state.snapshot.fragments.filter(fragment => entries.some(entry => entry.sourceId === fragment.sourceId));
        return reportUnit(state, 'portraits', fragments, system, context.input, text => (0, report_outputs_1.readGroundedPortraits)(text, context), error => (0, report_outputs_1.createGroundedPortraitRepair)(error, context), undefined, { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindOutputStageRequest)(state.snapshot, context, fragments) : undefined });
    });
    const portraits = results.flatMap(value => value.portraits), order = new Map(users.map((userId, index) => [userId, index]));
    return portraits.sort((a, b) => order.get(a.userId) - order.get(b.userId));
}
// 统计句只由当前程序数据产生；资料不足时不把入选人数冒充整个窗口人数。
function reportStatistics(state, data) {
    const result = [{ ref: 's1', text: `窗口消息量：${state.meta.windowMessageCount}条。` },
        { ref: 's2', text: `本次入选：${state.snapshot.sources.length}条。` }];
    if (typeof data.activeMembers === 'number')
        result.push({ ref: 's3', text: `窗口活跃成员：${data.activeMembers}人。` });
    if (data.peakHour)
        result.push({ ref: 's4', text: `窗口活跃高峰：${data.peakHour}。` });
    return result;
}
// 锐评只使用明确代表样本，完整话题摘要作背景；实际依据仍指向本次原话或统计。
async function reportReview(state, data, overviews) {
    if (!state.snapshot.sources.some(source => source.content !== '[图片]'))
        return null;
    const ids = new Set(overviews.flatMap(value => value.evidence.map(fragment => fragment.sourceId)));
    for (const userId of new Set(state.snapshot.sources.map(source => source.userId)))
        for (const id of representativeSources(state.snapshot, userId, 3))
            ids.add(id);
    const statistics = reportStatistics(state, data), system = (0, report_outputs_1.getGroundedOutputInstructions)('review');
    let entries = [], context = (0, report_outputs_1.createGroundedOutputContext)(state.snapshot, [], statistics);
    const background = overviews.map(value => ({ title: value.title, summary: value.summary }));
    for (const sourceId of ids) {
        const entry = { sourceId, text: Array.from(state.snapshot.sources[sourceId - 1].content).slice(0, 200).join('') };
        const next = (0, report_outputs_1.createGroundedOutputContext)(state.snapshot, [...entries, entry], statistics);
        next.input = JSON.stringify({ ...JSON.parse(next.input), topics: background });
        if (Array.from(next.input + system).length + RESERVE_CHARACTERS > 16000)
            continue;
        entries.push(entry);
        context = next;
    }
    if (!entries.length)
        throw new Error('锐评无法在固定材料预算中提供实际代表原文');
    const fragments = state.snapshot.fragments.filter(fragment => entries.some(entry => entry.sourceId === fragment.sourceId));
    const value = await reportUnit(state, 'review', fragments, system, context.input, text => (0, report_outputs_1.readGroundedReview)(text, context), undefined, undefined, { bindings: state.options.stageCache ? (0, report_stage_bindings_1.bindOutputStageRequest)(state.snapshot, context, fragments) : undefined });
    if (!value)
        return null;
    const colors = ['#4a90d9', '#7c6bc4', '#57a68b', '#d69b42', '#c96f88'];
    return { title: value.title, subtitle: '主观指数；' + value.statRefs.map(ref => context.statistics.get(ref)).join(''),
        summary: value.summary, dimensions: value.dimensions.map((dimension, index) => ({ name: dimension.name, percentage: dimension.percentage,
            comment: dimension.comment + dimension.statRefs.map(ref => context.statistics.get(ref)).join(''), color: colors[index] })) };
}
// --- 单一正式编排入口 ---
// 完整来源处理后才能组装结果；失败取消所有在途并等待清理，不交付半成品。
async function runGroundedReport(data, full, options) {
    const now = options.now || Date.now, startedAt = options.startedAtMs ?? now(), remaining = Math.max(0, options.deadlineMs - startedAt);
    if (remaining > exports.GROUNDED_REPORT_LIMITS.runTimeoutMs)
        throw new Error('日报任务不能超过三十分钟硬截止');
    const saveReserve = Math.min(exports.GROUNDED_REPORT_LIMITS.saveReserveMs, remaining * 0.05);
    const meta = createReportAnalysisDiagnostics({ windowMessageCount: data.windowMessageCount ?? data.totalMessages ?? data.messages.length,
        selectedMessageCount: data.messages.length, sourceCompleteness: data.sourceCompleteness || 'legacy_unknown', reportPeriod: data.reportPeriod, periodBackfilled: data.periodBackfilled });
    // 来源构造失败前不注册取消监听，避免无效输入留下无法清理的任务闭包。
    const snapshot = (0, report_evidence_1.createReportEvidence)(data.messages);
    const controller = new AbortController(), pool = new report_request_pool_1.ReportRequestPool(options.concurrency ?? 1);
    const abortGroundedReport = () => controller.abort(options.signal?.reason || new Error('日报任务已取消'));
    options.signal?.addEventListener('abort', abortGroundedReport, { once: true });
    if (options.signal?.aborted)
        abortGroundedReport();
    const state = { snapshot, meta, controller, pool, concurrency: options.concurrency ?? 1, full, now, stageCacheHits: [],
        options: { ...options, workDeadlineMs: Math.min(options.workDeadlineMs ?? options.deadlineMs - saveReserve, options.deadlineMs - saveReserve) },
        firstRequests: 0, recoveries: 0, unitCount: 0, submitted: new Set(), classified: new Set(), cached: new Set(), deterministic: new Set(), selected: new Set(), deepRead: new Set(), displayed: new Set() };
    try {
        if (controller.signal.aborted)
            throw controller.signal.reason;
        if (now() >= options.deadlineMs)
            throw new ReportAnalysisError('日报运行总时限已耗尽', 'total_timeout', 'analysis', meta);
        if (meta.sourceCompleteness === 'incomplete')
            throw new ReportAnalysisError('日报原始记录不完整', 'generation_failed', 'collecting', meta);
        const catalog = options.classificationCatalog;
        if (options.classificationCache && !catalog)
            throw new Error('分类缓存必须绑定稳定批次目录');
        if (options.classificationCache && (options.taskId !== options.classificationCache.taskIdentity.taskId
            || options.deadlineMs !== options.classificationCache.taskIdentity.deadlineMs
            || catalog.channelKey !== options.classificationCache.taskIdentity.channelKey))
            throw new Error('分类缓存任务身份、群或原截止不一致');
        if (options.stageCache && (!catalog || options.taskId !== options.stageCache.taskIdentity.taskId
            || options.deadlineMs !== options.stageCache.taskIdentity.deadlineMs || catalog.channelKey !== options.stageCache.taskIdentity.channelKey))
            throw new Error('阶段缓存任务身份、群或原截止不一致');
        if (catalog && (meta.sourceCompleteness !== 'complete' || !data.reportPeriod || catalog.channelKey !== catalog.value.scope.channelKey
            || data.reportPeriod.reportDate !== catalog.value.scope.reportDate || data.reportPeriod.periodStartMs !== catalog.value.scope.periodStartMs
            || data.reportPeriod.periodEndMs !== catalog.value.scope.periodEndMs))
            throw new Error('稳定目录须绑定当前完整来源、群和报告窗口');
        meta.analysisState = 'processing';
        const deterministic = (0, report_evidence_1.partitionReportEvidence)(snapshot).deterministic;
        deterministic.forEach(fragment => { state.classified.add(fragment.id); state.deterministic.add(fragment.id); });
        const instructions = (0, report_candidates_1.getReportClassificationInstructions)();
        const batches = catalog ? (0, report_batch_catalog_1.selectReportCatalogBatches)(catalog.value, snapshot).flatMap(view => view.batch ? [{ batch: view.batch, ruleIdentity: view.ruleIdentity }] : [])
            : (0, report_evidence_1.packReportEvidenceBatches)(snapshot, Array.from(instructions).length + RESERVE_CHARACTERS).map(batch => ({ batch, ruleIdentity: '' }));
        const cacheHits = [];
        meta.batchCount = batches.length;
        const classified = await reportMap(state, batches, async ({ batch, ruleIdentity }, index) => {
            assertReportWorkBudget(state, 'classification');
            const hit = options.classificationCache?.read(snapshot, batch, ruleIdentity);
            assertReportWorkBudget(state, 'classification');
            const records = hit ? hit.records : await reportUnit(state, 'classification', batch.fragments, instructions, batch.input, text => (0, report_candidates_1.readReportClassification)(text, batch), error => (0, report_candidates_1.createReportClassificationRepair)(error, batch), undefined, { onCompleted: (attempts, value) => { options.classificationCache?.save(snapshot, batch, ruleIdentity, attempts, value); } });
            if (hit) {
                batch.fragments.forEach(fragment => state.cached.add(fragment.id));
                const { records: _records, ...history } = hit;
                cacheHits.push(history);
            }
            batch.fragments.forEach(fragment => state.classified.add(fragment.id));
            reportProgress(state);
            return (0, report_candidates_1.createReportCandidates)(records, batch, 'batch:' + index);
        });
        const candidates = [...classified.flat(), ...(0, report_candidates_1.createImageReportCandidates)(snapshot)];
        reportProgress(state);
        if (meta.evidence.unprocessedMessageCount || state.classified.size !== snapshot.fragments.length)
            throw new Error('日报核心处理账本不完整');
        meta.stages.compression = 'complete';
        const material = candidates.filter(candidate => !candidate.id.startsWith('source-rule:image:'));
        let topicsComplete = false, quotesComplete = false, portraitsComplete = !full, reviewComplete = !full;
        meta.stages.full = full ? 'pending' : 'not_requested';
        // 各模块共享实际槽位，锐评依赖话题；首个失败取消其他模块并等实际清理。
        const fail = (error) => { controller.abort(error); throw error; };
        const topicsPromise = reportTopics(state, material, full).then(value => {
            topicsComplete = true;
            if (quotesComplete)
                meta.stages.basic = 'complete';
            return value;
        }).catch(fail);
        const quotesPromise = reportQuotes(state, material).then(value => {
            quotesComplete = true;
            if (topicsComplete)
                meta.stages.basic = 'complete';
            return value;
        }).catch(fail);
        const portraitsPromise = (full ? reportPortraits(state, data) : Promise.resolve([])).then(value => {
            portraitsComplete = true;
            if (full && reviewComplete)
                meta.stages.full = 'complete';
            return value;
        }).catch(fail);
        const reviewPromise = topicsPromise.then(value => full ? reportReview(state, data, value.overviews) : null).then(value => {
            reviewComplete = true;
            if (full && portraitsComplete)
                meta.stages.full = 'complete';
            return value;
        }).catch(fail);
        const outcomes = await Promise.allSettled([topicsPromise, quotesPromise, portraitsPromise, reviewPromise]);
        const failure = outcomes.find((value) => value.status === 'rejected');
        if (failure)
            throw controller.signal.reason || failure.reason;
        const topics = outcomes[0].value;
        const quotes = outcomes[1].value;
        const portraits = outcomes[2].value;
        const review = outcomes[3].value;
        if (now() >= state.options.workDeadlineMs)
            throw new ReportAnalysisError('日报分析预算已耗尽', 'generation_failed', 'analysis', meta);
        // 旧输入覆盖仍表示来源进入话题识别链；展示和深读范围只从独立evidence字段读取。
        meta.topicInputMessageCount = snapshot.sources.length;
        meta.omittedMessageCount = 0;
        meta.coverageRate = snapshot.sources.length ? 100 : null;
        meta.analysisState = 'complete';
        reportProgress(state);
        return { analysisVersion: 'grounded-report-1', topics: topics.overviews.map((value, index) => ({ id: index + 1, title: value.title, summary: value.summary,
                participants: [...new Set(topics.selected[index].fragments.map(fragment => snapshot.sources[fragment.sourceId - 1].userId))]
                    .map(userId => snapshot.sources.find(source => source.userId === userId).name) })),
            goldenQuotes: quotes.map(({ content, sender, reason, userId }) => ({ content, sender, reason, userId })),
            userTitles: portraits.map(({ name, userId, title, reason, mbti }) => ({ name, userId, title, reason, mbti })), qualityReview: review, tokenUsage: { ...meta.tokenUsage }, meta,
            audit: { snapshotIdentity: snapshot.identity, modules: { topics: topics.overviews.length ? 'complete' : 'insufficient', quotes: quotes.length ? 'complete' : 'insufficient',
                    portraits: !full ? 'not_requested' : portraits.length ? 'complete' : 'insufficient', review: !full ? 'not_requested' : review ? 'complete' : 'insufficient' },
                candidates: candidates.map(candidate => ({ id: candidate.id, kind: candidate.kind, category: candidate.category, fragmentIds: candidate.fragments.map(fragment => fragment.id) })),
                selected: topics.selected.map(candidate => ({ id: candidate.id, fragmentIds: candidate.fragments.map(fragment => fragment.id) })),
                overviews: topics.overviews.map(value => ({ title: value.title, evidence: value.evidence.map(fragment => fragment.id), submitted: value.submitted.map(fragment => fragment.id) })),
                topicCards: serializeTopicCards(topics.cards), topicCatalog: serializeTopicCards(topics.catalog), firstRequests: state.firstRequests, recoveries: state.recoveries, classificationCache: cacheHits, stageCache: state.stageCacheHits } };
    }
    catch (error) {
        controller.abort(error);
        if (options.signal?.aborted)
            throw options.signal.reason || error;
        throw error instanceof ReportAnalysisError ? error : new ReportAnalysisError(error instanceof Error ? error.message : String(error), now() >= options.deadlineMs ? 'total_timeout' : 'generation_failed', 'analysis', meta);
    }
    finally {
        await pool.drain();
        options.signal?.removeEventListener('abort', abortGroundedReport);
    }
}
