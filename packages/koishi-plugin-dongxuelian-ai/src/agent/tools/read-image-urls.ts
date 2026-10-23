/**
 * Agent 工具: read_image_history — 查看群聊最近出现的图片记录。
 */
const { getRecentImages } = require('../../media/image/image-store') as typeof import('../../media/image/image-store')

interface ReadImageHistoryParams {
  limit?: unknown
}

interface ReadImageHistoryContext {
  channelKey?: string
}

export = {
  definition: {
    name: 'read_image_history',
    description: '查看群聊最近出现的图片记录（URL + 时间戳 + 是否已分析）。用于了解近期有哪些图片被分享，帮助判断当前话题是否涉及某张图。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最近几张图片，默认 5' },
      },
      required: [] as string[],
    },
  },
  // 返回有限的有效图片及本次识图状态，已有摘要与本次失败分别呈现。
  async execute(params: ReadImageHistoryParams = {}, context: ReadImageHistoryContext = {}): Promise<string> {
    const channelKey = context.channelKey || ''
    if (!channelKey) return '无法获取频道信息'
    const limit = Math.min(Math.max(parseInt(String(params.limit)) || 5, 1), 10)
    const images = await getRecentImages(channelKey, limit)
    if (!images.length) return '最近没有图片记录。'
    return images.map((img, i) => {
      const time = new Date(img.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      const state = ({ pending: '识图排队中', failed: '本次识图失败', cancelled: '本次识图已取消', completed: '本次识图已完成' } as Record<string, string>)[img.analysisStatus] || ''
      const status = [img.analyzed ? `已有摘要: ${img.analysis?.slice(0, 80) || '(无描述)'}` : '没有客观摘要', state].filter(Boolean).join('；')
      return `${i + 1}. [${time}] ${status}\n   URL: ${img.url}\n   ID: ${img.messageId}`
    }).join('\n')
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
