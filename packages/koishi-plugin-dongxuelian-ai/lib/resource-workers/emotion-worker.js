"use strict";
/**
 * MODULE: S2 emotion-render worker executor.
 * Responsibility: render prepared emotion analysis into an image result file.
 * Boundary: no QQ sending; result delivery is handled by result-notifier.
 */
const fs = require('fs');
const path = require('path');
const { getTaskResultDir } = require('./task-paths');
const { renderEmotionImageDirect } = require('../behavior/emotion-renderer');
function isEmotionPayloadLike(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function toEmotionHistory(value) {
    return (Array.isArray(value) ? value : []);
}
function toImageBuffer(image) {
    if (Buffer.isBuffer(image))
        return image;
    if (typeof image === 'string')
        return Buffer.from(image);
    if (image instanceof ArrayBuffer)
        return Buffer.from(image);
    if (ArrayBuffer.isView(image))
        return Buffer.from(image.buffer, image.byteOffset, image.byteLength);
    throw new Error('emotion render output is not binary');
}
// Return a plain object payload; malformed payloads are rejected by the worker.
function getEmotionPayload(task) {
    return isEmotionPayloadLike(task.payload) ? task.payload : {};
}
// Render one prepared emotion image and write the binary artifact into the task result directory.
async function runEmotionRenderWorkerTask(task) {
    const payload = getEmotionPayload(task);
    const analysisInput = payload.analysis;
    const statsInput = payload.stats;
    const history = toEmotionHistory(payload.history);
    if (!analysisInput || typeof analysisInput !== 'object')
        throw new Error('emotion_render payload.analysis is required');
    if (!statsInput || typeof statsInput !== 'object')
        throw new Error('emotion_render payload.stats is required');
    const analysis = analysisInput;
    const stats = statsInput;
    const outputDir = getTaskResultDir(String(task?.id || ''));
    fs.mkdirSync(outputDir, { recursive: true });
    const image = await renderEmotionImageDirect(analysis, stats, history);
    const imageBuffer = toImageBuffer(image);
    const imagePath = path.join(outputDir, 'emotion.png');
    fs.writeFileSync(imagePath, imageBuffer);
    return {
        mode: 'emotion_image',
        reason: 'emotion image rendered',
        imagePath,
        text: String(payload.text || ''),
    };
}
module.exports = {
    runEmotionRenderWorkerTask,
};
