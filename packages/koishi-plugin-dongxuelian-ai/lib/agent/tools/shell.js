/**
 * MODULE: Shell 命令执行工具。
 * 安全：QwenPaw 完整 28 规则 shell-guard + timeout + 路径限定。默认危险（需 confirm 或 block）。
 */
const { execFile } = require('child_process')
const os = require('os')
const { assertExistingAgentPathInsideRoots } = require('../path-guard')
const { checkShellCommand, summarizeShellCommand } = require('./shell-guard')

function formatGuardError(command, guardResult) {
  const first = guardResult.violations[0] || {}
  const lines = [
    '命令被 Shell Guard 拒绝。',
    `规则：${first.id || 'UNKNOWN'} (${first.severity || 'unknown'})`,
    `原因：${first.description || guardResult.summary || '命令触发安全策略'}`,
    `命令摘要：${summarizeShellCommand(command)}`,
    '建议：优先使用 read_file/list_files/grep_search/find_files 等受控工具；需要文件变更时使用 write_file/edit_file/append_file。',
  ]
  const error = new Error(lines.join('\n'))
  error.code = 'SHELL_GUARD_BLOCKED'
  error.guard = {
    blocked: true,
    commandSummary: summarizeShellCommand(command),
    violations: guardResult.violations,
  }
  return error
}

module.exports = {
  definition: {
    name: 'execute_shell',
    description: '执行 shell 命令。Windows 用 cmd.exe，Linux/macOS 用 sh。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，默认 bot 目录' },
      },
      required: ['command'],
    },
  },
  async execute(params = {}) {
    const command = String(params.command || '').trim()
    if (!command) throw new Error('命令为空')
    if (command.length > 8000) throw new Error('命令过长')

    // QwenPaw 完整安全规则检查
    const guardResult = checkShellCommand(command)
    if (guardResult.violations.length > 0) {
      throw formatGuardError(command, guardResult)
    }

    const { abs: cwd } = await assertExistingAgentPathInsideRoots(params.cwd || process.cwd(), '工作目录')
    const isWin = os.platform() === 'win32'

    return new Promise(resolve => {
      const child = execFile(
        isWin ? 'cmd.exe' : '/bin/sh',
        isWin ? ['/d', '/s', '/c', command] : ['-c', command],
        { cwd, timeout: 25000, maxBuffer: 500 * 1024, windowsHide: true, env: { ...process.env } },
        (err, stdout, stderr) => {
          const parts = []
          if (stdout) parts.push(`[stdout]\n${stdout}`)
          if (stderr) parts.push(`[stderr]\n${stderr}`)
          if (err && err.killed) parts.push('(命令执行超时，已取消)')
          else if (err) parts.push(`[exit code: ${err.code || -1}]`)
          if (parts.length === 0) parts.push('(执行成功，无输出)')
          resolve(parts.join('\n'))
        },
      )
    })
  },
  dangerous: true,
  defaultChannels: ['dashboard'],
}
