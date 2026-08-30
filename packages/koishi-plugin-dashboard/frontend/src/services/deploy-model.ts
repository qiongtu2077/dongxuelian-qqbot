import { asRecord } from '../types'

export interface PreviewItem {
  key: string
  label: string
  action: string
  path: string
  reason: string
  size?: number
  version?: string
  message: string
  paths?: Array<{ path?: string; size?: number }>
}

export interface DeletePreview {
  files?: PreviewItem[]
  protected?: PreviewItem[]
}

export interface UninstallPreview {
  deleteItems?: PreviewItem[]
  userDataItems?: PreviewItem[]
  keepItems?: PreviewItem[]
  warnings?: PreviewItem[]
}

// Reads an unknown API value as display text without leaking nullish values.
export function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

// Reads an unknown API value as a finite number.
export function readNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// Narrows an unknown API list at the boundary.
export function listFromData<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

// Narrows an unknown API object at the boundary.
export function dataRecord<T extends object>(value: unknown): T {
  return asRecord(value) as T
}

// Normalizes one deployment preview row into the stable component model.
export function normalizePreviewItem(value: unknown): PreviewItem {
  const raw = asRecord(value)
  return {
    key: readString(raw.key, readString(raw.path) || readString(raw.label)),
    label: readString(raw.label),
    action: readString(raw.action),
    path: readString(raw.path),
    reason: readString(raw.reason),
    size: raw.size === undefined ? undefined : readNumber(raw.size),
    version: readString(raw.version) || undefined,
    message: readString(raw.message),
    paths: listFromData<Record<string, unknown>>(raw.paths).map(item => ({ path: readString(item.path), size: item.size === undefined ? undefined : readNumber(item.size) })),
  }
}

// Normalizes the local-config deletion preview returned by the backend.
export function normalizeDeletePreview(value: unknown): DeletePreview {
  const raw = asRecord(value)
  return {
    files: listFromData<unknown>(raw.files).map(normalizePreviewItem),
    protected: listFromData<unknown>(raw.protected).map(normalizePreviewItem),
  }
}

// Normalizes the uninstall preview returned by the backend.
export function normalizeUninstallPreview(value: unknown): UninstallPreview {
  const raw = asRecord(value)
  return {
    deleteItems: listFromData<unknown>(raw.deleteItems).map(normalizePreviewItem),
    userDataItems: listFromData<unknown>(raw.userDataItems).map(normalizePreviewItem),
    keepItems: listFromData<unknown>(raw.keepItems).map(normalizePreviewItem),
    warnings: listFromData<unknown>(raw.warnings).map(normalizePreviewItem),
  }
}
