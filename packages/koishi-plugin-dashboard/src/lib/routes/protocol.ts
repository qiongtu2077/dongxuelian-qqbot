/** Linux 协议切换和 SnowLuma 原生扫码流程的鉴权入口。 */
import type { IncomingMessage, ServerResponse } from 'http'
import auth = require('../auth')
import utils = require('../utils')
const { requireAdmin } = auth
const { json, collectBody, getErrorMessage } = utils
import { protocolStatus, switchProtocol, withProtocolLock } from '../protocol-runtime'
import { slLoginState, acceptSlAgreements, connectSlAccount, clearSlSession } from '../snowluma-client'
import { desktopTicket } from '../sl-desktop'

/** 将异步 API 失败映射为可见响应，禁止吞掉启动或登录失败。 */
function respond(res: ServerResponse, operation: () => Promise<unknown>): void {
  operation().then(result => json(res, { ok: true, ...result as object }))
    .catch(error => json(res, { ok: false, message: getErrorMessage(error) }, 409))
}

/** 返回公开的服务选择和运行状态，不暴露凭据与登录桌面。 */
function getStatus(req: IncomingMessage, res: ServerResponse): void {
  respond(res, protocolStatus)
}

/** 管理员请求切换，严格验证协议枚举并等待服务切换实际完成。 */
function postSwitch(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, body => {
    respond(res, async () => {
      const provider = JSON.parse(body).provider
      if (provider !== 'napcat' && provider !== 'sl') throw new Error('协议只能是 napcat 或 sl')
      clearSlSession()
      const status = await switchProtocol(provider)
      return { status, message: `${provider === 'sl' ? 'SnowLuma' : 'NapCat'} 已启动，另一协议已停止；请完成登录` }
    })
  })
}

/** 读取真实 SnowLuma 登录引导，首次返回完整协议文本。 */
function getSlLogin(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  respond(res, slLoginState)
}

/** 明确点击同意后才将当前协议版本转交官方确认接口。 */
function postConsent(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  collectBody(req, res, body => {
    respond(res, async () => {
      const version = JSON.parse(body).version
      if (typeof version !== 'string' || !/^[a-f0-9]{16}$/.test(version)) throw new Error('协议版本无效，请刷新后重试')
      return acceptSlAgreements(version)
    })
  })
}

/** 仅管理员能接入当前受管 QQ 进程并完成机器人重连。 */
function postConnect(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  respond(res, () => withProtocolLock(connectSlAccount))
}

/** 只为当前已启动且已确认协议的 SL 签发一次性扫码桌面票据。 */
function postDesktop(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return
  respond(res, async () => {
    const status = await protocolStatus()
    if (status.selected !== 'sl' || status.sl?.state !== 'active' || status.switching) throw new Error('SnowLuma 尚未就绪')
    const state = await slLoginState()
    if (state.agreements.consentRequired) throw new Error('请先阅读并同意 SnowLuma 用户协议与隐私政策')
    return { url: '/dashboard/sl-desktop/?ticket=' + desktopTicket(req) }
  })
}

export const routes = {
  'GET /dashboard/api/protocol/status': getStatus,
  'POST /dashboard/api/protocol/switch': postSwitch,
  'GET /dashboard/api/protocol/sl/login': getSlLogin,
  'POST /dashboard/api/protocol/sl/consent': postConsent,
  'POST /dashboard/api/protocol/sl/connect': postConnect,
  'POST /dashboard/api/protocol/sl/desktop': postDesktop,
}
