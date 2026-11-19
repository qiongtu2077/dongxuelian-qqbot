/** 主控与工作台在同一标签页共享主动退出状态。 */
const PAUSE_KEY = 'dashboard_source_paused'

/** 用户退出后，前端请求仅采用当前口令凭据。 */
export function sourcePaused(): boolean { return sessionStorage.getItem(PAUSE_KEY) === '1' }

/** 恢复来源登录必须是该标签页显式发起的动作。 */
export function pauseSource(paused: boolean): void {
  if (paused) sessionStorage.setItem(PAUSE_KEY, '1')
  else sessionStorage.removeItem(PAUSE_KEY)
}
