"use strict";
/**
 * MODULE: S3 日报预计算状态。
 * 职责: 读取日报预计算 coverage、slot 和事件摘要，供 Dashboard 与日报触发阶段使用。
 * 边界: 不生成 AI 摘要，不执行分片 worker。
 */
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { listJsonFiles, readJsonFile, readRecentJsonlEvents, sanitizeId } = require('../resource-common/files');
const { INDEX_ROOT } = require('./precompute-index');
const PRECOMPUTE_ROOT = path.join(DATA_DIR, 'daily-precompute');
const COVERAGE_ROOT = path.join(PRECOMPUTE_ROOT, 'coverage');
const SLOTS_ROOT = path.join(PRECOMPUTE_ROOT, 'slots');
const FINAL_INPUT_ROOT = path.join(PRECOMPUTE_ROOT, 'final-input');
// 返回 final-input 文件路径，保持和写入阶段同一套安全标识规则。
function getDailyFinalInputFile(date, channelKey) {
    return path.join(FINAL_INPUT_ROOT, sanitizeId(date), `${sanitizeId(channelKey)}.json`);
}
// 列出预计算覆盖率文件，用于资源中心展示。
function listDailyCoverage(limit = 80) {
    const files = listJsonFiles(COVERAGE_ROOT, { recursive: true, maxFiles: Math.max(1, Math.min(1000, Number(limit || 80))) });
    const items = [];
    for (const file of files) {
        const data = readJsonFile(file, null);
        if (!data)
            continue;
        items.push({ ...data, file });
    }
    items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return items.slice(0, limit);
}
// 读取指定日期和频道的 final-input。
function readDailyFinalInput(date, channelKey) {
    return readJsonFile(getDailyFinalInputFile(date, channelKey), null);
}
// 统计 slot 文件数量，便于 Dashboard 快速判断预计算是否在产出。
function getPrecomputeSummary() {
    const coverage = listDailyCoverage(200);
    const indexCount = listJsonFiles(INDEX_ROOT, { recursive: true, maxFiles: 20000 }).length;
    const slotCount = listJsonFiles(SLOTS_ROOT, { recursive: true, maxFiles: 20000 }).length;
    return {
        coverage,
        coverageCount: coverage.length,
        indexCount,
        slotCount,
        events: readRecentJsonlEvents(PRECOMPUTE_ROOT, 'events-', 40),
    };
}
module.exports = {
    PRECOMPUTE_ROOT,
    INDEX_ROOT,
    COVERAGE_ROOT,
    SLOTS_ROOT,
    FINAL_INPUT_ROOT,
    getDailyFinalInputFile,
    listDailyCoverage,
    readDailyFinalInput,
    getPrecomputeSummary,
};
