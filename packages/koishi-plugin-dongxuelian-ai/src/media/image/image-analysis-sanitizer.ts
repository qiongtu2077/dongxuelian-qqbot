/**
 * MODULE: 图片事实摘要净化。
 * 职责: 把视觉模型输出约束成客观、短、可入库的图片事实描述。
 * 边界: 不调用模型、不读写文件、不发送消息。
 */

const PERSONA_IMAGE_REPLY_RE: RegExp = /(?:呀吼|指挥官|布吕歇尔|莲莲|东雪莲|觉得怎么样|要不要|一起讨论|快看|超(?:有趣|可爱|漂亮|帅)|嘻嘻|嘛[～~]?|哦[～~]?)/i
const THINKING_FRAGMENT_RE: RegExp = /<\/?think>|根据系统|我需要|我应该|当前场景|用户(?:是在|问|发来)|作为\S*?(?:人设|角色)/i
const BLINDNESS_FACT_RE: RegExp = /(?:看不(?:到|清|见)|没法看|无法(?:查看|识别|判断)|没有图|图片读取失败|换个图|请重发|重新发)/i
const INTERACTIVE_TAIL_RE: RegExp = /(?:指挥官)?(?:你)?(?:觉得|怎么看|要不要|想不想|是不是也).{0,40}[？?。!！]*$/i

function normalizeImageAnalysisText(text: string = ''): string {
  return String(text || '')
    .replace(/<\/?think>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikePersonaImageReply(text: string = ''): boolean {
  const value = normalizeImageAnalysisText(text)
  if (!value) return false
  if (THINKING_FRAGMENT_RE.test(value)) return true
  if (PERSONA_IMAGE_REPLY_RE.test(value)) return true
  if (/^(?:这张图|图里|画面).{0,80}(?:挺|很|超).{0,20}(?:有趣|可爱|漂亮|帅|酷)[呀哦嘛～~！!。]?$/.test(value)) return true
  return false
}

function sanitizeImageAnalysis(text: string = ''): string {
  let value = normalizeImageAnalysisText(text)
  if (!value) return ''
  if (BLINDNESS_FACT_RE.test(value)) return ''
  if (looksLikePersonaImageReply(value)) return ''
  value = value
    .replace(/^图片(?:内容|分析结果)?[：:]\s*/i, '')
    .replace(/^图(?:中|里|片)(?:可以看到|显示|是)?[：:]\s*/i, '图中')
    .replace(INTERACTIVE_TAIL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value || BLINDNESS_FACT_RE.test(value) || looksLikePersonaImageReply(value)) return ''
  return value.slice(0, 120)
}

export = {
  sanitizeImageAnalysis,
  looksLikePersonaImageReply,
}
