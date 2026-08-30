/**
 * MODULE: remote deployment target contract.
 * 职责: 校验 SSH 目标与 Linux 应用目录，并构造参数边界明确的 SSH/SCP 命令。
 * 边界: 不执行命令、不读取凭据、不管理发布状态。
 */
const { commandQuote } = require('./utils') as typeof import('./utils')

type DeployMode = 'install' | 'update'

interface DeployTargetInput {
  server?: unknown
  appDir?: unknown
  mode?: unknown
}

export interface DeployTarget extends DeployTargetInput {
  server: string
  appDir: string
  mode: DeployMode
}

interface ScpOptions {
  recursive?: boolean
}

// 校验 SSH user@host 目标，拒绝空白和 shell 元字符。
export function validateDeployServer(server: unknown): string {
  const value = String(server || '').trim()
  if (!value) throw new Error('deploy server is required')
  if (/[\s;|`$<>"'\\]/.test(value) || value.includes('$(')) throw new Error('invalid deploy server')
  const user = '(?:[A-Za-z0-9._-]+@)?'
  const hostname = '(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)'
  const ipv4 = '(?:\\d{1,3}\\.){3}\\d{1,3}'
  const ipv6 = '\\[[0-9A-Fa-f:.]+\\]'
  const re = new RegExp(`^${user}(?:${hostname}|${ipv4}|${ipv6})$`)
  if (!re.test(value)) throw new Error('invalid deploy server')
  return value
}

// 校验非根 Linux 绝对目录，拒绝点路径段和 shell 元字符。
export function validateDeployAppDir(appDir: unknown): string {
  const value = String(appDir || '').trim().replace(/\/+$/, '') || '/'
  if (!value.startsWith('/')) throw new Error('appDir must be an absolute Linux path')
  if (value === '/') throw new Error('appDir must not be the filesystem root')
  if (value.split('/').some(part => part === '.' || part === '..')) throw new Error('appDir must not contain dot path segments')
  if (/[\s;&|`$()<>"'\\]/.test(value)) throw new Error('invalid appDir')
  return value
}

// 将未知请求体解析成可信远程部署目标。
export function validateDeployTarget(cfg: DeployTargetInput = {}): DeployTarget {
  return {
    ...cfg,
    server: validateDeployServer(cfg.server),
    appDir: validateDeployAppDir(cfg.appDir),
    mode: cfg.mode === 'install' ? 'install' : 'update',
  }
}

// 在已校验的远程应用目录下拼接相对路径片段。
export function remoteJoin(base: unknown, ...parts: unknown[]): string {
  const root = validateDeployAppDir(base)
  const suffix = parts.map(part => String(part || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
  return suffix ? `${root.replace(/\/+$/, '')}/${suffix}` : root
}

// 构造批处理模式 SSH 命令，远端命令作为单一参数引用。
export function sshCommand(server: unknown, remoteCmd: unknown): string {
  return `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -- ${validateDeployServer(server)} ${commandQuote(remoteCmd)}`
}

// 构造经过目标和绝对路径校验的 SCP 远端参数。
export function scpRemoteTarget(server: unknown, remotePath: unknown): string {
  const targetPath = String(remotePath || '')
  if (!targetPath.startsWith('/') || /[\s;&|`$()<>"'\\]/.test(targetPath)) throw new Error('invalid remote path')
  return `${validateDeployServer(server)}:${targetPath}`
}

// 构造批处理模式 SCP 命令，源与目标由调用方先建立边界。
export function scpCommand(source: unknown, target: unknown, options: ScpOptions = {}): string {
  const recursive = options.recursive ? '-r ' : ''
  return `scp -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${recursive}${commandQuote(source)} ${target}`
}
