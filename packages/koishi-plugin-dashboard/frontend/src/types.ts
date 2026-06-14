export interface ApiResult<T = unknown> {
  ok: boolean
  data: T
  code?: string
}

export interface ApiMessageData extends JsonObject {
  message?: string
  token?: string
}

export interface MessageState {
  type: 'ok' | 'err' | 'info' | 'warn' | string
  text: string
}

export type JsonObject = Record<string, unknown>

export type JsonRecord = Record<string, unknown>

export type SelectValue = string | number | boolean | null

export interface SelectOption<T extends SelectValue = SelectValue> {
  value: T
  label: string
  disabled?: boolean
}

export interface DashboardTab {
  id: string
  label: string
}

export interface ThemeOption {
  id: string
  label: string
  desc: string
  colors: string[]
}

export type ShowAdminDialog = (message?: string, onVerified?: () => void | Promise<void>) => void

export interface StatusData extends JsonObject {
  provider?: string
  model?: string
}

export interface ResourceStatusData extends JsonObject {
  mode?: string
  resourceState?: string
  serverMode?: string
  serverModeSource?: string
  tool_active?: boolean
  render_active?: boolean
  background_allowed?: boolean
  memAvailableMb?: number | null
  memTotalMb?: number | null
  memSource?: string
  queueLength?: number
  maintenance?: boolean
}

export interface FeatureInfo extends JsonObject {
  id: string
  title: string
  summary: string
  detail: string
  usage?: string
  related?: string[]
}

export interface CommandInfo extends JsonObject {
  cmd: string
  desc: string
}

export interface CommandGroup extends JsonObject {
  category: string
  commands: CommandInfo[]
}

export interface ProviderModel extends JsonObject {
  id: string
  name?: string
  vision?: boolean
}

export interface ProviderInfo {
  name: string
  baseURL?: string
  keyFile?: string
  models: ProviderModel[]
}

export interface CustomProvider extends ProviderInfo {
  id: string
}

export interface DashboardConfig extends JsonObject {
  provider?: string
  model?: string
  baseUrl?: string
}

export interface FallbackStep extends JsonObject {
  provider: string
  model: string
  keyFile?: string
}

export type FallbackChains = Record<string, FallbackStep[]>

export interface FallbackData extends JsonObject {
  chains?: FallbackChains
  default?: FallbackChains
  message?: string
}

export interface WhitelistBuckets extends JsonObject {
  groups?: string[]
  users?: string[]
}

export type WhitelistData = string[] | WhitelistBuckets

export interface WhitelistEntry extends JsonObject {
  label: string
  data: WhitelistData
}

export type WhitelistMap = Record<string, WhitelistEntry>

export function errorMessage(error: unknown, fallback = '请求失败'): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || fallback)
  return fallback
}

export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

export function messageFromData(data: unknown, fallback = '请求失败'): string {
  if (isRecord(data) && typeof data.message === 'string') return data.message
  return fallback
}
