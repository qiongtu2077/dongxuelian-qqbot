/**
 * MODULE: 克隆音色资产元数据。
 * 职责: 维护 DATA_DIR/ai-voice-assets.json，并兼容旧的 ai-voices/<人格名>.<ext> 样本。
 * 边界: 不调用 TTS API、不发送消息、不修改人格 SKILL 文件。
 * 状态: 无常驻状态；每次从运行时 data 读取文件与元数据。
 */
const fs = require('fs')
const path = require('path')
const { VOICES_DIR, VOICE_ASSETS_FILE } = require('./constants')

const STORE_VERSION = 1
const MAX_STORE_BYTES = 1024 * 1024
const DEFAULT_SAMPLE_TEXT = '你好，这是一段语音测试。'
const MAX_SAMPLE_TEXT_LENGTH = 120
const MAX_DESCRIPTION_LENGTH = 300
const MAX_DISPLAY_NAME_LENGTH = 80
const MAX_VOICE_SAMPLE_BYTES = 10 * 1024 * 1024
const MIN_VOICE_SAMPLE_BYTES = 1024

const MIME_BY_EXT = {
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
}

function sanitizeVoiceAssetId(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9一-鿿._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'voice'
}

function cleanText(value, maxLength, fallback = '') {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
  return (text || fallback).slice(0, maxLength)
}

function getAudioExtFromMime(mimeType = '') {
  const mime = String(mimeType || '').toLowerCase()
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('flac')) return 'flac'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  return 'mp3'
}

function getAudioMimeFromFilename(filename, fallback = 'audio/mpeg') {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] || fallback
}

function createVoiceAssetId(personaName = '', existingAssets = null) {
  const assets = Array.isArray(existingAssets) ? existingAssets : listVoiceAssets()
  const used = new Set(assets.map(asset => asset.id))
  const prefix = sanitizeVoiceAssetId(personaName).slice(0, 32) || 'voice'
  for (let i = 0; i < 20; i++) {
    const stamp = Date.now().toString(36)
    const random = Math.random().toString(36).slice(2, 8)
    const id = sanitizeVoiceAssetId(`${prefix}_${stamp}_${random}`)
    if (!used.has(id)) return id
  }
  return sanitizeVoiceAssetId(`${prefix}_${process.pid}_${Date.now()}`)
}

function buildVoiceAssetFilename(assetId, mimeType = '') {
  const id = sanitizeVoiceAssetId(assetId)
  const ext = getAudioExtFromMime(mimeType)
  return sanitizeVoiceFilename(`${id}.${ext}`)
}

function sanitizeVoiceFilename(filename = '') {
  const base = path.basename(String(filename || ''))
  const ext = path.extname(base).slice(1).toLowerCase()
  if (!base || !MIME_BY_EXT[ext]) return ''
  return base.replace(/[^a-zA-Z0-9一-鿿._-]/g, '_').slice(0, 120)
}

function getVoiceFilePath(filename) {
  const safe = sanitizeVoiceFilename(filename)
  if (!safe) return null
  return path.join(VOICES_DIR, safe)
}

function getVoiceFileInfo(filename) {
  const safe = sanitizeVoiceFilename(filename)
  const filePath = getVoiceFilePath(safe)
  if (!filePath) return null
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    return {
      filename: safe,
      filePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      mimeType: getAudioMimeFromFilename(safe),
      missing: false,
    }
  } catch {
    return { filename: safe, filePath, size: 0, mtime: 0, mimeType: getAudioMimeFromFilename(safe), missing: true }
  }
}

function readStoreAssets() {
  try {
    const stat = fs.statSync(VOICE_ASSETS_FILE)
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return []
    const raw = JSON.parse(fs.readFileSync(VOICE_ASSETS_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : Array.isArray(raw.assets) ? raw.assets : []
  } catch {
    return []
  }
}

function writeStoreAssets(assets) {
  fs.mkdirSync(path.dirname(VOICE_ASSETS_FILE), { recursive: true })
  const tmp = `${VOICE_ASSETS_FILE}.${process.pid}.${Date.now()}.tmp`
  const payload = JSON.stringify({ version: STORE_VERSION, assets }, null, 2) + '\n'
  fs.writeFileSync(tmp, payload, 'utf8')
  try {
    fs.renameSync(tmp, VOICE_ASSETS_FILE)
  } catch (error) {
    try { fs.unlinkSync(VOICE_ASSETS_FILE) } catch {}
    fs.renameSync(tmp, VOICE_ASSETS_FILE)
  }
}

function normalizeVoiceAsset(raw = {}, fileInfo = null) {
  const filename = sanitizeVoiceFilename(raw.filename || fileInfo?.filename || '')
  const baseName = filename ? path.basename(filename, path.extname(filename)) : ''
  const personaName = cleanText(raw.personaName || raw.persona || baseName, MAX_DISPLAY_NAME_LENGTH, baseName)
  const id = sanitizeVoiceAssetId(raw.id || personaName || baseName)
  const sampleText = cleanText(raw.sampleText, MAX_SAMPLE_TEXT_LENGTH, DEFAULT_SAMPLE_TEXT)
  const displayName = cleanText(raw.displayName || raw.name, MAX_DISPLAY_NAME_LENGTH, `${personaName || id} 克隆音色`)
  return {
    id,
    personaName,
    displayName,
    description: cleanText(raw.description, MAX_DESCRIPTION_LENGTH),
    filename,
    mimeType: raw.mimeType || fileInfo?.mimeType || getAudioMimeFromFilename(filename),
    size: Number(fileInfo?.size ?? raw.size ?? 0) || 0,
    mtime: Number(fileInfo?.mtime ?? raw.mtime ?? 0) || 0,
    sampleText,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    missing: !!fileInfo?.missing,
  }
}

function inferPersonaName(baseName, personaConfigs = []) {
  const bySafeName = personaConfigs.find(item => sanitizeVoiceAssetId(item.name) === baseName)
  return bySafeName?.name || baseName
}

function listVoiceAssetFiles() {
  try {
    return fs.readdirSync(VOICES_DIR)
      .map(filename => getVoiceFileInfo(filename))
      .filter(info => info && !info.missing)
  } catch {
    return []
  }
}

function listVoiceAssets(personaConfigs = []) {
  const files = new Map(listVoiceAssetFiles().map(info => [info.filename, info]))
  const seenFiles = new Set()
  const assets = []

  for (const raw of readStoreAssets()) {
    const filename = sanitizeVoiceFilename(raw.filename)
    if (!filename) continue
    const fileInfo = files.get(filename) || getVoiceFileInfo(filename)
    seenFiles.add(filename)
    assets.push(normalizeVoiceAsset(raw, fileInfo))
  }

  for (const [filename, fileInfo] of files) {
    if (seenFiles.has(filename)) continue
    const baseName = path.basename(filename, path.extname(filename))
    const personaName = inferPersonaName(baseName, personaConfigs)
    assets.push(normalizeVoiceAsset({
      id: baseName,
      personaName,
      displayName: `${personaName} 克隆音色`,
      filename,
      sampleText: DEFAULT_SAMPLE_TEXT,
    }, fileInfo))
  }

  return assets.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.displayName.localeCompare(b.displayName))
}

function findVoiceAsset(assetIdOrName, personaConfigs = []) {
  const raw = String(assetIdOrName || '').trim()
  const safe = sanitizeVoiceAssetId(raw)
  return listVoiceAssets(personaConfigs).find(asset =>
    asset.id === raw ||
    asset.id === safe ||
    asset.filename === raw ||
    asset.personaName === raw ||
    path.basename(asset.filename, path.extname(asset.filename)) === safe
  ) || null
}

function upsertVoiceAsset(meta = {}) {
  const filename = sanitizeVoiceFilename(meta.filename)
  const fileInfo = getVoiceFileInfo(filename)
  if (!filename || !fileInfo || fileInfo.missing) throw new Error('音色样本文件不存在')
  const now = new Date().toISOString()
  const existing = readStoreAssets().map(item => normalizeVoiceAsset(item))
  const previousByFile = existing.find(item => item.filename === filename)
  const id = meta.id
    ? sanitizeVoiceAssetId(meta.id)
    : previousByFile?.id || createVoiceAssetId(meta.personaName || path.basename(filename, path.extname(filename)), existing)
  const previous = existing.find(item => item.id === id || item.filename === filename) || {}
  const asset = normalizeVoiceAsset({
    ...previous,
    ...meta,
    id,
    filename,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  }, fileInfo)
  writeStoreAssets(existing.filter(item => item.id !== asset.id && item.filename !== asset.filename).concat(asset))
  return asset
}

function listVoiceAssetReferences(assetOrId, personaConfigs = []) {
  const asset = typeof assetOrId === 'object' && assetOrId ? assetOrId : findVoiceAsset(assetOrId, personaConfigs)
  if (!asset) return []
  const legacyId = sanitizeVoiceAssetId(asset.personaName)
  return personaConfigs.filter(config => {
    if (!config || config.voice !== '__cloned__') return false
    if (config.voiceAssetId) return config.voiceAssetId === asset.id
    return config.name === asset.personaName || asset.id === legacyId
  }).map(config => config.name).filter(Boolean)
}

function updateVoiceAssetMetadata(assetIdOrName, patch = {}, personaConfigs = []) {
  const current = findVoiceAsset(assetIdOrName, personaConfigs)
  if (!current) return null
  return upsertVoiceAsset({
    ...current,
    displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
    description: patch.description !== undefined ? patch.description : current.description,
    sampleText: patch.sampleText !== undefined ? patch.sampleText : current.sampleText,
  })
}

function deleteVoiceAsset(assetIdOrName, personaConfigs = []) {
  const asset = findVoiceAsset(assetIdOrName, personaConfigs)
  if (!asset) return null
  const deleted = []
  const filePath = getVoiceFilePath(asset.filename)
  if (filePath) {
    try { fs.unlinkSync(filePath); deleted.push(asset.filename) } catch {}
  }
  const existing = readStoreAssets().map(item => normalizeVoiceAsset(item))
  writeStoreAssets(existing.filter(item => item.id !== asset.id && item.filename !== asset.filename))
  return { asset, deleted }
}

function resolveVoiceSampleFile(personaName, voiceAssetId = '') {
  const asset = voiceAssetId
    ? findVoiceAsset(voiceAssetId, [{ name: personaName }])
    : findVoiceAsset(personaName, [{ name: personaName }])
  const info = asset ? getVoiceFileInfo(asset.filename) : null
  if (!info || info.missing) return null
  if (info.size < MIN_VOICE_SAMPLE_BYTES || info.size > MAX_VOICE_SAMPLE_BYTES) return null
  return { ...asset, ...info }
}

module.exports = {
  sanitizeVoiceAssetId,
  createVoiceAssetId,
  buildVoiceAssetFilename,
  getAudioExtFromMime,
  getAudioMimeFromFilename,
  listVoiceAssets,
  findVoiceAsset,
  listVoiceAssetReferences,
  upsertVoiceAsset,
  updateVoiceAssetMetadata,
  deleteVoiceAsset,
  resolveVoiceSampleFile,
  DEFAULT_SAMPLE_TEXT,
  MAX_VOICE_SAMPLE_BYTES,
  MIN_VOICE_SAMPLE_BYTES,
}
