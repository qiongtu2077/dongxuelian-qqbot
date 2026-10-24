/**
 * MODULE: GitHub 群主题配置。
 * 职责: 每群持久化看板卡片明暗主题，处理查看与设置命令。
 * 边界: 不开启查询白名单、不渲染图片、不调用模型；实例拥有主题快照与串行写入链。
 */
import fs = require('fs')
import path = require('path')
import type { GithubPullTheme } from './models'
import { normalizeGithubGroup } from './settings'
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { writeJsonFile } = require('../core/utils') as typeof import('../core/utils')

// Accept the two dashboard skins only, with common Chinese and English spellings.
export function normalizeGithubTheme(value: string): GithubPullTheme | null {
  if (/^(暗|暗色|暗黑|dark)$/i.test(value)) return 'dark'
  if (/^(明|亮|明亮|亮色|浅色|light)$/i.test(value)) return 'light'
  return null
}

// --- 独立主题配置 --- //
export class GithubPreviewThemes {
  private themes = new Map<string, GithubPullTheme>()
  private updates: Promise<unknown> = Promise.resolve()
  readonly file: string

  // Reject an entire malformed snapshot rather than partially trusting group themes.
  constructor(directory = DATA_DIR, private readonly save = writeJsonFile, private readonly warn: (message: string) => void = console.warn) {
    this.file = path.join(directory, 'github-preview-themes.json')
    try {
      if (fs.statSync(this.file).size > 262144) throw new Error('主题文件超过大小限制')
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('主题必须是群号与明暗值的对象')
      const entries = Object.entries(raw as Record<string, unknown>)
      if (entries.length > 2000) throw new Error('主题已达到容量限制')
      for (const [group, theme] of entries) {
        if (!normalizeGithubGroup(group) || theme !== 'dark' && theme !== 'light') throw new Error('群号或主题格式不正确')
        this.themes.set(group, theme)
      }
    } catch (error) {
      this.themes.clear()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn('GitHub 群主题读取失败，保持默认暗色：' + (error as Error).message)
    }
  }

  // Dark is the default skin; unknown groups never inherit another group's choice.
  theme(group: string): GithubPullTheme { return this.themes.get(group) || 'dark' }

  // Serialize mutations and publish memory only after a successful atomic write.
  async update(group: string, theme: GithubPullTheme): Promise<boolean> {
    if (!normalizeGithubGroup(group)) throw new Error('群号格式不正确')
    const operation = this.updates.catch(() => {}).then(async () => {
      if (this.themes.get(group) === theme) return false
      const next = new Map(this.themes)
      next.set(group, theme)
      const sorted: Record<string, GithubPullTheme> = {}
      for (const key of [...next.keys()].sort()) sorted[key] = next.get(key)!
      if (Buffer.byteLength(JSON.stringify(sorted)) > 262144) throw new Error('主题已达到容量限制')
      await this.save(this.file, sorted)
      this.themes = next
      return true
    })
    this.updates = operation
    return operation
  }
}

// Handle view/set grammar only; every other outcome is a usage hint.
export async function handleGithubThemeCommand(group: string | undefined, isDirect: boolean | undefined, plain: string, themes: GithubPreviewThemes): Promise<string> {
  const usage = '用法：GitHub群主题 明亮|暗色（默认暗色） / GitHub群主题查看'
  if (!group || isDirect) return '请在群中设置 GitHub PR 卡片主题。'
  if (/^GitHub群主题(?:查看)?$/i.test(plain)) return `本群 GitHub PR 卡片主题：${themes.theme(group) === 'light' ? '明亮' : '暗色'}`
  const match = plain.match(/^GitHub群主题\s+(\S{1,10})$/i)
  const theme = match ? normalizeGithubTheme(match[1]) : null
  if (!match || !theme) return usage
  try {
    const changed = await themes.update(group, theme)
    return changed ? `已设置本群 GitHub PR 卡片主题：${theme === 'light' ? '明亮' : '暗色'}` : `本群 GitHub PR 卡片主题已经是${theme === 'light' ? '明亮' : '暗色'}。`
  } catch { return 'GitHub 群主题保存失败，设置未更改。' }
}
