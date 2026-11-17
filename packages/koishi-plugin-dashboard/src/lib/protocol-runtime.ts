/** 管理当前项目的 Linux QQ 协议服务、持久选择与跨请求互斥切换。 */
import fs = require('fs')
import path = require('path')
import { execFile } from 'child_process'
import http = require('http')
import paths = require('./paths')
const { KOISHI_DIR, DATA_DIR } = paths

export type Protocol = 'napcat' | 'sl'
export const selectionFile = path.join(DATA_DIR, 'qq-protocol.json')
export const slRoot = process.env.SNOWLUMA_DIR || '/root/SnowLuma'
const units = { napcat: 'lian-napcat.service', sl: 'lian-snowluma.service' }
let switching = false

// --- 服务与选择状态 ---

/** 执行固定参数的服务命令，保留 systemd 的原始失败原因。 */
export function systemctl(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', args, { timeout: 45000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout.trim())
    })
  })
}

/** 读取唯一协议选择；缺失时沿用既有 NapCat，损坏时拒绝启动。 */
export function selectedProtocol(): Protocol {
  if (!fs.existsSync(selectionFile)) return 'napcat'
  const value = JSON.parse(fs.readFileSync(selectionFile, 'utf8')).provider
  if (value !== 'napcat' && value !== 'sl') throw new Error('QQ 协议选择文件无效')
  return value
}

/** 同目录原子保存选择，供 Dashboard 和 systemd 启动门禁共同读取。 */
function saveSelection(provider: Protocol): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(selectionFile + '.next', JSON.stringify({ provider }) + '\n', { mode: 0o600 })
  fs.renameSync(selectionFile + '.next', selectionFile)
}

/** 读取服务状态及控制组，必须确认进程组已清空后才允许启动另一协议。 */
export async function serviceState(unit: string): Promise<{ state: string; pid: number }> {
  const raw = await systemctl('show', unit, '--property=ActiveState,MainPID,LoadState', '--no-pager')
  const values = Object.fromEntries(raw.split('\n').map(line => line.split('=', 2)))
  return { state: values.LoadState === 'not-found' ? 'missing' : values.ActiveState, pid: Number(values.MainPID) || 0 }
}

/** 查询两个受管实例的真实状态，不把其他项目 QQ 实例算进来。 */
export async function protocolStatus() {
  if (process.platform !== 'linux') return { supported: false, selected: 'napcat' as Protocol, switching: false }
  const [napcat, sl] = await Promise.all([serviceState(units.napcat), serviceState(units.sl)])
  return { supported: true, selected: selectedProtocol(), switching: switching || fs.existsSync(path.join(DATA_DIR, 'qq-protocol-switch.lock')), napcat, sl, conflict: napcat.pid > 0 && sl.pid > 0, installed: fs.existsSync(path.join(slRoot, 'runtime/index.mjs')) }
}

/** 读取对应服务 WebUI，成功响应完成后才报告协议启动成功。 */
function probeWebui(provider: Protocol): Promise<boolean> {
  const port = provider === 'sl' ? 5099 : Number(process.env.NAPCAT_PORT || 6099)
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: provider === 'sl' ? '/' : '/webui/', agent: false }, res => {
      let bytes = 0
      res.on('data', chunk => { bytes += chunk.length })
      res.on('end', () => resolve(res.statusCode === 200 && bytes > 0))
      res.on('error', () => resolve(false))
    })
    req.setTimeout(1500, () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

/** 有界等待页面就绪，不能用端口占用代替运行健康。 */
async function waitWebui(provider: Protocol): Promise<void> {
  const deadline = Date.now() + 30000
  do {
    if (await probeWebui(provider)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  } while (Date.now() < deadline)
  throw new Error(`${provider === 'sl' ? 'SnowLuma' : 'NapCat'} 启动后未返回有效 WebUI`)
}

// --- 互斥切换 ---

/** 停止协议并核实其 MainPID 已清空；失败时绝不启动另一个实例。 */
async function stopProtocol(provider: Protocol): Promise<void> {
  const before = await serviceState(units[provider])
  if (before.state === 'missing') return
  await systemctl('stop', units[provider])
  const after = await serviceState(units[provider])
  if (after.pid || !['inactive', 'failed'].includes(after.state)) throw new Error(`${units[provider]} 未完全停止，已禁止启动另一协议`)
}

/** 获取目录锁；仅在原持有进程已退出时回收其独占 PID 标记。 */
function acquireProtocolLock(lock: string): void {
  try { fs.mkdirSync(lock) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owners = fs.readdirSync(lock)
    if (owners.length !== 1 || !/^[1-9][0-9]{0,9}$/.test(owners[0])) throw new Error('协议操作锁未完成初始化，请检查 Dashboard 服务状态')
    try {
      process.kill(Number(owners[0]), 0)
      throw new Error('协议操作锁已占用，请等待当前操作完成')
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') throw ownerError
    }
    // 删除特定旧 PID 标记，两个清理者中只有一个能继续，不会移走新持有者的锁。
    fs.unlinkSync(path.join(lock, owners[0]))
    fs.rmdirSync(lock)
    fs.mkdirSync(lock)
  }
  fs.writeFileSync(path.join(lock, String(process.pid)), '', { flag: 'wx', mode: 0o600 })
}

/** 将切换与登录重连放在同一个跨进程排他区间，避免两个请求相互覆盖。 */
export async function withProtocolLock<T>(operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') throw new Error('协议切换只支持 Linux 服务器')
  if (switching) throw new Error('协议正在切换，请等待当前操作完成')
  switching = true
  const lock = path.join(DATA_DIR, 'qq-protocol-switch.lock')
  let locked = false
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    acquireProtocolLock(lock)
    locked = true
    return await operation()
  } finally {
    if (locked) { fs.unlinkSync(path.join(lock, String(process.pid))); fs.rmdirSync(lock) }
    switching = false
  }
}

/** 串行切换协议，目标启动失败时先停目标再恢复旧选择和原先运行的服务。 */
export async function switchProtocol(provider: Protocol) {
  return withProtocolLock(async () => {
    const previous = selectedProtocol()
    const oldState = await serviceState(units[previous])
    const target = await serviceState(units[provider])
    if (target.state === 'missing') throw new Error(`${units[provider]} 尚未安装`)
    const bot = await serviceState('lian-koishi.service')
    if (bot.state === 'active') await systemctl('stop', 'lian-koishi.service')
    try {
      // 两边都停，既处理正常切换，也收住历史或手工启动产生的冲突。
      await stopProtocol(previous)
      if (provider !== previous) await stopProtocol(provider)
      saveSelection(provider)
      await systemctl('start', units[provider])
      await waitWebui(provider)
      await systemctl('enable', units[provider])
      if (provider !== previous) await systemctl('disable', units[previous])
    } catch (error) {
      // 必须先确认目标退出，才能恢复旧实例，避免回滚也造成双登录。
      await stopProtocol(provider)
      saveSelection(previous)
      if (oldState.state === 'active') await systemctl('start', units[previous])
      if (bot.state === 'active') await systemctl('start', 'lian-koishi.service')
      throw error
    }
    if (bot.state === 'active') await systemctl('start', 'lian-koishi.service')
    return { ...await protocolStatus(), switching: false }
  })
}

/** 旧 NapCat 启动入口必须服从已启用协议，菜单浏览不能放行启动。 */
export function assertNapcatSelected(): void {
  if (process.platform === 'linux' && selectedProtocol() !== 'napcat') throw new Error('当前使用 SnowLuma，请先在顶部选择 NapCat 并点击“启动 / 重启”')
}

/** 将当前实例数据路径提供给登录适配，避免读取另一个项目。 */
export const koishiDir = KOISHI_DIR
