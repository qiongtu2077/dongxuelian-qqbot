/**
 * MODULE: 模型队列额度故障回复。
 * 职责: 将整队列失败且含额度不足的终态转换为用户指定图片。
 * 边界: 不调用模型、不发送消息，不覆盖单节点失败或成功的备用回复。
 * 状态: 无缓存；图片由正式发布包 assets 提供。
 */
const path = require('path') as typeof import('path')
const { pathToFileURL } = require('url') as typeof import('url')
const { h } = require('koishi') as typeof import('koishi')
const { ModelRequestError } = require('../core/request-diagnostics') as typeof import('../core/request-diagnostics')

// 使用短本地文件 URI，避免图片 base64 被普通文本分泡器截断。
function getModelQuotaReply(error: unknown): string | null {
  if (!(error instanceof ModelRequestError) || error.code !== 'MODEL_QUEUE_QUOTA_EXHAUSTED') return null
  return h.image(pathToFileURL(path.resolve(__dirname, '../../assets/model-quota-exhausted.png')).href).toString()
}

export = { getModelQuotaReply }
