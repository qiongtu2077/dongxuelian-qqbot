/**
 * MODULE: Shell 命令安全守卫。
 * 职责: 对 execute_shell 命令进行多层安全检查，移植自 QwenPaw ToolGuard 全部规则。
 * 边界: 不执行命令，只返回违规列表。
 * 状态: 无运行时状态（纯函数）。
 */
// ============================================================
// 类别1：数据销毁
// ============================================================
const DATA_DESTRUCTION = [
  { id: 'TOOL_CMD_DANGEROUS_RM', re: /\brm\b|\bdel\b|\bRemove-Item\b/i, sev: 'high',
    desc: '检测可能导致数据丢失的 rm 命令' },
  { id: 'TOOL_CMD_DANGEROUS_MV', re: /\bmv\b/i, sev: 'high',
    desc: '检测可能意外移动或覆盖文件的 mv 命令' },
  { id: 'TOOL_CMD_FS_DESTRUCTION', re: /\bmkfs(\.\w+)?\b|\bmke2fs\b|\bdd\s+.*of=\/dev\/|>\s*\/dev\/(sd[a-z]|vd[a-z]|nvme\d+n\d+)/i, sev: 'critical',
    desc: '检测低级别磁盘格式化或擦除命令' },
  { id: 'TOOL_CMD_NON_ROOT_RM', re: /\brm\s+-rf\s+(?!\/)/i, sev: 'high',
    desc: '检测递归删除非根目录' },
]

// ============================================================
// 类别2：系统破坏
// ============================================================
const SYSTEM_DESTRUCTION = [
  { id: 'TOOL_CMD_SYSTEM_REBOOT', re: /\b(reboot|shutdown|halt|poweroff)\b|\binit\s+[06]\b|\btelinit\s+[06]\b|\bShutdown-Computer\b|\bRestart-Computer\b/i, sev: 'critical',
    desc: '检测将终止主机系统的重启或关机命令' },
  { id: 'TOOL_CMD_SERVICE_RESTART', re: /\bsystemctl\s+(restart|stop|start|reload|kill)\b|\bservice\s+\S+\s+(restart|stop|start|reload)\b|\b(sc|net)\s+(start|stop|restart)\b|\blaunchctl\s+(load|unload|stop|start|kickstart|kill)\b|\brc-service\s+(restart|stop|start)\b/i, sev: 'high',
    desc: '检测可能中断系统服务的服务管理命令' },
  { id: 'TOOL_CMD_PROCESS_KILL', re: /\b(pkill|killall)\b|\bkill\s+(-[^\s]+\s+)?[^-\s]|\btaskkill\s+\/F\b|\bStop-Process\b.*-Force\b/i, sev: 'high',
    desc: '检测可能终止关键进程的进程终止命令' },
  { id: 'TOOL_CMD_DOS_FORK_BOMB', re: /[:\uFF1A]\s*\(\s*\)\s*\{\s*[:\uFF1A]\s*\|\s*[:\uFF1A]\s*&\s*\}\s*[;\uFF1B]\s*[:\uFF1A]|^\s*kill\s+-9\s+(-1|1)\b/im, sev: 'critical',
    desc: '检测经典 Bash Fork 炸弹和批量进程终止' },
]

// ============================================================
// 类别3：代码执行
// ============================================================
const CODE_EXECUTION = [
  { id: 'TOOL_CMD_PIPE_TO_SHELL', re: /\b(curl|wget)\b\s+.*\|.*\b(bash|sh|zsh|ash|dash)\b/i, sev: 'critical',
    desc: '检测通过 curl|bash 模式下载并立即执行远程载荷' },
  { id: 'TOOL_CMD_OBFUSCATED_EXEC', re: /\bbase64\s+(-d|--decode)\s*\|\s*\b(bash|sh|zsh)\b/i, sev: 'high',
    desc: '检测将 base64 编码字符串直接传递给 Shell 解释器执行' },
  { id: 'TOOL_CMD_IFS_INJECTION', re: /\$IFS(?!\w)|\$\{[^}]*IFS/i, sev: 'high',
    desc: '命令使用 $IFS 变量，可以绕过安全验证' },
  { id: 'TOOL_CMD_PARAM_EXPANSION', re: /\$\{[^}]*[:!#%\/^,@*]/, sev: 'high',
    desc: '命令使用 Shell 参数展开（${...}），可构造任意字符串绕过检测' },
  { id: 'TOOL_CMD_CONTROL_CHARS', re: /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/, sev: 'critical',
    desc: '命令包含不可打印的控制字符，可能绕过安全检查' },
  { id: 'TOOL_CMD_UNICODE_WHITESPACE', re: /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/, sev: 'high',
    desc: '命令包含可能导致解析不一致的 Unicode 空白字符' },
  { id: 'TOOL_CMD_JQ_SYSTEM', re: /\bjq\b.*\bsystem\s*\(/i, sev: 'high',
    desc: 'JQ 命令包含 system() 函数，可以执行任意 shell 命令' },
  { id: 'TOOL_CMD_JQ_FILE_FLAGS', re: /\bjq\b.*(?: -f\b| --from-file\b| --rawfile\b| --slurpfile\b| -L\b| --library-path\b)/i, sev: 'high',
    desc: 'JQ 命令使用可以读取任意文件或执行外部代码的标志' },
  { id: 'TOOL_CMD_ZSH_DANGEROUS', re: /\b(zmodload|emulate\s+.*-c|sysopen|sysread|syswrite|sysseek|zpty|ztcp|zsocket|zf_rm|zf_mv|zf_ln|zf_chmod|zf_chown|zf_mkdir|zf_rmdir|zf_chgrp|fc\s+.*-.*e)\b/i, sev: 'high',
    desc: '使用了 Zsh 专用的内置功能，可以绕过安全检查' },
]

// ============================================================
// 类别4：网络滥用
// ============================================================
const NETWORK_ABUSE = [
  { id: 'TOOL_CMD_REVERSE_SHELL', re: /\/dev\/(tcp|udp)\/|\bnc\s+.*-e\s*\S+|\bncat\s+.*-e\s*\S+|\bsocat\s+.*EXEC:/i, sev: 'critical',
    desc: '检测建立反向 Shell 或未授权网络隧道' },
]

// ============================================================
// 类别5：敏感文件访问
// ============================================================
const SENSITIVE_FILE = [
  { id: 'TOOL_CMD_SYSTEM_TAMPERING', re: /\bcrontab\b|\bauthorized_keys\b|\/etc\/(sudoers|crontab)/i, sev: 'high',
    desc: '检测对定时任务、SSH 密钥或 sudo 权限的访问' },
  { id: 'TOOL_CMD_PROC_ENVIRON', re: /\/proc\/(self|\d+)\/environ(?:\b|$)/i, sev: 'high',
    desc: '访问 /proc/*/environ，可能会暴露敏感的环境变量' },
]

// ============================================================
// 类别6：权限提升
// ============================================================
const PRIVILEGE_ESCALATION = [
  { id: 'TOOL_CMD_PRIVILEGE_ESCALATION', re: /\bsudo\s+|\bsu\b|\bdoas\s+|\bpkexec\b|\brunas\s+\/user:/i, sev: 'critical',
    desc: '检测使用 sudo、su、doas、pkexec 或 runas 的权限提升尝试' },
  { id: 'TOOL_CMD_UNSAFE_PERMISSIONS', re: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+(777|a\+rwx)\s+\/|\bchattr\s+\+i/i, sev: 'high',
    desc: '检测全局权限降级（chmod 777）或设置不可变标志' },
]

// ============================================================
// 类别7：Shell 规避技术
// ============================================================
const SHELL_EVASION = [
  { id: 'SHELL_EVASION_COMMAND_SUBSTITUTION', re: /[<>]=?\s*\(|\$\(|\$\[|~\[|\([eE]:|\(\+|\}\s*always\s*\{|<#/i, sev: 'high',
    desc: '检测 Shell 命令替换和进程替换语法，可能绕过安全检查' },
  { id: 'SHELL_EVASION_OBFUSCATED_FLAGS', re: /\$['"][^'"]*['"]\s*-|''\s*-|""\s*-|'(?:-[a-zA-Z]+)'/i, sev: 'high',
    desc: '检测混淆的命令行标志（空引号、ANSI-C 引用等）' },
  { id: 'SHELL_EVASION_BACKSLASH_OPERATOR', re: /\\[;&|<>]/, sev: 'high',
    desc: '检测反斜杠转义的 Shell 运算符，可能隐藏额外命令' },
  { id: 'SHELL_EVASION_NEWLINE', re: /\r(?!")|\n\s*\S/, sev: 'high',
    desc: '检测命令中内嵌的换行符，可能隐藏额外命令' },
  { id: 'SHELL_EVASION_COMMENT_QUOTE', re: /#.*['"]/, sev: 'high',
    desc: '检测注释中的引号字符，可能导致引号配对混乱' },
  { id: 'SHELL_EVASION_QUOTED_NEWLINE', re: /['"][^'"]*\n[^'"]*#/, sev: 'high',
    desc: '检测引号内换行后接注释，可能隐藏命令参数' },
]

// ============================================================
// 类别8：Backtick 注入（程序化检测）
// ============================================================
function checkBacktickInjection(cmd) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (ch === '`' && !inSingle) {
      return { id: 'SHELL_EVASION_BACKTICK', sev: 'high', desc: '命令包含反引号命令替换（`cmd`），可执行任意命令' }
    }
  }
  return null
}

// ============================================================
// 类别9：Escaped Whitespace 检测
// ============================================================
function checkBackslashWhitespace(cmd) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < cmd.length - 1; i++) {
    const ch = cmd[i]
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (ch === '\\' && !inSingle && /[\s\t]/.test(cmd[i + 1])) {
      return { id: 'SHELL_EVASION_BACKSLASH_WHITESPACE', sev: 'high', desc: '检测反斜杠转义的空格字符，可能用于混淆命令' }
    }
  }
  return null
}

// ============================================================
// 所有规则合并
// ============================================================
const ALL_REGEX_RULES = [
  ...DATA_DESTRUCTION,
  ...SYSTEM_DESTRUCTION,
  ...CODE_EXECUTION,
  ...NETWORK_ABUSE,
  ...SENSITIVE_FILE,
  ...PRIVILEGE_ESCALATION,
  ...SHELL_EVASION,
]

const ALL_PROGRAMMATIC_CHECKS = [
  checkBacktickInjection,
  checkBackslashWhitespace,
]

const CATEGORY_META = Object.freeze({
  DATA_DESTRUCTION: { label: '数据销毁', description: '删除、移动、格式化、覆写磁盘等可能造成不可恢复数据损失的命令。' },
  SYSTEM_DESTRUCTION: { label: '系统破坏', description: '重启、停机、服务管理、进程终止和 fork bomb 等会影响宿主稳定性的命令。' },
  CODE_EXECUTION: { label: '代码执行绕过', description: '下载后执行、编码载荷、IFS、控制字符、危险 jq/zsh 能力等绕过手段。' },
  NETWORK_ABUSE: { label: '网络滥用', description: '反向 Shell、/dev/tcp、nc -e、socat EXEC 等未授权隧道。' },
  SENSITIVE_FILE: { label: '敏感文件访问', description: '访问 sudoers、authorized_keys、/proc/*/environ 等敏感系统位置。' },
  PRIVILEGE_ESCALATION: { label: '权限提升', description: 'sudo/su/pkexec/runas 或全局权限破坏类命令。' },
  SHELL_EVASION: { label: 'Shell 规避', description: '命令替换、混淆 flag、反斜杠操作符、异常换行和注释引号错位。' },
  PROGRAMMATIC: { label: '程序化检查', description: '需要状态机解析的反引号注入和反斜杠空白混淆。' },
})

const CATEGORY_RULES = Object.freeze({
  DATA_DESTRUCTION,
  SYSTEM_DESTRUCTION,
  CODE_EXECUTION,
  NETWORK_ABUSE,
  SENSITIVE_FILE,
  PRIVILEGE_ESCALATION,
  SHELL_EVASION,
  PROGRAMMATIC: [
    { id: 'SHELL_EVASION_BACKTICK', sev: 'high', desc: '命令包含单引号外反引号命令替换，可执行任意命令' },
    { id: 'SHELL_EVASION_BACKSLASH_WHITESPACE', sev: 'high', desc: '检测反斜杠转义的空白字符，可能用于混淆命令' },
  ],
})

// ============================================================
// 主检查函数
// ============================================================

/**
 * 对 shell 命令执行完整安全检查
 * @param {string} command - 要执行的 shell 命令
 * @returns {{ violations: Array, blocked: boolean, summary: string }}
 */
function checkShellCommand(command) {
  if (!command || typeof command !== 'string') {
    return { violations: [], blocked: false, summary: '' }
  }

  const violations = []

  // 正则规则扫描
  for (const rule of ALL_REGEX_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(command)) {
      violations.push({
        id: rule.id,
        severity: rule.sev,
        description: rule.desc,
        category: getRuleCategory(rule.id),
      })
    }
  }

  // 程序化检查
  for (const check of ALL_PROGRAMMATIC_CHECKS) {
    const result = check(command)
    if (result) {
      violations.push({
        id: result.id,
        severity: result.sev,
        description: result.desc,
        category: getRuleCategory(result.id),
      })
    }
  }

  // 去重（同一 ID 只保留一次）
  const seen = new Set()
  const unique = violations.filter(v => {
    if (seen.has(v.id)) return false
    seen.add(v.id)
    return true
  })

  const hasCritical = unique.some(v => v.severity === 'critical')

  return {
    violations: unique,
    blocked: hasCritical,
    summary: unique.length > 0
      ? `检测到 ${unique.length} 条安全违规：${unique.map(v => `[${v.severity}] ${v.id}`).join('; ')}`
      : '',
  }
}

/**
 * 快速判断命令是否包含任何危险模式
 */
function isCommandSafe(command) {
  const result = checkShellCommand(command)
  return !result.blocked && result.violations.length === 0
}

function getRuleCategory(ruleId = '') {
  const id = String(ruleId || '')
  for (const [category, rules] of Object.entries(CATEGORY_RULES)) {
    if (rules.some(rule => rule.id === id)) return category
  }
  return 'UNKNOWN'
}

function listShellGuardRules() {
  return Object.entries(CATEGORY_RULES).map(([category, rules]) => {
    const meta = CATEGORY_META[category] || { label: category, description: '' }
    return {
      category,
      label: meta.label,
      description: meta.description,
      count: rules.length,
      rules: rules.map(rule => ({
        id: rule.id,
        severity: rule.sev,
        description: rule.desc,
      })),
    }
  })
}

function summarizeShellCommand(command = '', max = 220) {
  const redacted = String(command || '')
    .replace(/(sk|tp)-[A-Za-z0-9_-]{12,}/g, '$1-***')
    .replace(/(api[_-]?key|token|password|passwd|pwd)\s*=\s*["']?[^"'\s;&|]+/ig, '$1=***')
    .replace(/\s+/g, ' ')
    .trim()
  if (redacted.length <= max) return redacted
  return redacted.slice(0, max - 3) + '...'
}

module.exports = {
  checkShellCommand,
  isCommandSafe,
  ALL_REGEX_RULES,
  listShellGuardRules,
  summarizeShellCommand,
  // 导出各分类供 Dashboard 展示
  categories: {
    DATA_DESTRUCTION,
    SYSTEM_DESTRUCTION,
    CODE_EXECUTION,
    NETWORK_ABUSE,
    SENSITIVE_FILE,
    PRIVILEGE_ESCALATION,
    SHELL_EVASION,
  },
}
