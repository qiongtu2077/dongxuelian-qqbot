"use strict";
/**
 * MODULE: 文件追问取证守卫兼容入口。
 * 职责: 保留旧 deep require 路径；真实状态判断与取证桥接分别归属到 state/evidence 模块。
 * 边界: 新代码不应依赖本兼容壳作为主路径。
 */
const state = require('./file-followup-state');
const evidence = require('../../chat/file-followup-evidence');
const looksLikeFileFollowup = state.looksLikeFileFollowup;
const selectActiveFileAnchor = state.selectActiveFileAnchor;
const buildFileFollowupState = state.buildFileFollowupState;
const toolCallsIncludeAnalyzeFile = evidence.toolCallsIncludeAnalyzeFile;
const toolResultsIncludeFileEvidence = evidence.toolResultsIncludeFileEvidence;
const selectFileEvidenceResult = evidence.selectFileEvidenceResult;
const resolveUnguardedFileFollowup = evidence.resolveUnguardedFileFollowup;
const buildFileEvidenceReply = evidence.buildFileEvidenceReply;
module.exports = {
    looksLikeFileFollowup,
    toolCallsIncludeAnalyzeFile,
    toolResultsIncludeFileEvidence,
    selectFileEvidenceResult,
    selectActiveFileAnchor,
    buildFileFollowupState,
    resolveUnguardedFileFollowup,
    buildFileEvidenceReply,
};
