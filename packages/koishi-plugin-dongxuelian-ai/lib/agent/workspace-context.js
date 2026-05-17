/**
 * MODULE: Agent 工作区语义上下文。
 * 职责: 将用户的模糊说法映射为本仓库常见目录候选，并为 Dashboard Agent 注入工作区提示。
 * 边界: 不读取文件内容、不执行工具、不修改配置。
 * 状态: 无。
 */
const fs = require('fs')
const path = require('path')

const WORKSPACE_ALIASES = [
  {
    name: 'Dashboard 后台',
    terms: ['dashboard', '后台', '管理后台', '控制台', 'bot后台', '机器人后台'],
    paths: [
      'packages/koishi-plugin-dashboard',
      'packages/koishi-plugin-dashboard/frontend',
      'packages/koishi-plugin-dashboard/frontend/src',
      'packages/koishi-plugin-dashboard/standalone.js',
    ],
  },
  {
    name: '前端 Agent Console',
    terms: ['bot前端', '机器人前端', '前端agent', 'agent前端', 'agentconsole', 'agent控制台', '前端控制台'],
    paths: [
      'packages/agent-console',
      'packages/agent-console/src',
      'packages/agent-console/src/main.tsx',
      'packages/agent-console/src/api/client.ts',
      'packages/agent-console/src/styles.css',
      'packages/koishi-plugin-dashboard/frontend/src/components/AgentPanel.vue',
    ],
  },
  {
    name: 'AI Agent 后端',
    terms: ['agent后端', '工具权限', '工具审批', '读文件', '写文件', 'shell', '技能索引', 'skill索引'],
    paths: [
      'packages/koishi-plugin-dongxuelian-ai/lib/agent',
      'packages/koishi-plugin-dongxuelian-ai/lib/agent/engine.js',
      'packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js',
      'packages/koishi-plugin-dongxuelian-ai/lib/agent/path-guard.js',
      'packages/koishi-plugin-dongxuelian-ai/lib/agent/skills.js',
      'packages/koishi-plugin-dongxuelian-ai/lib/agent/tools',
    ],
  },
  {
    name: '技能与人格文件',
    terms: ['skill', '技能', '人格', 'persona', 'lore', '提示词'],
    paths: [
      'packages/koishi-plugin-dongxuelian-ai/data/ai-skills',
      'packages/koishi-plugin-dongxuelian-ai/data/ai-skills/docs',
      'packages/koishi-plugin-dongxuelian-ai/data/ai-skills/personas',
      'packages/koishi-plugin-dongxuelian-ai/data/ai-skills/core',
    ],
  },
  {
    name: '测试与规约',
    terms: ['测试', 'scenario', 'cascade', '协作规则', '教训', '测试文件维护'],
    paths: [
      'AI协作规则.md',
      '测试文件维护指南.md',
      '教训总结.md',
      'packages/koishi-plugin-dongxuelian-ai/test/cascade-test.js',
      'packages/koishi-plugin-dongxuelian-ai/test/scenarios',
    ],
  },
]

const PATH_NOISE_SUFFIXES = ['文件夹', '目录', '文件', '里面', '内容']

function normalizeIntentText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_\-:：/\\]+/g, '')
    .trim()
}

function normalizeRequestedPath(value = '') {
  let text = String(value || '').trim().replace(/^['"`]|['"`]$/g, '')
  for (const suffix of PATH_NOISE_SUFFIXES) {
    if (text.endsWith(suffix)) text = text.slice(0, -suffix.length).trim()
  }
  return text
}

function pushUniqueCandidate(out, item) {
  const resolved = path.resolve(String(item.path || ''))
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (out.some(candidate => candidate.key === key)) return
  out.push({ ...item, path: resolved, key })
}

function pathExists(candidate) {
  try { return fs.existsSync(candidate) } catch { return false }
}

function pathHasExistingParent(candidate) {
  let current = path.dirname(path.resolve(candidate))
  while (current && current !== path.dirname(current)) {
    if (pathExists(current)) return true
    current = path.dirname(current)
  }
  return pathExists(current)
}

function joinExistingRoot(root, relativePath) {
  return path.resolve(root, relativePath.replace(/[\\/]+/g, path.sep))
}

function getAliasMatches(text = '') {
  const normalized = normalizeIntentText(text)
  if (!normalized) return []
  return WORKSPACE_ALIASES.filter(alias => alias.terms.some(term => normalized.includes(normalizeIntentText(term))))
}

function getAliasPathCandidates(value = '', roots = []) {
  const requested = normalizeRequestedPath(value).replace(/\\/g, '/').replace(/^\.\/+/, '')
  const requestedKey = normalizeIntentText(requested)
  const result = []
  if (!requestedKey) return result

  for (const alias of WORKSPACE_ALIASES) {
    for (const term of alias.terms) {
      const termKey = normalizeIntentText(term)
      if (!termKey) continue
      const exact = requestedKey === termKey
      const slashPrefix = requested.toLowerCase().startsWith(String(term).toLowerCase() + '/')
      if (!exact && !slashPrefix) continue
      const suffix = slashPrefix ? requested.slice(String(term).length + 1) : ''
      for (const root of roots) {
        for (const aliasPath of alias.paths) {
          pushUniqueCandidate(result, {
            path: joinExistingRoot(root, suffix ? path.join(aliasPath, suffix) : aliasPath),
            reason: alias.name,
            alias: term,
          })
        }
      }
    }
  }
  return result
}

function resolveAgentPathInput(value = '', roots = [], options = {}) {
  const requested = normalizeRequestedPath(value)
  const requireExisting = options.requireExisting !== false
  const candidates = []
  if (requested && path.isAbsolute(requested)) {
    pushUniqueCandidate(candidates, { path: requested, reason: 'absolute' })
  } else {
    for (const item of getAliasPathCandidates(requested, roots)) pushUniqueCandidate(candidates, item)
    if (requested) {
      for (const root of roots) {
        pushUniqueCandidate(candidates, { path: joinExistingRoot(root, requested), reason: 'relative-root' })
      }
      pushUniqueCandidate(candidates, { path: path.resolve(requested), reason: 'relative-cwd' })
    }
  }

  const matched = candidates.find(item => requireExisting ? pathExists(item.path) : pathHasExistingParent(item.path))
  return matched || candidates[0] || { path: path.resolve(requested || '.'), reason: 'fallback' }
}

function getWorkspaceSemanticCandidates(text = '', roots = []) {
  const matches = getAliasMatches(text)
  const result = []
  for (const alias of matches) {
    for (const root of roots) {
      for (const aliasPath of alias.paths) {
        const candidate = joinExistingRoot(root, aliasPath)
        if (pathExists(candidate)) pushUniqueCandidate(result, { path: candidate, reason: alias.name })
      }
    }
  }
  return result.map(({ key, ...item }) => item)
}

function formatWorkspaceContext(candidates = [], roots = []) {
  const lines = [
    '【控制台工作区-内部参考】',
    '当前是控制台渠道：可在允许根目录内读取和修改文件；危险工具（写入/删除/Shell/浏览器）需遵守安全策略。',
    '处理本地文件请求时，先用 list_files/find_files/grep_search/read_file 定位和核对内容，再下结论；不要只按用户原词做字面搜索。',
    '常见语义映射：dashboard/后台 -> packages/koishi-plugin-dashboard；前端 -> packages/agent-console 与 Dashboard 的 AgentPanel.vue；工具权限/skill索引 -> packages/koishi-plugin-dongxuelian-ai/lib/agent。',
  ]
  if (roots.length) {
    lines.push('允许根目录：')
    for (const root of roots.slice(0, 8)) lines.push(`- ${root}`)
  }
  if (candidates.length) {
    lines.push('本轮语义候选路径：')
    for (const item of candidates.slice(0, 12)) lines.push(`- ${item.reason}: ${item.path}`)
  }
  return lines.join('\n')
}

async function buildAgentWorkspaceContext({ userMessage = '', channel = 'qq', roots = [] } = {}) {
  if (channel !== 'dashboard') return []
  const candidates = getWorkspaceSemanticCandidates(userMessage, roots)
  return [{ role: 'system', content: formatWorkspaceContext(candidates, roots) }]
}

module.exports = {
  WORKSPACE_ALIASES,
  normalizeIntentText,
  normalizeRequestedPath,
  resolveAgentPathInput,
  getWorkspaceSemanticCandidates,
  formatWorkspaceContext,
  buildAgentWorkspaceContext,
}
