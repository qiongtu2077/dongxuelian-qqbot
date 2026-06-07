"use strict";
/**
 * MODULE: S3 coverage 维护。
 * 职责: 读取和刷新日报预计算覆盖率。
 * 边界: 不规划任务，不生成摘要。
 */
const { readJsonFile } = require('../resource-common/files');
const { getPrecomputeCoverageFile, updatePrecomputeCoverage } = require('./precompute-index');
// 读取指定频道覆盖率；缺失时返回刷新后的空覆盖率。
function readDailyCoverage(date, channelKey) {
    return readJsonFile(getPrecomputeCoverageFile(date, channelKey), null) || updatePrecomputeCoverage(date, channelKey);
}
// 刷新指定频道 coverage。
function refreshDailyCoverage(date, channelKey) {
    return updatePrecomputeCoverage(date, channelKey);
}
module.exports = {
    readDailyCoverage,
    refreshDailyCoverage,
};
