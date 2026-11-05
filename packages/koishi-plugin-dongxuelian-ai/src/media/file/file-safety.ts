/**
 * MODULE: 文件安全检查。
 * 职责: 白名单/黑名单/大小限制/文件名清洗/内容防注入包裹。
 * 边界: 纯函数，不做 IO、不发消息。
 */

const MAX_FILE_SIZE = 10 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'yml', 'yaml', 'xml', 'toml', 'ini', 'conf', 'log',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'html', 'css',
  'srt', 'ass', 'sh', 'bat', 'sql', 'env', 'properties',
])

const BINARY_DOC_EXTENSIONS = new Set([
  'pdf', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
])

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bin', 'so', 'dylib', 'msi', 'apk', 'deb', 'rpm',
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'key', 'pem', 'crt', 'pfx', 'p12', 'jks', 'keystore',
  'iso', 'img', 'vmdk', 'vhd',
])

interface FileCheckResult {
  allowed: boolean
  reason?: string
  category?: string
  ext: string
}

// --- 文件类型与大小 --- //

// 规范化文件名后缀；URL 只读取路径部分，忽略查询和片段。
function getExtension(fileName: unknown): string {
  if (/^https?:\/\//i.test(String(fileName || ''))) {
    try { fileName = new URL(String(fileName)).pathname } catch { return '' }
  }
  const name = String(fileName || '').trim()
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

function sanitizeFileName(fileName: unknown): string {
  let name = String(fileName || '').trim()
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  name = name.replace(/\.{2,}/g, '.')
  if (name.length > 200) name = name.slice(0, 200)
  return name || 'unnamed'
}

// 附件存在图片后缀、声明类型或下载路径线索时才列为候选，内容仍由读取层验证。
function isImageFileCandidate(fileName: unknown, mime: unknown = '', url: unknown = ''): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(fileName)) || /^image\/(?:jpeg|jpg|png|webp|gif|bmp)(?:;|$)/i.test(String(mime || ''))
    || IMAGE_EXTENSIONS.has(getExtension(url))
}

// 按单附件十兆与类型分类；图片进入视觉链，不能进入文本文档提取。
function checkFile(fileName: unknown, fileSize: unknown, mime: unknown = '', url: unknown = ''): FileCheckResult {
  const ext = getExtension(fileName)
  const size = Number(fileSize) || 0

  if (size > MAX_FILE_SIZE) {
    return { allowed: false, reason: 'too_large', ext }
  }

  if (ext === 'doc' || ext === 'epub') {
    return { allowed: false, reason: 'unsupported_type', ext }
  }

  if (!BLOCKED_EXTENSIONS.has(ext) && isImageFileCandidate(fileName, mime, url)) return { allowed: true, category: 'image', ext }

  if (TEXT_EXTENSIONS.has(ext)) {
    return { allowed: true, category: 'text', ext }
  }

  if (BINARY_DOC_EXTENSIONS.has(ext)) {
    return { allowed: true, category: 'binary_doc', ext }
  }

  return { allowed: false, reason: 'unknown_type', ext }
}

// --- 内容包裹与摘要 --- //

function wrapFileContent(fileName: unknown, content: unknown, maxChars: number = 3000): string {
  const truncated = String(content || '').slice(0, maxChars)
  const lines = truncated.split('\n')
  const lineCount = String(content || '').split('\n').length
  const shown = lines.length
  const suffix = shown < lineCount ? `\n... (共${lineCount}行，已截取前${shown}行)` : ''
  return `[用户上传文件: ${sanitizeFileName(fileName)}]\n---文件内容开始---\n${truncated}${suffix}\n---文件内容结束---`
}

function unwrapFileContent(text: string = ''): { fileName: string; content: string } {
  const value = String(text || '').trim()
  const match = value.match(/^\[用户上传文件:\s*([^\]]+)\]\s*\n---文件内容开始---\n([\s\S]*?)\n---文件内容结束---\s*$/)
  if (!match) return { fileName: '', content: value }
  return {
    fileName: sanitizeFileName(match[1]),
    content: String(match[2] || '').trim(),
  }
}

function summarizeFileContentForChat(text: string = '', fallbackName: string = ''): string {
  const parsed = unwrapFileContent(text)
  const fileName = sanitizeFileName(parsed.fileName || fallbackName || '文件')
  const content = String(parsed.content || '').trim()
  if (!content) return `${fileName} 读到了，但没有提取出可用正文。`
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const picked = lines.slice(0, 8)
  const body = picked.join('\n').slice(0, 1200)
  const more = lines.length > picked.length ? `\n... 后面还有 ${lines.length - picked.length} 行。` : ''
  return `${fileName} 的内容大致是：\n${body}${more}`
}

export = {
  MAX_FILE_SIZE,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  BINARY_DOC_EXTENSIONS,
  BLOCKED_EXTENSIONS,
  getExtension,
  sanitizeFileName,
  checkFile,
  isImageFileCandidate,
  wrapFileContent,
  unwrapFileContent,
  summarizeFileContentForChat,
}
