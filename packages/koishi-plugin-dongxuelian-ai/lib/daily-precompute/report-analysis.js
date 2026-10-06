"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportAnalysisError = exports.ReportRuntimeTimeoutError = exports.REPORT_TIMEOUT_TEXT = exports.REPORT_FAILURE_TEXT = void 0;
exports.sanitizeReportDiagnosticText = sanitizeReportDiagnosticText;
exports.sanitizeReportAnalysisDiagnostics = sanitizeReportAnalysisDiagnostics;
exports.isReportTotalTimeoutError = isReportTotalTimeoutError;
exports.createReportAnalysisDiagnostics = createReportAnalysisDiagnostics;
/** 日报分析诊断契约：输入覆盖、阶段结果与明确失败分类共用同一口径。 */
const report_period_1 = require("./report-period");
const redactor = require("../core/redactor");
exports.REPORT_FAILURE_TEXT = '日报生成失败，请稍后重试，或联系Bot管理员处理';
exports.REPORT_TIMEOUT_TEXT = '日报生成超时，请稍后重试，或联系Bot管理员处理';
// 诊断只保留有限错误文本，移除凭据及本机/服务器文件路径。
function sanitizeReportDiagnosticText(value, limit = 800) {
    return redactor.redactSensitiveText(value).replace(/[A-Za-z]:[\\/][^\s"'<>]+|\/(?:root|home|var|tmp|etc|usr)\/[^\s"'<>]+/g, '[内部路径]').slice(0, limit);
}
// 读取明确的非负数量，非法诊断文件不能在控制台显示为真实统计。
function diagnosticCount(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('日报诊断数量字段无效');
    return value;
}
// 按共享类型生成白名单副本，凭据同名字段和未知聊天/载荷字段均不进入输出。
function sanitizeReportAnalysisDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('日报诊断结构无效');
    const input = value;
    if (input.reportPolicyVersion !== 2 || typeof input.periodBackfilled !== 'boolean'
        || !['complete', 'incomplete', 'legacy_unknown'].includes(input.sourceCompleteness)
        || !['not_started', 'processing', 'complete', 'failed', 'total_timeout'].includes(input.analysisState)
        || ![null, 'generation_failed', 'total_timeout'].includes(input.failureKind))
        throw new Error('日报诊断规则或状态无效');
    const output = createReportAnalysisDiagnostics({ windowMessageCount: diagnosticCount(input.windowMessageCount), selectedMessageCount: diagnosticCount(input.selectedMessageCount), sourceCompleteness: input.sourceCompleteness, periodBackfilled: input.periodBackfilled });
    for (const field of ['excludedByLimitCount', 'submittedMessageCount', 'summarizedMessageCount', 'topicInputMessageCount', 'omittedMessageCount',
        'batchCount', 'unprocessedCount', 'mergeLevels', 'requestCount', 'reportCallCount', 'retryCount', 'inputChars', 'outputChars', 'usageReadableRequests'])
        output[field] = diagnosticCount(input[field]);
    if (input.coverageRate !== null && (typeof input.coverageRate !== 'number' || !Number.isFinite(input.coverageRate) || input.coverageRate < 0 || input.coverageRate > 100))
        throw new Error('日报诊断覆盖率无效');
    output.coverageRate = input.coverageRate;
    output.analysisState = input.analysisState;
    output.failureKind = input.failureKind;
    if (typeof input.failureStage !== 'string' || typeof input.error !== 'string')
        throw new Error('日报诊断错误字段无效');
    output.failureStage = sanitizeReportDiagnosticText(input.failureStage, 80);
    output.error = sanitizeReportDiagnosticText(input.error);
    if (input.reportPeriod) {
        const period = (0, report_period_1.resolveReportPeriod)(input.reportPeriod, '');
        output.reportPeriod = { reportPolicyVersion: 2, reportDate: period.reportDate, periodStartMs: period.periodStartMs, periodEndMs: period.periodEndMs, cutoffMs: period.cutoffMs };
    }
    if (!input.tokenUsage || typeof input.tokenUsage !== 'object' || Array.isArray(input.tokenUsage))
        throw new Error('日报诊断模型用量无效');
    output.tokenUsage = { promptTokens: diagnosticCount(input.tokenUsage.promptTokens), completionTokens: diagnosticCount(input.tokenUsage.completionTokens), totalTokens: diagnosticCount(input.tokenUsage.totalTokens) };
    if (!input.stages || typeof input.stages !== 'object')
        throw new Error('日报诊断阶段无效');
    for (const field of ['compression', 'basic', 'full']) {
        if (!['pending', 'processing', 'complete', 'failed', 'total_timeout', 'not_requested'].includes(input.stages[field]))
            throw new Error('日报诊断阶段状态无效');
        output.stages[field] = input.stages[field];
    }
    if (!input.stageDurationsMs || typeof input.stageDurationsMs !== 'object' || Array.isArray(input.stageDurationsMs))
        throw new Error('日报诊断阶段耗时无效');
    for (const field of ['collecting', 'compression', 'merge', 'summary_and_merge', 'basic', 'full', 'analysis', 'rendering', 'saving', 'runtime']) {
        if (input.stageDurationsMs[field] !== undefined)
            output.stageDurationsMs[field] = diagnosticCount(input.stageDurationsMs[field]);
    }
    if (!Array.isArray(input.failedBatches) || !Array.isArray(input.warnings))
        throw new Error('日报诊断失败单元或提醒无效');
    output.failedBatches = input.failedBatches.map(unit => {
        if (!unit || typeof unit.id !== 'string' || typeof unit.stage !== 'string' || typeof unit.error !== 'string')
            throw new Error('日报诊断失败单元结构无效');
        return { id: sanitizeReportDiagnosticText(unit.id, 80), stage: sanitizeReportDiagnosticText(unit.stage, 80),
            firstSourceId: unit.firstSourceId === null ? null : diagnosticCount(unit.firstSourceId), lastSourceId: unit.lastSourceId === null ? null : diagnosticCount(unit.lastSourceId),
            firstTimestamp: unit.firstTimestamp === null ? null : diagnosticCount(unit.firstTimestamp), lastTimestamp: unit.lastTimestamp === null ? null : diagnosticCount(unit.lastTimestamp),
            attempts: diagnosticCount(unit.attempts), error: sanitizeReportDiagnosticText(unit.error) };
    });
    output.warnings = input.warnings.map(warning => {
        if (typeof warning !== 'string')
            throw new Error('日报诊断提醒无效');
        return sanitizeReportDiagnosticText(warning, 300);
    });
    return output;
}
// 外层执行器的硬截止错误无需伪造尚未取得的分析数量。
class ReportRuntimeTimeoutError extends Error {
    // 保存明确的总时限错误，供取消信号、管线和任务监督器共用。
    constructor(message = '日报运行总时限已耗尽') {
        super(message);
        this.code = 'DAILY_REPORT_TOTAL_TIMEOUT';
        this.name = 'ReportRuntimeTimeoutError';
    }
}
exports.ReportRuntimeTimeoutError = ReportRuntimeTimeoutError;
// 仅识别共享契约的确定错误码，单请求和渲染错误文字不决定总超时。
function isReportTotalTimeoutError(error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'DAILY_REPORT_TOTAL_TIMEOUT');
}
// 用明确输入数量初始化诊断，未知用量与零条覆盖不伪造成功数据。
function createReportAnalysisDiagnostics(input) {
    if (!Number.isInteger(input.selectedMessageCount) || input.selectedMessageCount < 0 || !Number.isInteger(input.windowMessageCount) || input.windowMessageCount < input.selectedMessageCount) {
        throw new Error('日报诊断输入数量无效');
    }
    return {
        reportPolicyVersion: 2, reportPeriod: input.reportPeriod, periodBackfilled: input.periodBackfilled === true,
        windowMessageCount: input.windowMessageCount, selectedMessageCount: input.selectedMessageCount,
        excludedByLimitCount: input.windowMessageCount - input.selectedMessageCount,
        submittedMessageCount: 0, summarizedMessageCount: 0, topicInputMessageCount: 0,
        omittedMessageCount: input.selectedMessageCount, coverageRate: input.selectedMessageCount ? 0 : null,
        batchCount: 0, failedBatches: [], unprocessedCount: input.selectedMessageCount, mergeLevels: 0,
        requestCount: 0, reportCallCount: 0, retryCount: 0, inputChars: 0, outputChars: 0,
        usageReadableRequests: 0, tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, stageDurationsMs: {}, failureKind: null, failureStage: '', error: '',
        sourceCompleteness: input.sourceCompleteness, analysisState: 'not_started', warnings: [],
        stages: { compression: 'pending', basic: 'pending', full: 'pending' },
    };
}
// 失败携带最新诊断，供管线、任务存储与监督器保留；分类不依赖错误文本。
class ReportAnalysisError extends Error {
    // 创建已脱敏的确定失败类别，并同步诊断状态。
    constructor(message, kind, stage, diagnostics) {
        const safeMessage = redactor.redactSensitiveText(message);
        super(safeMessage);
        this.name = 'ReportAnalysisError';
        this.code = kind === 'total_timeout' ? 'DAILY_REPORT_TOTAL_TIMEOUT' : 'DAILY_REPORT_GENERATION_FAILED';
        diagnostics.failureKind = kind;
        diagnostics.failureStage = stage;
        diagnostics.error = safeMessage;
        diagnostics.analysisState = kind === 'total_timeout' ? 'total_timeout' : 'failed';
        this.diagnostics = diagnostics;
    }
}
exports.ReportAnalysisError = ReportAnalysisError;
