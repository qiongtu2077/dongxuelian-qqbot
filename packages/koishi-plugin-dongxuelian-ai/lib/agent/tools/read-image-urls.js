/**
 * Agent 工具: read_image_history — 查看群聊最近出现的图片记录。
 */
const { getRecentImages } = require('../../image-store')

module.exports = {
  definition: {
    name: 'read_image_history',
    description: '查看群聊最近出现的图片记录（URL + 时间戳 + 是否已分析）。用于了解近期有哪些图片被分享，帮助判断当前话题是否涉及某张图。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最近几张图片，默认 5' },
      },
      required: [],
    },
  },
  async execute(params = {}, context = {}) {
    const channelKey = context.channelKey || ''
    if (!channelKey) return '无法获取频道信息'
    const limit = Math.min(Math.max(parseInt(params.limit) || 5, 1), 10)
    const images = getRecentImages(channelKey, limit)
    if (!images.length) return '最近没有图片记录。'
    return images.map((img, i) => {
      const time = new Date(img.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      const status = img.analyzed ? `已分析: ${img.analysis?.slice(0, 80) || '(无描述)'}` : '未分析'
      return `${i + 1}. [${time}] ${status}\n   URL: ${img.url}\n   ID: ${img.messageId}`
    }).join('\n')
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
