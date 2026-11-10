export interface ParticipationPolicy {
  version: 1
  privateEnabled: boolean
  groups: Record<string, boolean>
}

export interface ParticipationResponse {
  ok: boolean
  policy?: ParticipationPolicy
  message?: string
}

export type ParticipationChange = { kind: 'private'; enabled: boolean } | { kind: 'group'; groupId: string; enabled: boolean }

// 与后端保持相同的数字群号边界，避免提交空值或完整链接。
export function isParticipationGroupId(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value)
}

// 只列出已经配置过的群；没有配置的群始终默认关闭。
export function listParticipationGroups(policy: ParticipationPolicy): Array<{ id: string; enabled: boolean }> {
  return Object.entries(policy.groups).map(([id, enabled]) => ({ id, enabled })).sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true }))
}
