"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindTopicStageRequest = bindTopicStageRequest;
exports.bindOutputStageRequest = bindOutputStageRequest;
exports.verifyReportStageOrigin = verifyReportStageOrigin;
/** 日报各阶段的明确永久绑定表；不猜测JSON字段、不改写自由原话或人物称号。 */
const util_1 = require("util");
const report_cache_provenance_1 = require("./report-cache-provenance");
// --- 永久来源与连续原文 ---
// 每条短引用由当前快照恢复永久来源、片段与本人，不保存本次全局编号。
function stagePermanentFragments(snapshot, fragments) {
    if (new Set(fragments.map(fragment => fragment.id)).size !== fragments.length)
        throw new Error('阶段永久来源不能重复');
    return fragments.map(fragment => {
        const source = snapshot.sources[fragment.sourceId - 1];
        if (snapshot.byFragmentId.get(fragment.id) !== fragment || !source.messageId || source.realMessageId !== true || !fragment.permanentKey) {
            throw new Error('阶段来源没有可靠永久所有权');
        }
        return { key: fragment.permanentKey, messageId: source.messageId, sourceIdentity: source.identity, memberId: source.userId,
            part: fragment.part, partCount: fragment.partCount };
    });
}
// 本人样本与辅助摘录仍只绑定明确连续原文；范围使用代码单元，仅用于原文逐字核验。
function stageTextSource(snapshot, alias, sourceId, text, role, author) {
    const source = snapshot.sources[sourceId - 1], start = source?.content.indexOf(text);
    if (!source || start === undefined || start < 0 || !author)
        throw new Error('阶段样本不是明确来源及本人的连续原文');
    return { alias, role, author, textIdentity: (0, report_cache_provenance_1.reportCacheDigest)(text), range: { utf16Start: start, utf16End: start + text.length },
        fragments: stagePermanentFragments(snapshot, snapshot.fragments.filter(fragment => fragment.sourceId === sourceId)) };
}
// 每个永久片段只保存一次，引用表只保存摘要键，避免大话题的来源表成倍重复。
function registerStageFragments(value, rows) {
    const known = new Set(value.fragments.map(fragment => fragment.key));
    for (const row of rows)
        if (!known.has(row.key)) {
            value.fragments.push(row);
            known.add(row.key);
        }
    return rows.map(row => row.key);
}
// --- 已知话题与输出材料 ---
// 话题原文、候选及辅助各有独立引用表；分段概述保留摘要文本身份和永久依据。
function bindTopicStageRequest(snapshot, context, provenance) {
    if (!snapshot.hasStableMessageIds)
        return null;
    if (!context.cacheMaterial)
        throw new Error('话题阶段缺少明确供料类型');
    const value = { version: 'stage-bindings-1', material: context.cacheMaterial.kind === 'summary' ? 'topic-summary'
            : context.cacheMaterial.kind === 'comparison' ? 'topic-comparison' : 'topic-raw',
        provenance: [], fragments: [], sources: [], candidates: [], members: [], targets: [], statistics: [] };
    value.provenance = registerStageFragments(value, stagePermanentFragments(snapshot, provenance));
    for (const [alias, fragments] of context.sources) {
        const permanent = registerStageFragments(value, stagePermanentFragments(snapshot, fragments));
        if (context.cacheMaterial.kind === 'summary') {
            const summary = context.cacheMaterial.summaries.get(alias);
            if (!summary)
                throw new Error('分段摘要没有对应永久依据');
            value.sources.push({ alias, role: 'summary', author: null, fragments: permanent, textIdentity: (0, report_cache_provenance_1.reportCacheDigest)(summary), range: null });
        }
        else {
            if (fragments.length !== 1)
                throw new Error('话题原文引用必须绑定一个完整片段');
            const fragment = fragments[0];
            const author = context.cacheMaterial.batch.core.get(alias)?.author;
            if (!author)
                throw new Error('话题核心缺少明确本人别名');
            const text = context.cacheMaterial.kind === 'comparison' ? context.cacheMaterial.excerpts.get(alias) : fragment.text;
            if (text === undefined || !fragment.text.startsWith(text))
                throw new Error('全局比较摘录必须是原片段的完整连续前缀');
            const before = snapshot.fragments.filter(part => part.sourceId === fragment.sourceId && part.part < fragment.part).reduce((sum, part) => sum + part.text.length, 0);
            value.sources.push({ alias, role: 'raw', author, fragments: permanent, textIdentity: (0, report_cache_provenance_1.reportCacheDigest)(text),
                range: { utf16Start: before, utf16End: before + text.length } });
        }
    }
    for (const [alias, candidate] of context.candidates)
        value.candidates.push({ alias, fragments: registerStageFragments(value, stagePermanentFragments(snapshot, candidate.fragments)),
            kind: candidate.kind ?? null, category: candidate.category ?? null });
    if (context.cacheMaterial.kind !== 'summary') {
        const batch = context.cacheMaterial.batch;
        for (const [alias, member] of batch.members)
            value.members.push({ alias, memberId: member.userId, primarySources: [] });
        for (const [alias, entry] of batch.auxiliary) {
            const author = [...batch.members].find(([, member]) => member.userId === snapshot.sources[entry.sourceId - 1].userId)?.[0];
            const source = stageTextSource(snapshot, alias, entry.sourceId, entry.text, 'auxiliary', author);
            value.sources.push({ ...source, fragments: registerStageFragments(value, source.fragments) });
        }
    }
    return value;
}
// 金句、本人画像与锐评使用明确来源角色和本人表，统计只保存程序提供的文字身份。
function bindOutputStageRequest(snapshot, context, provenance) {
    if (!snapshot.hasStableMessageIds)
        return null;
    const value = { version: 'stage-bindings-1', material: 'output', provenance: [], fragments: [],
        sources: [], candidates: [], members: [], targets: [...context.members.keys()], statistics: [] };
    value.provenance = registerStageFragments(value, stagePermanentFragments(snapshot, provenance));
    for (const [alias, source] of context.sources) {
        if (snapshot.sources[source.sourceId - 1]?.userId !== source.userId)
            throw new Error('输出样本被绑定到其他本人');
        const author = [...context.people].find(([, person]) => person.userId === source.userId)?.[0];
        const binding = stageTextSource(snapshot, alias, source.sourceId, source.text, source.role, author);
        value.sources.push({ ...binding, fragments: registerStageFragments(value, binding.fragments) });
    }
    for (const [alias, person] of context.people) {
        const target = context.members.get(alias);
        if (target && (target.userId !== person.userId || target.refs.some(ref => context.sources.get(ref)?.userId !== person.userId
            || context.sources.get(ref)?.role !== 'primary')))
            throw new Error('画像成员不是实际本人样本所有者');
        value.members.push({ alias, memberId: person.userId, primarySources: target ? [...target.refs] : [] });
    }
    for (const [alias, text] of context.statistics)
        value.statistics.push({ alias, textIdentity: (0, report_cache_provenance_1.reportCacheDigest)(text) });
    return value;
}
// --- 来源快照见证 ---
// 命中时对原快照核验所有永久片段、本人和连续原文；摘要仍须当前上游重建相同实际请求。
function verifyReportStageOrigin(snapshot, bindings) {
    if (!snapshot.hasStableMessageIds || bindings.version !== 'stage-bindings-1')
        throw new Error('阶段来源快照不具备永久缓存资格');
    const available = new Map(snapshot.fragments.map(fragment => [fragment.permanentKey, fragment]));
    const own = new Map(bindings.fragments.map(fragment => [fragment.key, fragment]));
    if (own.size !== bindings.fragments.length)
        throw new Error('阶段永久来源表重复');
    const verify = (rows) => {
        const fragments = rows.map(row => available.get(row.key));
        if (fragments.some(fragment => !fragment) || !(0, util_1.isDeepStrictEqual)(stagePermanentFragments(snapshot, fragments), rows))
            throw new Error('阶段永久来源或本人无法在原快照恢复');
    };
    verify(bindings.fragments);
    const members = new Map(bindings.members.map(member => [member.alias, member]));
    if (members.size !== bindings.members.length || new Set(bindings.members.map(member => member.memberId)).size !== bindings.members.length
        || bindings.targets.some(alias => !members.has(alias) || !members.get(alias).primarySources.length))
        throw new Error('阶段成员别名或本人目标无效');
    const resolve = (keys) => {
        if (new Set(keys).size !== keys.length || keys.some(key => !own.has(key)))
            throw new Error('阶段引用没有对应永久来源');
        return keys.map(key => own.get(key));
    };
    resolve(bindings.provenance);
    bindings.candidates.forEach(candidate => resolve(candidate.fragments));
    for (const source of bindings.sources) {
        const rows = resolve(source.fragments);
        if (source.role === 'summary') {
            if (source.range !== null || source.author !== null)
                throw new Error('摘要不能冒充直接原文范围或本人');
            continue;
        }
        const first = rows[0], original = snapshot.byMessageId.get(first?.messageId);
        const range = source.range;
        if (!original || !range || !Number.isInteger(range.utf16Start) || !Number.isInteger(range.utf16End)
            || range.utf16Start < 0 || range.utf16End < range.utf16Start || range.utf16End > original.content.length
            || rows.some(fragment => fragment.messageId !== first.messageId || fragment.memberId !== members.get(source.author || '')?.memberId)
            || (0, report_cache_provenance_1.reportCacheDigest)(original.content.slice(range.utf16Start, range.utf16End)) !== source.textIdentity)
            throw new Error('阶段原文范围或文字摘要不一致');
    }
    const users = new Set(snapshot.sources.map(source => source.userId)), aliases = new Map(bindings.sources.map(source => [source.alias, source]));
    for (const member of bindings.members)
        if (!users.has(member.memberId) || member.primarySources.some(ref => {
            const source = aliases.get(ref);
            return !source || source.role !== 'primary' || resolve(source.fragments).some(fragment => fragment.memberId !== member.memberId);
        }))
            throw new Error('阶段结构化成员与本人来源不一致');
}
