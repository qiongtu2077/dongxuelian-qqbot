/**
 * MODULE: 近期上传文件产物操作兜底解析。
 * 职责: 当模型拒绝本来可由 create_uploaded_file_variant 完成的请求时，提取安全工具参数。
 * 边界: 不读写文件、不发送文件；真正操作由 create-uploaded-file-variant 工具完成。
 */

const ACTION_RE = /(?:重命名|改名|命名|另存为|另存|保存为|改成|改为|改叫|标题)/
const SEND_RE = /(?:发给我|传给我|发回来|发回|发送给我|给我|传回来)/
const REFUSAL_RE = /(?:帮不了|不能|做不到|没法|无法|不会|干不了|可帮不了|不支持)/

interface UploadedFileVariantRequest {
  name: string
  sendBack?: true
}

function stripActionNoise(text: string = ''): string {
  return String(text || '')
    .replace(/^帮我[，,、\s]*/, '')
    .replace(/[。.!！~～\s]+$/g, '')
    .trim()
}

function cleanTargetName(value: unknown = ''): string {
  return String(value || '')
    .replace(/^(?:为|成|叫|到)\s*/, '')
    .replace(/[“”"'「」]/g, '')
    .replace(/(?:然后|并且|并|再)?(?:发给我|传给我|发回来|发回|发送给我|给我|传回来).*$/g, '')
    .replace(/[，。,、.!！?？\s]+$/g, '')
    .trim()
}

function extractTargetName(text: string = ''): string {
  const value = stripActionNoise(text)
  const patterns = [
    /(?:重命名|改名|命名)(?:为|成|叫)?\s*([“”"'「」]?[^，。,、.!！?？\s]{1,80})/,
    /(?:另存为|保存为|另存)(?:为|成)?\s*([“”"'「」]?[^，。,、.!！?？\s]{1,80})/,
    /(?:改成|改为|改叫|标题(?:改成|改为)?)(?:为|成|叫)?\s*([“”"'「」]?[^，。,、.!！?？\s]{1,80})/,
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    const cleaned = cleanTargetName(match && match[1])
    if (cleaned) return cleaned.slice(0, 120)
  }
  return ''
}

function parseUploadedFileVariantRequest(text: string = ''): UploadedFileVariantRequest | null {
  const value = stripActionNoise(text)
  if (!value || !ACTION_RE.test(value)) return null
  const name = extractTargetName(value)
  if (!name) return null
  return {
    name,
    sendBack: SEND_RE.test(value) ? true : undefined,
  }
}

function isUploadedFileVariantCapabilityRefusal(reply: string = '', userText: string = ''): boolean {
  const text = String(reply || '')
  const user = String(userText || '')
  if (!text || !ACTION_RE.test(user)) return false
  return REFUSAL_RE.test(text) && /(?:文件|文档|附件|重命名|改名|另存|发送|发给你|发回)/.test(text + user)
}

function formatUploadedFileVariantFallback(result: string = ''): string {
  const text = String(result || '')
  if (/已发送文件/.test(text)) return '已经重命名并发回去了。'
  if (/没有可处理的近期文件|当前会话没有可处理|还没有可用本地副本|可能已过期/.test(text)) return '没找到最近可处理的文件，重新发一下我再改名发回去。'
  if (/缺少|无法确定发送目标/.test(text)) return '文件副本建好了，但我没法确定要发到哪里。'
  if (/未发送|不可用|失败/.test(text)) return '文件副本建好了，但发送失败了。'
  if (/已创建文件副本/.test(text)) return '已经创建好改名后的文件副本。'
  return text.slice(0, 200) || '文件处理完成。'
}

export = {
  parseUploadedFileVariantRequest,
  isUploadedFileVariantCapabilityRefusal,
  formatUploadedFileVariantFallback,
}
