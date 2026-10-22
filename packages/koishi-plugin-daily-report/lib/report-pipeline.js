"use strict";
/**
 * MODULE: 日报生成管线。
 * 职责: 生成日报文字、可选图片和结构化结果，不直接发送 QQ 消息。
 * 边界: 不管理 S2 任务状态，不获取 S0 锁，调用方负责准入、锁和通知。
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { collectReportData } = require('./data-collector');
const { analyzeWithAI } = require('./ai-analyzer');
const { renderReport } = require('./html-renderer');
const { createTaskArtifactStore } = require('./analysis-artifacts');
const getReportEmptyStates = require('./models').getReportEmptyStates;
const { getErrorMessage } = require('./error-utils');
const { GROUNDED_REPORT_LIMITS } = require('./report-runner');
const { readGroundedReportConfiguration, collectGroundedReportInput, analyzeGroundedReport } = require('./report-grounded-entry');
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { createReportPeriod } = loadManagementModule('daily.reportPeriod');
const { getResourceGateStatus } = loadManagementModule('resource.gate');
const { redactSensitiveText } = loadManagementModule('core.redactor');
const { createReportAnalysisDiagnostics, ReportAnalysisError, isReportTotalTimeoutError } = loadManagementModule('daily.reportAnalysis');
const { hasActiveResourceActivityLease } = loadManagementModule('resource.activityLease');
const serverModePolicy = loadManagementModule('resource.serverModePolicy');
// 把未知错误压成稳定字符串，供 result.json 和 worker 日志使用。
// 确保输出目录存在。
function ensureOutputDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
// 提取 AI 分析阶段给出的降级或异常提示。
function collectAnalysisWarnings(analysis) {
    const warnings = analysis?.meta?.warnings;
    return Array.isArray(warnings) ? warnings.map(String).filter(Boolean).slice(0, 20) : [];
}
// 生成可直接发送的文字版日报，作为图片失败时的保底结果。
function composeDailyReportText(data, analysis, options = {}) {
    const lines = [];
    const empty = getReportEmptyStates(analysis);
    const title = options.detail ? '群聊详细日报' : '群聊日报';
    lines.push(`${title} 文字版`);
    if (options.reason)
        lines.push(`结果说明：${options.reason}`);
    lines.push(`日期：${data.date || '未知'}`);
    if (data.reportPeriod) {
        const format = (value) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
        lines.push(`统计时段：${format(data.reportPeriod.periodStartMs)} 至 ${format(data.reportPeriod.cutoffMs)}（北京时间）`);
    }
    lines.push(`消息：${Number(data.totalMessages || 0)} 条`);
    lines.push(`活跃成员：${Number(data.activeMembers || 0)} 人`);
    lines.push(`表情：${Number(data.emojiCount || 0)} 个`);
    lines.push(`总字数：${Number(data.totalChars || 0)} 字`);
    lines.push(`高峰：${data.peakHour || '未知'}`);
    const topMembers = Array.isArray(data.topMembers) ? data.topMembers.slice(0, 5) : [];
    if (topMembers.length) {
        lines.push('', '活跃群友：');
        for (let i = 0; i < topMembers.length; i++) {
            const member = topMembers[i];
            lines.push(`${i + 1}. ${member.name || '群友'}：${Number(member.msgCount || 0)} 条`);
        }
    }
    const topics = Array.isArray(analysis.topics) ? analysis.topics : [];
    if (topics.length) {
        lines.push('', '话题摘要：');
        for (const topic of topics)
            lines.push(`- ${topic.title || '话题'}：${topic.summary || '暂无摘要'}`);
    }
    else if (empty.topics)
        lines.push('', '话题摘要：', empty.topics);
    const quotes = Array.isArray(analysis.goldenQuotes) ? analysis.goldenQuotes.slice(0, 5) : [];
    if (quotes.length) {
        lines.push('', '今日金句：');
        for (const quote of quotes) {
            const reason = quote.reason ? ` (${quote.reason})` : '';
            lines.push(`- ${quote.sender || '群友'}：${quote.content || ''}${reason}`);
        }
    }
    else if (empty.quotes)
        lines.push('', '今日金句：', empty.quotes);
    const titles = Array.isArray(analysis.userTitles) ? analysis.userTitles : [];
    if (titles.length) {
        lines.push('', '群友画像：');
        for (const item of titles) {
            const reason = item.reason ? `：${item.reason}` : '';
            lines.push(`- ${item.name || '群友'}：${item.title || '活跃群友'}${reason}`);
        }
    }
    else if (empty.portraits)
        lines.push('', '群友画像：', empty.portraits);
    if (analysis.qualityReview) {
        lines.push('', '群聊锐评：');
        lines.push(`${analysis.qualityReview.title || '今日群聊'}：${analysis.qualityReview.summary || '暂无总结'}`);
        if (analysis.qualityReview.subtitle)
            lines.push(analysis.qualityReview.subtitle);
        for (const dimension of analysis.qualityReview.dimensions || []) {
            lines.push(`- ${dimension.name}（${dimension.percentage}%）：${dimension.comment}`);
        }
    }
    else if (empty.review)
        lines.push('', '群聊锐评：', empty.review);
    return lines.join('\n');
}
// 原子写入文本文件。
function writeTextFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
}
// 原子写入二进制文件。
function writeBufferFile(file, buffer) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
}
// 原子写入 JSON 文件。
function writeJsonFile(file, data) {
    writeTextFile(file, JSON.stringify(data, null, 2));
}
// 构造日报结果 JSON 的公共字段。
function buildResultBase(taskId, data, analysis, textPath, warnings) {
    return {
        ok: true,
        taskId,
        kind: 'daily_report',
        level: 'L2',
        mode: 'text',
        reason: 'text_ready',
        textPath,
        imagePath: null,
        warnings,
        date: data.date || '',
        totalMessages: Number(data.totalMessages || 0),
        activeMembers: Number(data.activeMembers || 0),
        precomputedCoverageRate: Number(data.precomputedCoverageRate || 0),
        analysisMeta: analysis.meta || null,
    };
}
// 默认从实际S0捕获原票据，后续不能借同任务新票据继续提交产物。
function captureReportArtifactLease(taskId) {
    const original = getResourceGateStatus();
    if (!original.locked || !original.meta || original.meta.taskId !== taskId || original.meta.kind !== 'daily_report'
        || original.meta.pid !== process.pid || !original.meta.ticketId)
        throw new Error('日报产物缺少本次S0独占租约');
    const ticketId = original.meta.ticketId;
    return () => {
        const current = getResourceGateStatus();
        if (!current.locked || !current.meta || current.meta.taskId !== taskId || current.meta.kind !== 'daily_report'
            || current.meta.pid !== process.pid || current.meta.ticketId !== ticketId)
            throw new Error('日报产物S0独占租约已失效');
    };
}
// 执行完整日报并原子保存诊断；硬截止、取消与失败不能转成部分成功。
async function generateDailyReportResult(options) {
    const taskId = String(options.taskId || `daily-report-${Date.now()}`);
    const outputDir = String(options.outputDir || '');
    if (!outputDir)
        throw new Error('daily report outputDir is required');
    ensureOutputDir(outputDir);
    const now = options.now || Date.now;
    const deadlineMs = options.deadlineMs ?? now() + GROUNDED_REPORT_LIMITS.runTimeoutMs;
    const startedAtMs = options.startedAtMs ?? now();
    const runtimeBudgetMs = Math.max(0, deadlineMs - startedAtMs);
    // 三十分钟任务预留30秒落盘；外部更短截止仍按至多5%比例预留。
    const workDeadlineMs = deadlineMs - Math.min(GROUNDED_REPORT_LIMITS.saveReserveMs, runtimeBudgetMs * 0.05);
    const stageSoftDeadlinesMs = { compression: startedAtMs + runtimeBudgetMs * 0.6,
        merge: startedAtMs + runtimeBudgetMs * 0.7, basic: startedAtMs + runtimeBudgetMs * 0.8, full: startedAtMs + runtimeBudgetMs * 0.8 };
    let collectingDurationMs = 0;
    let assertLease;
    const reportPeriod = options.reportPeriod || createReportPeriod(now());
    let stage = 'collecting';
    let diagnostics = createReportAnalysisDiagnostics({ windowMessageCount: 0, selectedMessageCount: 0,
        sourceCompleteness: 'legacy_unknown', reportPeriod, periodBackfilled: options.periodBackfilled });
    // 所有阶段共用执行器传入的同一硬截止，进入下一阶段不能重新计时。
    const assertRuntime = () => {
        if (options.signal?.aborted)
            throw options.signal.reason || new Error('日报任务已取消');
        if (now() >= deadlineMs)
            throw new ReportAnalysisError('日报运行总时限已耗尽', 'total_timeout', stage, diagnostics);
        options.assertActive?.();
        assertLease?.();
    };
    // 进度只含计数、阶段和脱敏原因，最后一次进度可供进程回收后保留。
    const saveProgress = (value) => {
        options.assertActive?.();
        assertLease?.();
        value.stageDurationsMs.collecting = collectingDurationMs;
        value.stageDurationsMs.runtime = Math.max(0, now() - startedAtMs);
        diagnostics = value;
        writeJsonFile(path.join(outputDir, 'analysis-progress.json'), { taskId, reportPolicyVersion: 2, analysisMeta: value });
    };
    // 任务步骤沿用现有显示通道，并在变更前检查硬截止。
    const emitStep = (step) => {
        stage = step;
        assertRuntime();
        if (typeof options.onStep === 'function')
            options.onStep(step);
    };
    try {
        const groundedConfiguration = readGroundedReportConfiguration();
        emitStep('collecting');
        saveProgress(diagnostics);
        const groundedInput = groundedConfiguration ? collectGroundedReportInput(options.channelKey, reportPeriod, assertRuntime) : null;
        const collected = groundedInput ? groundedInput.data : collectReportData(options.channelKey, reportPeriod);
        collectingDurationMs = Math.max(0, now() - startedAtMs);
        const data = collected;
        diagnostics = createReportAnalysisDiagnostics({ windowMessageCount: data?.windowMessageCount ?? data?.totalMessages ?? 0,
            selectedMessageCount: data?.messages?.length || 0, sourceCompleteness: data?.sourceCompleteness || 'legacy_unknown',
            reportPeriod, periodBackfilled: options.periodBackfilled });
        saveProgress(diagnostics);
        assertRuntime();
        if (diagnostics.sourceCompleteness === 'incomplete')
            throw new ReportAnalysisError('日报原始记录不完整，不能生成完整日报', 'generation_failed', stage, diagnostics);
        if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
            const textPath = path.join(outputDir, 'report.txt');
            writeTextFile(textPath, '今天还没有收录足够多的消息');
            diagnostics.analysisState = 'complete';
            diagnostics.stages = { compression: 'not_requested', basic: 'not_requested', full: 'not_requested' };
            saveProgress(diagnostics);
            const result = { ok: true, taskId, kind: 'daily_report', level: 'L3', mode: 'summary',
                reason: 'no_report_data', textPath, imagePath: null, warnings: ['no report data'], reportPeriod,
                periodBackfilled: options.periodBackfilled === true, analysisMeta: diagnostics };
            assertRuntime();
            writeJsonFile(path.join(outputDir, 'result.json'), result);
            return result;
        }
        emitStep('analyzing');
        assertLease = options.assertLease || captureReportArtifactLease(taskId);
        assertLease();
        const artifactStore = createTaskArtifactStore({ taskId, channelKey: String(options.channelKey), deadlineMs, assertActive: assertRuntime, assertLease, now });
        const grounded = groundedInput && groundedConfiguration ? await analyzeGroundedReport(groundedInput, !!options.detail, {
            taskId, channelKey: String(options.channelKey), configuration: groundedConfiguration, periodBackfilled: options.periodBackfilled,
            startedAtMs, deadlineMs, workDeadlineMs, signal: options.signal, now, onProgress: saveProgress,
            assertActive: assertRuntime, assertLease, ...artifactStore
        }) : null;
        const analysis = grounded ? grounded.analysis : await analyzeWithAI({ ...data, reportPeriod, periodBackfilled: options.periodBackfilled }, !!options.detail, { deadlineMs, workDeadlineMs, stageSoftDeadlinesMs, signal: options.signal, now, onProgress: saveProgress, ...artifactStore });
        if (!analysis.meta || analysis.meta.analysisState !== 'complete')
            throw new ReportAnalysisError('日报必要分析缺少完整成功诊断', 'generation_failed', stage, diagnostics);
        saveProgress(analysis.meta);
        const warnings = collectAnalysisWarnings(analysis);
        emitStep('compose_text');
        const textPath = path.join(outputDir, 'report.txt');
        writeTextFile(textPath, composeDailyReportText(data, analysis, { detail: !!options.detail }));
        const result = buildResultBase(taskId, data, analysis, textPath, warnings);
        result.reportPeriod = reportPeriod;
        result.periodBackfilled = options.periodBackfilled === true;
        result.reportPolicyVersion = 2;
        if (grounded) {
            result.analysisVersion = grounded.analysis.analysisVersion;
            result.analysisStorage = grounded.storage;
        }
        if (options.renderImage === false)
            result.reason = 'render_disabled';
        else if (now() >= workDeadlineMs) {
            result.reason = 'render_budget_exhausted';
            result.warnings.push('图片渲染预算不足，保留完整文字结果');
        }
        else {
            const strictMutualExclusion = typeof serverModePolicy.readResourceActivityMutualExclusionState === 'function'
                ? !!serverModePolicy.readResourceActivityMutualExclusionState().strictActivityMutualExclusion
                : String(serverModePolicy.readServerModeConfig?.().serverMode || 'large').trim().toLowerCase() === 'small';
            if (strictMutualExclusion && hasActiveResourceActivityLease('tool_active')) {
                result.reason = 'render_blocked_by_tool_active';
                result.warnings.push(result.reason);
            }
            else {
                emitStep('rendering');
                const renderStarted = now();
                try {
                    const imageBuffer = await renderReport(data, analysis, { taskId, deadlineMs, workDeadlineMs, signal: options.signal, now });
                    assertRuntime();
                    const imagePath = path.join(outputDir, 'report.png');
                    writeBufferFile(imagePath, imageBuffer);
                    result.level = 'L0';
                    result.mode = 'image';
                    result.reason = 'completed';
                    result.imagePath = imagePath;
                }
                catch (error) {
                    // 完整文字只可在硬截止以内保留；总超时或用户取消继续传播。
                    assertRuntime();
                    if (isReportTotalTimeoutError(error))
                        throw error;
                    result.reason = `render_failed:${getErrorMessage(error, '')}`;
                    result.warnings.push(result.reason);
                }
                finally {
                    diagnostics.stageDurationsMs.rendering = Math.max(0, now() - renderStarted);
                }
            }
        }
        emitStep('writing_result');
        const savingStartedAt = now();
        saveProgress(diagnostics);
        result.analysisMeta = diagnostics;
        if (grounded) {
            // S2任务摘要会有界脱敏；完整分析独立原子保存，防止审计数组被任务层截断。
            const analysisPath = path.join(outputDir, 'analysis.json'), analysisText = JSON.stringify(grounded.analysis, null, 2);
            writeTextFile(analysisPath, analysisText);
            assertRuntime();
            result.analysisPath = analysisPath;
            result.analysisSha256 = createHash('sha256').update(analysisText).digest('hex');
        }
        writeJsonFile(path.join(outputDir, 'result.json'), result);
        diagnostics.stageDurationsMs.saving = Math.max(0, now() - savingStartedAt);
        assertRuntime();
        saveProgress(diagnostics);
        writeJsonFile(path.join(outputDir, 'result.json'), result);
        return result;
    }
    catch (error) {
        // 用户取消沿用取消状态，不能建立生成失败通知标记。
        if (options.signal?.aborted && !isReportTotalTimeoutError(options.signal.reason))
            throw options.signal.reason || error;
        // 领取失效后连失败结果也不写，避免旧执行覆盖当前任务的产物。
        options.assertActive?.();
        const failure = error instanceof ReportAnalysisError ? error :
            new ReportAnalysisError(getErrorMessage(error), isReportTotalTimeoutError(error) || now() >= deadlineMs ? 'total_timeout' : 'generation_failed', stage, diagnostics);
        try {
            saveProgress(failure.diagnostics);
        }
        catch (progressError) {
            // 原S0已失效或失败诊断落盘错误时停止写结果，保留原失败对象和已经发生的用量。
            failure.diagnostics.warnings.push('失败进度保存失败：' + redactSensitiveText(getErrorMessage(progressError)));
            throw failure;
        }
        writeJsonFile(path.join(outputDir, 'result.json'), { taskId, kind: 'daily_report', ok: false, reportPolicyVersion: 2,
            reportPeriod, periodBackfilled: options.periodBackfilled === true, analysisMeta: failure.diagnostics,
            failureKind: failure.diagnostics.failureKind, failureStage: failure.diagnostics.failureStage,
            failureNotificationVersion: 2, error: failure.message,
            reason: failure.diagnostics.failureKind === 'total_timeout' ? 'daily_report_total_timeout' : 'daily_report_generation_failed' });
        throw failure;
    }
}
module.exports = { composeDailyReportText, generateDailyReportResult };
