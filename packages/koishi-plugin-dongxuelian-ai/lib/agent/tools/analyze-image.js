"use strict";
/**
 * Agent 工具: analyze_historical_image — 分析图片历史中的某张图片。
 * 优先读已有分析缓存；未命中时写入 S6 媒体背压队列。
 */
const { getImageEntry, getCachedAnalysis, storeImageUrl, markAnalysisPending } = require('../../media/image/image-store');
const { enqueueMediaTask, buildImageAnalysisPayload, hasImageAnalysisDemand } = require('../../media/backpressure/media-queue');
const { shouldEnqueueMediaForAdmission } = require('../../media/backpressure/media-requests');
const { admitTask } = require('../../resource-scheduler/admission');
const { readRandomImageAuthorization } = require('../../media/image/image-random-demand');
// 为 URL 直传图片生成稳定的媒体任务 messageId，供 S6 去重和展示。
function createAgentImageMessageId(messageId, url) {
    if (messageId)
        return messageId;
    let hash = 0;
    for (const char of String(url || ''))
        hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return `agent-url-${Math.abs(hash).toString(36) || Date.now().toString(36)}`;
}
module.exports = {
    definition: {
        name: 'analyze_historical_image',
        description: '按本轮问题读取选定历史图片。已有摘要足够时直接复用；摘要缺少小字、完整文字或其他所需细节时设置 force=true，按问题重新读取原图。目标不唯一时先澄清，不逐张识别试探。',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '仅直接提供新图片 URL 时使用；有 messageId 时以仍有效的原图片记录为准' },
                messageId: { type: 'string', description: '图片消息 ID（从 read_image_history 获取）' },
                question: { type: 'string', description: '用户关于这张图的问题，如"这是什么"、"图里写了什么"' },
                force: { type: 'boolean', description: '摘要无法回答本次细节时为 true，允许读取原图重新识别' },
            },
            required: [],
        },
    },
    // 保留原目标与当前问题，登记显式需求后交给受资源保护的媒体工作进程。
    async execute(params = {}, context = {}) {
        const channelKey = context.channelKey || '';
        const userId = context.userId || '';
        let url = String(params.url || '').trim();
        const messageId = String(params.messageId || '').trim();
        const question = String(params.question || '').trim();
        const force = params.force === true;
        const randomAuthorization = readRandomImageAuthorization(context.randomAuthorization);
        if (context.source === 'random-image' && !randomAuthorization)
            return '本轮随机图片话题已经过时，未安排新的识图。';
        if (force && !question)
            return '重新读取图片细节时需要提供本次问题。';
        let mediaMessageId = createAgentImageMessageId(messageId, url);
        let cachedFile = null;
        if (messageId) {
            const entry = await getImageEntry(channelKey, messageId);
            if (!entry)
                return '该图片记录已过期或无法定位，请重新发送。';
            url = entry.url;
            cachedFile = entry.file || null;
        }
        if (messageId && channelKey) {
            const cachedAnalysis = await getCachedAnalysis(channelKey, messageId);
            if (cachedAnalysis && !force)
                return `图片分析结果：${cachedAnalysis}`;
        }
        if (!url && !cachedFile)
            return '无法获取图片来源。请先用 read_image_history 查看可用图片。';
        mediaMessageId = createAgentImageMessageId(messageId, url);
        const admission = admitTask({
            kind: 'media_image_analysis',
            source: 'agent-tool',
            channelKey,
            userId,
            exclusive: false,
        });
        const shouldQueue = shouldEnqueueMediaForAdmission(admission);
        if (shouldQueue) {
            // 历史编号不能靠附带 URL 重新创建或延长有效期；仅 URL 直传登记新图片。
            if (channelKey && !messageId) {
                await storeImageUrl(channelKey, mediaMessageId, url, cachedFile, { conversationKey: channelKey, userId });
            }
            const targetEntry = await getImageEntry(channelKey, mediaMessageId);
            if (!targetEntry)
                return '该图片记录已过期或无法定位，请重新发送。';
            const queued = enqueueMediaTask({
                kind: 'media_image_analysis',
                channelKey,
                messageId: mediaMessageId,
                url: url || String(cachedFile || ''),
                expiresAt: new Date(Math.min(targetEntry.ts + 2 * 60 * 60 * 1000, context.source === 'random-image' && randomAuthorization ? randomAuthorization.expiresAt : Infinity)).toISOString(),
                payload: { ...buildImageAnalysisPayload({ source: context.source || 'history-tool', question, force, userId, randomAuthorization }), entry: context.entry || 'agent-tool-analyze-image', originalMessageId: messageId },
            });
            if ('reused' in queued && queued.reused) {
                const cachedResult = queued.cache && typeof queued.cache === 'object' ? queued.cache : null;
                if (typeof cachedResult?.result?.analysis === 'string' && cachedResult.result.analysis)
                    return `图片分析结果：${cachedResult.result.analysis}`;
            }
            await markAnalysisPending(channelKey, mediaMessageId, () => hasImageAnalysisDemand(channelKey, mediaMessageId));
        }
        const reason = admission.decision === 'run_now' ? 'media-worker 空闲时会处理' : admission.reason;
        if (!shouldQueue)
            return `当前资源状态为 ${admission.resourceState}，暂时不能加入图片分析队列，原因：${reason}。请稍后再试。`;
        const queuedPrefix = context.entry === 'chat-tool-analyze-historical-image' ? '该图片已进入' : '图片已加入';
        return `${queuedPrefix}媒体分析队列，当前资源状态为 ${admission.resourceState}，原因：${reason}。稍后可通过 read_image_history 查看摘要；细节问题请再次用同一 messageId、question 和 force 调用本工具获取结果。`;
    },
    dangerous: false,
    defaultChannels: ['dashboard', 'qq'],
};
