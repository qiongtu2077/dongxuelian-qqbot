"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.packInputBatches = packInputBatches;
exports.selectRepresentativeMessages = selectRepresentativeMessages;
exports.requestAnalysisUnit = requestAnalysisUnit;
exports.summarizeCompleteInput = summarizeCompleteInput;
/** 完整入选消息的长度分批、结构化摘要、来源追踪与分层合并。 */
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { ReportAnalysisError } = loadManagementModule('daily.reportAnalysis');
const { redactSensitiveText } = loadManagementModule('core.redactor');
const MAX_BATCH_CHARS = 4000;
const MAX_BATCH_MESSAGES = 100;
const INTERMEDIATE_CHARS = 1800;
// --- 分批与画像取样 ---
// 连续拆分完整正文，UTF-16 代理对不会跨片段截断，前缀也计入4000字符。
function packInputBatches(messages) {
    const batches = [];
    let fragments = [];
    let length = 0;
    let sources = new Set();
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex];
        const sourceId = message.analysisId ?? messageIndex + 1;
        if (sourceId !== messageIndex + 1)
            throw new Error('日报入选来源序号必须连续且唯一');
        const parts = [];
        let body = '';
        let part = 1;
        const prefix = (partNumber) => `[M${sourceId}:P${partNumber}] ${message.time || '-'} 用户ID=${String(message.userId || '-')}: `;
        if (prefix(1).length >= MAX_BATCH_CHARS - 2)
            throw new Error('日报消息来源前缀过长');
        for (const character of String(message.content || '')) {
            if (prefix(part).length + body.length + character.length > MAX_BATCH_CHARS) {
                parts.push(body);
                body = '';
                part += 1;
            }
            body += character;
        }
        if (body || !parts.length)
            parts.push(body);
        for (let index = 0; index < parts.length; index += 1) {
            const text = prefix(index + 1) + parts[index];
            const extraLength = (fragments.length ? 1 : 0) + text.length;
            if (fragments.length && (length + extraLength > MAX_BATCH_CHARS || (!sources.has(sourceId) && sources.size >= MAX_BATCH_MESSAGES))) {
                batches.push({ id: `B${batches.length + 1}`, fragments, text: fragments.map(item => item.text).join('\n') });
                fragments = [];
                sources = new Set();
                length = 0;
            }
            fragments.push({ id: `${sourceId}:${index + 1}`, sourceId, part: index + 1, partCount: parts.length, text });
            sources.add(sourceId);
            length += (fragments.length > 1 ? 1 : 0) + text.length;
        }
    }
    if (fragments.length)
        batches.push({ id: `B${batches.length + 1}`, fragments, text: fragments.map(item => item.text).join('\n') });
    return batches;
}
// 在入选范围内按时间覆盖挑选成员例句，始末时段优先，重复正文只留一条。
function selectRepresentativeMessages(messages, userId, maxSamples = 15) {
    const seen = new Set();
    const candidates = messages.filter(message => {
        const text = String(message.content || '');
        if (String(message.userId || '') !== userId || !text || seen.has(text))
            return false;
        seen.add(text);
        return true;
    }).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    if (candidates.length <= maxSamples)
        return candidates;
    const chosen = new Set([0, candidates.length - 1]);
    const start = Number(candidates[0].ts || 0);
    const end = Number(candidates[candidates.length - 1].ts || 0);
    for (let i = 1; i < maxSamples - 1; i += 1) {
        const target = start + (end - start) * i / (maxSamples - 1);
        let nearest = 0;
        for (let j = 1; j < candidates.length; j += 1) {
            if (Math.abs(Number(candidates[j].ts || 0) - target) < Math.abs(Number(candidates[nearest].ts || 0) - target))
                nearest = j;
        }
        chosen.add(nearest);
    }
    for (let i = 0; chosen.size < maxSamples && i < candidates.length; i += 1)
        chosen.add(Math.floor(i * candidates.length / maxSamples));
    return [...chosen].sort((a, b) => a - b).slice(0, maxSamples).map(index => candidates[index]);
}
// --- 单元请求与结构校验 ---
// 解析明确 JSON 契约，允许常见代码块包装，不接受截断结构或空返回。
function parseObject(text) {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('日报模型返回结构无效');
    return value;
}
// 校验模型确认消费的片段或节点集合与当前输入恰好一致。
function assertConsumedIds(value, expected) {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length ||
        value.length !== expected.length || value.some(id => !expected.includes(id)))
        throw new Error('日报摘要未确认全部输入来源');
}
// 验证摘要必要内容及引用范围，来源覆盖数始终由程序集合计算。
function readSummary(value, allowed, allowedMembers, maxChars) {
    if (!Array.isArray(value.topics) || !value.topics.length || !Array.isArray(value.quoteRefs))
        throw new Error('日报摘要缺少必要字段');
    if (value.quoteRefs.length > 3)
        throw new Error('日报摘要金句候选最多3条，不能重复枚举所有节点候选');
    const topics = value.topics.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('日报话题摘要结构无效');
        const topic = raw;
        if (typeof topic.title !== 'string' || !topic.title.trim())
            throw new Error(`第${index + 1}个话题缺少非空title`);
        if (typeof topic.summary !== 'string' || !topic.summary.trim())
            throw new Error(`第${index + 1}个话题缺少非空summary；金句候选只能放顶层quoteRefs，不能作为话题`);
        if (!Array.isArray(topic.participants) || topic.participants.some(id => typeof id !== 'string' || !allowedMembers.has(id)))
            throw new Error(`第${index + 1}个话题participants必须为允许的用户ID字符串数组`);
        if (!Array.isArray(topic.sourceIds) || !topic.sourceIds.length || topic.sourceIds.some(id => !Number.isInteger(id) || !allowed.has(id)))
            throw new Error(`第${index + 1}个话题sourceIds必须为允许的来源整数数组`);
        return { title: topic.title.trim(), summary: topic.summary.trim(), participants: topic.participants, sourceIds: topic.sourceIds };
    });
    const quoteRefs = value.quoteRefs.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('日报金句来源结构无效');
        const quote = raw;
        if (!Number.isInteger(quote.sourceId) || !allowed.has(quote.sourceId) || typeof quote.reason !== 'string')
            throw new Error('日报金句来源越界');
        return { sourceId: quote.sourceId, reason: quote.reason };
    });
    const summary = { topics, quoteRefs };
    if (JSON.stringify(summary).length > maxChars)
        throw new Error('日报摘要超过本阶段长度预算');
    return summary;
}
// 在同一硬截止内取消真实请求；单请求超时与整体600秒耗尽明确区分。
async function requestAnalysisUnit(runtime, diagnostics, unit, system, input, maxTokens, timeoutMs, validate) {
    const now = runtime.now || Date.now;
    let retryCorrection = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (runtime.signal?.aborted)
            throw runtime.signal.reason || new Error('日报任务已取消');
        const remaining = runtime.deadlineMs - now();
        if (remaining <= 0)
            throw new ReportAnalysisError('日报运行总时限已耗尽', 'total_timeout', unit.stage, diagnostics);
        const workRemaining = Math.min(runtime.workDeadlineMs ?? runtime.deadlineMs, runtime.deadlineMs) - now();
        if (workRemaining <= 0)
            throw new ReportAnalysisError('日报分析预算已耗尽，已预留结果保存时间', 'generation_failed', unit.stage, diagnostics);
        const softDeadline = runtime.stageSoftDeadlinesMs?.[unit.stage];
        const budgetWarning = `${unit.stage}阶段已超过初始软预算，继续使用剩余运行时间`;
        if (softDeadline !== undefined && now() >= softDeadline && !diagnostics.warnings.includes(budgetWarning))
            diagnostics.warnings.push(budgetWarning);
        const requestStartedAt = now();
        const controller = new AbortController();
        const onOuterAbort = () => controller.abort(runtime.signal?.reason);
        runtime.signal?.addEventListener('abort', onOuterAbort, { once: true });
        const requestTimeout = Math.min(timeoutMs, remaining, workRemaining);
        const timer = setTimeout(() => controller.abort(new Error('日报单次模型请求超时')), requestTimeout);
        let onRequestAbort;
        try {
            diagnostics.reportCallCount += 1;
            if (attempt > 1)
                diagnostics.retryCount += 1;
            diagnostics.inputChars += system.length + retryCorrection.length + input.length;
            const aborted = new Promise((_, reject) => {
                onRequestAbort = () => reject(controller.signal.reason || new Error('日报请求已取消'));
                controller.signal.addEventListener('abort', onRequestAbort, { once: true });
            });
            const text = await Promise.race([runtime.request(system + retryCorrection, input, maxTokens, {
                    signal: controller.signal, _timeoutMs: requestTimeout,
                    _onRequestAttempt: () => { diagnostics.requestCount += 1; unit.onSubmitted?.(); runtime.onProgress?.(diagnostics); },
                    _onRequestUsage: (usage) => {
                        if (!usage.readable)
                            return;
                        diagnostics.usageReadableRequests += 1;
                        diagnostics.tokenUsage.promptTokens += usage.promptTokens;
                        diagnostics.tokenUsage.completionTokens += usage.completionTokens;
                        diagnostics.tokenUsage.totalTokens += usage.totalTokens;
                    },
                }), aborted]);
            if (now() >= runtime.deadlineMs)
                throw new Error('日报运行总时限已耗尽');
            if (runtime.workDeadlineMs !== undefined && now() >= runtime.workDeadlineMs)
                throw new Error('日报分析预算已耗尽，已预留结果保存时间');
            diagnostics.outputChars += text.length;
            return validate(text);
        }
        catch (error) {
            if (runtime.signal?.aborted)
                throw runtime.signal.reason || error;
            const isTotalTimeout = now() >= runtime.deadlineMs;
            const isWorkExhausted = runtime.workDeadlineMs !== undefined && now() >= runtime.workDeadlineMs;
            const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
            if (attempt === 2 || isTotalTimeout || isWorkExhausted) {
                const state = isTotalTimeout ? 'total_timeout' : 'failed';
                if (unit.stage === 'compression' || unit.stage === 'merge')
                    diagnostics.stages.compression = state;
                else if (unit.stage === 'basic' || unit.stage === 'full')
                    diagnostics.stages[unit.stage] = state;
                diagnostics.failedBatches.push({ id: unit.id, stage: unit.stage, firstSourceId: unit.sourceIds.length ? Math.min(...unit.sourceIds) : null,
                    lastSourceId: unit.sourceIds.length ? Math.max(...unit.sourceIds) : null, firstTimestamp: unit.timestamps.length ? Math.min(...unit.timestamps) : null,
                    lastTimestamp: unit.timestamps.length ? Math.max(...unit.timestamps) : null, attempts: attempt, error: message });
                const failure = new ReportAnalysisError(message, isTotalTimeout ? 'total_timeout' : 'generation_failed', unit.stage, diagnostics);
                runtime.onProgress?.(diagnostics);
                throw failure;
            }
            diagnostics.warnings.push(`${unit.id}初次处理失败，重试一次：${message}`);
            // 仅反馈脱敏的校验原因，重试仍读取原始完整输入，不拼接未校验的模型正文。
            retryCorrection = `\n上次返回未通过校验：${message}。请重新核对以上明确格式、真实编号及整个摘要对象长度，输出完整JSON。`;
            runtime.onProgress?.(diagnostics);
        }
        finally {
            diagnostics.stageDurationsMs[unit.stage] = (diagnostics.stageDurationsMs[unit.stage] || 0) + Math.max(0, now() - requestStartedAt);
            clearTimeout(timer);
            runtime.signal?.removeEventListener('abort', onOuterAbort);
            if (onRequestAbort)
                controller.signal.removeEventListener('abort', onRequestAbort);
        }
    }
    throw new Error('日报处理单元没有执行');
}
// --- 完整摘要与分层合并 ---
// 所有入选片段完成后才累计原消息成功；不会因累计长度或批次数停止后续处理。
async function summarizeCompleteInput(messages, diagnostics, runtime) {
    const batches = packInputBatches(messages);
    diagnostics.batchCount = batches.length;
    diagnostics.analysisState = 'processing';
    diagnostics.stages.compression = 'processing';
    const submitted = new Set();
    const completed = new Set();
    const expectedParts = new Map();
    const timestamps = new Map(messages.map((message, index) => [index + 1, message.ts]));
    const nodes = [];
    for (const batch of batches)
        for (const fragment of batch.fragments)
            expectedParts.set(fragment.sourceId, fragment.partCount);
    runtime.onProgress?.(diagnostics);
    for (const batch of batches) {
        const sourceIds = new Set(batch.fragments.map(fragment => fragment.sourceId));
        const memberIds = new Set([...sourceIds].map(id => String(messages[id - 1].userId || '')).filter(Boolean));
        const fragmentIds = batch.fragments.map(fragment => fragment.id);
        const system = `你是群聊摘要助手。摘要必须涵盖本批全部消息片段，包括前中后时段和长正文尾部。仅输出JSON，topics与quoteRefs组成的完整JSON对象（含字段名、编号、标点）总长不超过${INTERMEDIATE_CHARS}字符；consumedFragmentIds另计。摘要应简洁，金句候选quoteRefs最多3条。
格式：{"consumedFragmentIds":["来源编号:片段编号"],"topics":[{"title":"主题","summary":"讨论内容和结论","participants":[],"sourceIds":[1]}],"quoteRefs":[{"sourceId":1,"reason":"简短点评"}]}。每个topics元素必须同时具有title、summary、participants、sourceIds四个字段；金句候选只放顶层quoteRefs，禁止在topics中添加“金句候选”等非讨论元素。
consumedFragmentIds必须恰好为${JSON.stringify(fragmentIds)}。输入的[M来源编号:P片段编号]是可信来源。无实际话题时如实概括内容性质，不编造。金句只返回来源引用。`;
        const sourceRule = `本批允许的来源编号是${JSON.stringify([...sourceIds])}，sourceIds与quoteRefs.sourceId必须为其中的整数，不能照抄格式示例中的1。participants只允许这些实际用户ID字符串：${JSON.stringify([...memberIds])}；前缀“用户ID=”后是成员ID，[M...:P...]中的M是来源、P是片段，P1不是用户ID。无法确认参与成员可以为空数组，不能填占位文字。每个话题只选1—3条代表来源，不要再次枚举全部消息；全部消费通过consumedFragmentIds确认。相互独立的具体讨论应分别提炼，不要用一个宽泛标题吞掉所有主题。`;
        const summary = await requestAnalysisUnit(runtime, diagnostics, { id: batch.id, stage: 'compression', sourceIds: [...sourceIds], timestamps: [...sourceIds].map(id => timestamps.get(id)).filter((value) => typeof value === 'number'), onSubmitted: () => {
                for (const id of sourceIds)
                    submitted.add(id);
                diagnostics.submittedMessageCount = submitted.size;
                diagnostics.unprocessedCount = diagnostics.selectedMessageCount - submitted.size;
            } }, system + '\n' + sourceRule, batch.text, 2500, 45000, text => {
            const parsed = parseObject(text);
            assertConsumedIds(parsed.consumedFragmentIds, fragmentIds);
            return readSummary(parsed, sourceIds, memberIds, INTERMEDIATE_CHARS);
        });
        for (const fragment of batch.fragments)
            completed.add(fragment.id);
        let summarized = 0;
        for (const [id, count] of expectedParts) {
            let all = true;
            for (let part = 1; part <= count; part += 1)
                if (!completed.has(`${id}:${part}`)) {
                    all = false;
                    break;
                }
            if (all)
                summarized += 1;
        }
        diagnostics.summarizedMessageCount = summarized;
        nodes.push({ id: batch.id, ...summary, sourceIds });
        runtime.onProgress?.(diagnostics);
    }
    if (!nodes.length)
        throw new ReportAnalysisError('没有可分析的入选记录', 'generation_failed', 'compression', diagnostics);
    let current = nodes;
    while (current.length > 1) {
        diagnostics.mergeLevels += 1;
        const groups = [];
        let group = [];
        for (const node of current) {
            const candidate = [...group, node].map(item => ({ id: item.id, topics: item.topics, quoteRefs: item.quoteRefs }));
            if (group.length && JSON.stringify(candidate).length > MAX_BATCH_CHARS) {
                groups.push(group);
                group = [];
            }
            group.push(node);
        }
        if (group.length)
            groups.push(group);
        if (groups.length >= current.length)
            throw new ReportAnalysisError('摘要合并无法在长度预算内继续收敛', 'generation_failed', 'merge', diagnostics);
        const merged = [];
        for (const parents of groups) {
            if (parents.length === 1) {
                merged.push(parents[0]);
                continue;
            }
            const sourceIds = new Set(parents.flatMap(node => [...node.sourceIds]));
            const ids = parents.map(node => node.id);
            const id = `L${diagnostics.mergeLevels}-${merged.length + 1}`;
            const final = groups.length === 1;
            const maxChars = final ? MAX_BATCH_CHARS : INTERMEDIATE_CHARS;
            const input = JSON.stringify(parents.map(node => ({ id: node.id, topics: node.topics, quoteRefs: node.quoteRefs })));
            const system = `你是群聊摘要合并助手。完整合并所有输入节点，保留跨时段主要主题、结论和真实来源，不只保留前半段。仅输出JSON：{"consumedNodeIds":${JSON.stringify(ids)},"topics":[{"title":"主题","summary":"内容及结论","participants":[],"sourceIds":[1]}],"quoteRefs":[{"sourceId":1,"reason":"点评"}]}。consumedNodeIds必须恰好包含全部输入节点。topics与quoteRefs组成的完整JSON对象（含字段名、编号、标点）总长不超过${maxChars}字符；consumedNodeIds另计。quoteRefs去掉重复和同义候选，只保留最多3条。sourceIds与quoteRefs.sourceId只能沿用输入对应话题或金句的实际整数编号，不能照抄示例1。participants只能沿用输入里的真实用户ID字符串，无法确认可以为空数组，不能使用占位文字。每个话题保留1—3条代表来源；保留彼此独立的具体主题，不要全部并成一个宽泛类别。`;
            const summary = await requestAnalysisUnit(runtime, diagnostics, { id, stage: 'merge', sourceIds: [...sourceIds], timestamps: [] }, system + '\n每个topics元素必须包含title、summary、participants、sourceIds四个字段；金句候选只放顶层quoteRefs，禁止混入topics。', input, final ? 6000 : 2500, 45000, text => {
                const parsed = parseObject(text);
                assertConsumedIds(parsed.consumedNodeIds, ids);
                // 引用只能沿实际输入摘要传播，不能在合并时新增未出现过的来源引用。
                const referenced = new Set(parents.flatMap(parent => parent.topics.flatMap(topic => topic.sourceIds).concat(parent.quoteRefs.map(quote => quote.sourceId))));
                const memberIds = new Set(parents.flatMap(parent => parent.topics.flatMap(topic => topic.participants)));
                const result = readSummary(parsed, referenced, memberIds, maxChars);
                const quoteSources = new Set(parents.flatMap(parent => parent.quoteRefs.map(quote => quote.sourceId)));
                if (result.quoteRefs.some(quote => !quoteSources.has(quote.sourceId)))
                    throw new Error('合并金句来源不在输入候选中');
                return result;
            });
            merged.push({ id, ...summary, sourceIds });
            runtime.onProgress?.(diagnostics);
        }
        current = merged;
    }
    diagnostics.stages.compression = 'complete';
    const root = current[0];
    if (root.sourceIds.size !== messages.length || diagnostics.summarizedMessageCount !== messages.length)
        throw new ReportAnalysisError('最终摘要来源覆盖不完整', 'generation_failed', 'merge', diagnostics);
    const digest = JSON.stringify({ topics: root.topics, quoteRefs: root.quoteRefs });
    if (digest.length > MAX_BATCH_CHARS)
        throw new ReportAnalysisError('共同摘要超出最终输入预算', 'generation_failed', 'merge', diagnostics);
    runtime.onProgress?.(diagnostics);
    return { digest, sourceIds: root.sourceIds, quoteRefs: root.quoteRefs };
}
