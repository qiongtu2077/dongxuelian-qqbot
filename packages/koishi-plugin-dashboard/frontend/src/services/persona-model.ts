import { asRecord } from '../types'

export interface PersonaDiagnostic {
  level?: string
  code?: string
  field?: string
  message?: string
}

export interface PersonaDiagnosticDocument {
  type: string
  name: string
  file?: string
  diagnostics?: PersonaDiagnostic[]
}

export interface PersonaDiagnosticItem {
  key: string
  type: string
  name: string
  file?: string
  level: string
  field: string
  message: string
}

export interface VoiceAsset {
  id: string
  filename?: string
  displayName: string
  description?: string
  sampleText?: string
  personaName: string
  size?: number
  mtime?: number
  referencedBy?: string[]
  isCurrent?: boolean
  missing?: boolean
}

// Reads an unknown persona API value as text.
export function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

// Reads an unknown persona API value as a finite number.
export function readNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// Narrows an unknown persona API list at the boundary.
export function listFromData<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

// Normalizes one cloned-voice asset returned by the backend.
export function normalizeVoiceAsset(value: unknown): VoiceAsset | null {
  const raw = asRecord(value)
  const id = readString(raw.id)
  if (!id) return null
  return {
    id,
    filename: readString(raw.filename) || undefined,
    displayName: readString(raw.displayName, id),
    description: readString(raw.description),
    sampleText: readString(raw.sampleText),
    personaName: readString(raw.personaName),
    size: raw.size === undefined ? undefined : readNumber(raw.size),
    mtime: raw.mtime === undefined ? undefined : readNumber(raw.mtime),
    referencedBy: listFromData<unknown>(raw.referencedBy).map(item => readString(item)).filter(Boolean),
    isCurrent: !!raw.isCurrent,
    missing: !!raw.missing,
  }
}

// Flattens document diagnostics into user-visible non-info rows.
export function flattenPersonaDiagnostics(documents: PersonaDiagnosticDocument[]): PersonaDiagnosticItem[] {
  const items: PersonaDiagnosticItem[] = []
  for (const doc of documents || []) {
    for (const diagnostic of doc.diagnostics || []) {
      if (diagnostic.level === 'info') continue
      items.push({
        key: `${doc.type}:${doc.name}:${diagnostic.code}:${diagnostic.field}:${items.length}`,
        type: doc.type,
        name: doc.name,
        file: doc.file,
        level: diagnostic.level || 'warning',
        field: diagnostic.field || '',
        message: diagnostic.message || diagnostic.code || '未知诊断',
      })
    }
  }
  return items
}

// Finds one usable cloned-voice asset by id.
export function findVoiceAssetById(assets: VoiceAsset[], id: string): VoiceAsset | null {
  return assets.find(asset => asset.id === id && !asset.missing) || null
}

// Picks a preferred, persona-owned, or first available voice asset in that order.
export function pickDefaultVoiceAsset(assets: VoiceAsset[], personaName: string, preferredId = ''): VoiceAsset | null {
  return findVoiceAssetById(assets, preferredId) || assets.find(asset => !asset.missing && asset.personaName === personaName) || assets.find(asset => !asset.missing) || null
}

// Formats one cloned-voice option for the selector.
export function assetOptionLabel(asset: VoiceAsset): string {
  const name = asset.displayName || asset.id
  const owner = asset.personaName ? `（${asset.personaName}）` : ''
  const refs = asset.referencedBy?.length ? ` · 使用：${asset.referencedBy.join('、')}` : ''
  return `${name}${owner}${asset.missing ? ' · 文件缺失' : refs}`
}

// Formats an audio file size.
export function formatBytes(size: unknown): string {
  const bytes = Number(size) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Formats an asset timestamp.
export function formatTime(ms: unknown): string {
  const value = Number(ms) || 0
  if (!value) return '未知时间'
  return new Date(value).toLocaleString()
}

// Decodes base64 audio into bytes before a preview Blob is created.
export function base64ToUint8Array(base64: string): Uint8Array {
  const raw = atob(String(base64 || '').replace(/\s+/g, ''))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}
