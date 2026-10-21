/**
 * MODULE: GitHub 当前消息链接解析。
 * 职责: 识别四类固定公开路径并规范化身份。
 * 边界: 不请求网络、不读取历史、不调用模型；无可变缓存。
 */
import type { GithubTarget } from './models'
const RESERVED_GITHUB_ROOTS = new Set(['about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'topics', 'trending', 'users'])

// Accept only known public root/issue/pull routes on the exact HTTPS origin.
export function parseGithubTarget(raw: string): GithubTarget | null {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1)
  if (!parts[0] || RESERVED_GITHUB_ROOTS.has(parts[0].toLowerCase()) || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[0])) return null
  const owner = parts[0]
  let target: GithubTarget
  if (parts.length === 1) target = { kind: 'user', owner, url: '', key: '' }
  else {
    const repo = parts[1]
    if (!/^[a-z\d_.-]{1,100}$/i.test(repo) || repo === '.' || repo === '..') return null
    if (parts.length === 2) target = { kind: 'repository', owner, repo, url: '', key: '' }
    else if (parts.length === 4 && ['issues', 'pull'].includes(parts[2]) && /^[1-9]\d*$/.test(parts[3]) && Number.isSafeInteger(Number(parts[3]))) {
      target = { kind: parts[2] === 'issues' ? 'issue' : 'pull', owner, repo, number: Number(parts[3]), url: '', key: '' }
    } else return null
  }
  target.url = `https://github.com/${owner}${target.repo ? '/' + target.repo : ''}${target.number ? '/' + (target.kind === 'issue' ? 'issues' : 'pull') + '/' + target.number : ''}`
  target.key = [target.kind, owner.toLowerCase(), target.repo?.toLowerCase(), target.number].filter(value => value !== undefined).join(':')
  return target
}

// Read current-message text only, with punctuation trimming and identity deduplication.
export function extractGithubTargets(text: string): GithubTarget[] {
  const targets = new Map<string, GithubTarget>()
  for (const match of text.matchAll(/https:\/\/github\.com\/[^\s<>"'，。！？；、【】]+/gi)) {
    const target = parseGithubTarget(match[0].replace(/[)\]}>.,!?:;，。！？；]+$/, ''))
    if (target) targets.set(target.key, target)
    if (targets.size === 4) break
  }
  return [...targets.values()]
}

// Reserve the complete command family for deterministic management routing.
export function isGithubPreviewCommand(text: string): boolean { return /^GitHub查询(?:群|状态)/i.test(text) }
