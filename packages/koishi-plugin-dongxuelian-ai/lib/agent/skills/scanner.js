/**
 * MODULE: Skill 安全扫描器。
 * 职责: 扫描 Skill 目录内容，检测 prompt injection/命令注入/数据外泄等威胁。
 * 边界: 不执行 Skill 内容、不修改扫描目标文件、只返回扫描报告；白名单仅经 add/remove 写入 DATA_DIR。
 * 状态: 无。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const { DATA_DIR } = require('../../constants')
const SKILL_SCANNER_WHITELIST_FILE = path.join(DATA_DIR, 'skill-scanner-whitelist.json')

const MAX_SKILL_FILE_SIZE = 500 * 1024
const MAX_SKILL_FILES = 20
const MAX_TOTAL_SIZE = 1024 * 1024

const SCAN_RULES = [
  {
    id: 'PI-001',
    category: 'prompt_injection',
    severity: 'CRITICAL',
    pattern: /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|rules|prompts)/i,
    description: 'Attempts to override system instructions',
  },
  {
    id: 'PI-002',
    category: 'prompt_injection',
    severity: 'CRITICAL',
    pattern: /you\s+are\s+now\s+(?:a|an)\s+/i,
    description: 'Attempts to reassign agent identity',
  },
  {
    id: 'PI-003',
    category: 'prompt_injection',
    severity: 'CRITICAL',
    pattern: /(?:new\s+instructions|override\s+(?:system|previous)|system\s*prompt\s*(?:is|:))/i,
    description: 'Attempts to inject new system instructions',
  },
  {
    id: 'CI-001',
    category: 'command_injection',
    severity: 'CRITICAL',
    pattern: /(?:rm\s+-rf|sudo\s+|chmod\s+777|curl[^|]*\|\s*(?:bash|sh)|wget[^|]*\|\s*(?:bash|sh))/i,
    description: 'Dangerous shell commands',
  },
  {
    id: 'CI-002',
    category: 'command_injection',
    severity: 'CRITICAL',
    pattern: /(?:eval\s*\(|exec\s*\(|child_process|spawn\s*\(|execSync)/i,
    description: 'Code execution primitives',
  },
  {
    id: 'DE-001',
    category: 'data_exfiltration',
    severity: 'HIGH',
    pattern: /(?:fetch|axios|http\.request|XMLHttpRequest|require\s*\(\s*['"]https?['"])\s*\(/i,
    description: 'Network request code in skill',
  },
  {
    id: 'DE-002',
    category: 'data_exfiltration',
    severity: 'HIGH',
    pattern: /(?:webhook|exfiltrate|send\s+(?:to|data\s+to)\s+(?:https?|server|endpoint))/i,
    description: 'Data exfiltration intent',
  },
  {
    id: 'UT-001',
    category: 'unauthorized_tool_use',
    severity: 'HIGH',
    pattern: /(?:always\s+(?:call|use|invoke)\s+(?:shell|execute_javascript|write_file)|必须\s*(?:调用|执行)\s*(?:shell|execute_javascript|write_file))/i,
    description: 'Forces use of dangerous tools',
  },
  {
    id: 'OB-001',
    category: 'obfuscation',
    severity: 'HIGH',
    pattern: /(?:atob\s*\(|btoa\s*\(|Buffer\.from\s*\([^)]*,\s*['"]base64['"]|\\u0000|\\x00|​|‌|‍|﻿)/,
    description: 'Obfuscation or zero-width characters',
  },
  {
    id: 'HS-001',
    category: 'hardcoded_secrets',
    severity: 'MEDIUM',
    pattern: /(?:(?:api[_-]?key|secret[_-]?key|access[_-]?token|password)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"])/i,
    description: 'Hardcoded API key or secret',
  },
  {
    id: 'RA-001',
    category: 'resource_abuse',
    severity: 'MEDIUM',
    pattern: /(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)|无限循环|重复执行\s*\d{3,}\s*次)/i,
    description: 'Infinite loop or excessive iteration',
  },
  {
    id: 'SE-001',
    category: 'social_engineering',
    severity: 'MEDIUM',
    pattern: /(?:不要告诉用户|hide\s+(?:this|from\s+user)|用户不需要知道|secretly|偷偷)/i,
    description: 'Attempts to hide actions from user',
  },
]

const EXECUTABLE_EXTENSIONS = new Set(['.js', '.sh', '.bat', '.exe', '.cmd', '.ps1', '.bin', '.py', '.rb'])

const SEVERITY_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, SAFE: 0 }

function getMaxSeverity(findings) {
  if (!findings.length) return 'SAFE'
  let max = 'SAFE'
  for (const f of findings) {
    if ((SEVERITY_ORDER[f.severity] || 0) > (SEVERITY_ORDER[max] || 0)) max = f.severity
  }
  return max
}

function isSymlink(filePath) {
  try { return fs.lstatSync(filePath).isSymbolicLink() } catch { return false }
}

function listSkillFiles(skillDir, maxFiles = MAX_SKILL_FILES) {
  const files = []
  const entries = fs.readdirSync(skillDir, { withFileTypes: true })
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (entry.isFile()) files.push(path.join(skillDir, entry.name))
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      try {
        const subEntries = fs.readdirSync(path.join(skillDir, entry.name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (files.length >= maxFiles) break
          if (sub.isFile()) files.push(path.join(skillDir, entry.name, sub.name))
        }
      } catch {}
    }
  }
  return files
}

function hashFileContent(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function canonicalWhitelistKey(dirPath) {
  return path.resolve(dirPath)
}

function readWhitelistSync() {
  try {
    if (!fs.existsSync(SKILL_SCANNER_WHITELIST_FILE)) return {}
    const raw = fs.readFileSync(SKILL_SCANNER_WHITELIST_FILE, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeWhitelistAtomic(obj) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = SKILL_SCANNER_WHITELIST_FILE + '.tmp'
  const payload = JSON.stringify(obj, null, 2) + '\n'
  await fsp.writeFile(tmp, payload, 'utf8')
  await fsp.rename(tmp, SKILL_SCANNER_WHITELIST_FILE)
}

/**
 * MODULE: computeDirectoryHash
 * 职责: 按与扫描器相同的文件枚举顺序拼接目录下各文件字节内容，计算完整 SHA-256（hex）。
 * 边界: 仅统计 listSkillFiles 命中的文件；不跟随目录软链本身（与子目录/文件布局与扫描阶段一致）。
 */
function computeDirectoryHash(dirPath) {
  const resolved = path.resolve(dirPath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`computeDirectoryHash: not a directory: ${dirPath}`)
  }
  const files = listSkillFiles(resolved)
  const parts = []
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(file))
    } catch {
      // 与扫描阶段可读文件集合对齐：不可读则跳过该文件字节
    }
  }
  const buf = Buffer.concat(parts)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function isWhitelistedAndUnchanged(skillDir) {
  const key = canonicalWhitelistKey(skillDir)
  const whitelist = readWhitelistSync()
  const entry = whitelist[key]
  if (!entry || typeof entry !== 'object' || typeof entry.sha256 !== 'string') return false
  let current
  try {
    current = computeDirectoryHash(skillDir)
  } catch {
    return false
  }
  return current === entry.sha256
}

/**
 * MODULE: addToWhitelist
 * 职责: 将解析后的目录路径写入白名单并记录当前目录内容哈希与元数据；原子落盘。
 * 边界: 不校验 reason 内容；目录须存在且可哈希。
 */
async function addToWhitelist(dirPath, reason) {
  const key = canonicalWhitelistKey(dirPath)
  const sha256 = computeDirectoryHash(dirPath)
  const data = readWhitelistSync()
  data[key] = {
    sha256,
    addedAt: new Date().toISOString(),
    reason: String(reason == null ? '' : reason),
  }
  await writeWhitelistAtomic(data)
}

/**
 * MODULE: removeFromWhitelist
 * 职责: 从白名单中移除指定目录键并原子写回；无此项则为空操作。
 * 边界: 按 canonicalWhitelistKey 匹配，与 addToWhitelist 一致。
 */
async function removeFromWhitelist(dirPath) {
  const key = canonicalWhitelistKey(dirPath)
  const data = readWhitelistSync()
  if (!Object.prototype.hasOwnProperty.call(data, key)) return
  delete data[key]
  await writeWhitelistAtomic(data)
}

function scanSkillDirectory(skillDir) {
  const findings = []

  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return { safe: false, findings: [{ severity: 'CRITICAL', category: 'meta', description: 'Skill directory does not exist' }], maxSeverity: 'CRITICAL', scannedAt: new Date().toISOString() }
  }

  if (isWhitelistedAndUnchanged(skillDir)) {
    return {
      safe: true,
      findings: [],
      whitelisted: true,
      maxSeverity: 'SAFE',
      scannedAt: new Date().toISOString(),
    }
  }

  let files
  try { files = listSkillFiles(skillDir) } catch {
    return { safe: false, findings: [{ severity: 'HIGH', category: 'meta', description: 'Cannot read skill directory' }], maxSeverity: 'HIGH', scannedAt: new Date().toISOString() }
  }

  if (files.length > MAX_SKILL_FILES) {
    findings.push({ file: '', severity: 'HIGH', category: 'resource_abuse', rule: 'META-001', description: `Too many files (${files.length} > ${MAX_SKILL_FILES})` })
  }

  let totalSize = 0
  for (const file of files) {
    const relPath = path.relative(skillDir, file)

    if (isSymlink(file)) {
      findings.push({ file: relPath, severity: 'CRITICAL', category: 'meta', rule: 'META-SYM', description: 'Symbolic link detected' })
      continue
    }

    const ext = path.extname(file).toLowerCase()
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      findings.push({ file: relPath, severity: 'CRITICAL', category: 'command_injection', rule: 'CI-EXE', description: `Executable file type: ${ext}` })
      continue
    }

    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (stat.size > MAX_SKILL_FILE_SIZE) {
      findings.push({ file: relPath, severity: 'HIGH', category: 'resource_abuse', rule: 'META-SIZE', description: `File too large: ${stat.size} bytes` })
      continue
    }
    totalSize += stat.size
    if (totalSize > MAX_TOTAL_SIZE) {
      findings.push({ file: relPath, severity: 'HIGH', category: 'resource_abuse', rule: 'META-TOTAL', description: `Total size exceeds ${MAX_TOTAL_SIZE} bytes` })
      break
    }

    let content
    try { content = fs.readFileSync(file, 'utf8') } catch { continue }

    for (const rule of SCAN_RULES) {
      if (rule.pattern.test(content)) {
        findings.push({
          file: relPath,
          rule: rule.id,
          category: rule.category,
          severity: rule.severity,
          description: rule.description,
        })
      }
    }
  }

  const maxSeverity = getMaxSeverity(findings)
  return {
    safe: !findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH'),
    findings,
    maxSeverity,
    scannedAt: new Date().toISOString(),
  }
}

function scanSkillFile(filePath) {
  const dir = path.dirname(filePath)
  return scanSkillDirectory(dir)
}

module.exports = {
  scanSkillDirectory,
  scanSkillFile,
  hashFileContent,
  computeDirectoryHash,
  addToWhitelist,
  removeFromWhitelist,
  SCAN_RULES,
  SEVERITY_ORDER,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_FILES,
}
