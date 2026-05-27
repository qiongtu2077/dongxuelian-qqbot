"use strict";
/**
 * MODULE: shared-record-text
 * 职责: 将入站消息解析结果转换为群共享上下文可保存的短文本。
 * 边界: 不写 conversation、不读取文件、不发送消息；只做纯文本归一。
 * 状态: 无状态。
 */
const { normalizeText, stripMentions } = require('../core/utils');
function resolveSharedRecordText(plain, analyzed = {}) {
    const text = normalizeText(stripMentions(plain || analyzed.memory || analyzed.plain || ''));
    if (text)
        return text;
    if (analyzed.hasAudio)
        return '[语音]';
    if (analyzed.hasFile)
        return '[文件]';
    if (analyzed.hasMessageRecordCue)
        return normalizeText(analyzed.plain || '');
    return '';
}
module.exports = {
    resolveSharedRecordText,
};
