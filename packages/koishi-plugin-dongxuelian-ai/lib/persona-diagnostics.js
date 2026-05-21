/**
 * MODULE: 人格资源只读诊断扫描。
 * 职责: 扫描 core/modes/personas/lore 文档，定位 schema、lore、voice 引用问题。
 * 边界: 不写文件、不修改人格、不接管聊天/语音行为。
 * 状态: 无。
 */
const fs = require('fs')
const path = require('path')
const {
  SKILLS_CORE_DIR,
  SKILLS_MODES_DIR,
  SKILLS_PERSONAS_DIR,
  SKILLS_LORE_DIR,
} = require('./constants')
const { parsePersonaDocument, createPersonaDiagnostic, parsePersonaStringList } = require('./persona-schema')
const { resolveVoiceSampleFile } = require('./voice-assets')

const PERSONA_DIAGNOSTIC_SCAN_DIRS = Object.freeze([
  ['core', SKILLS_CORE_DIR],
  ['mode', SKILLS_MODES_DIR],
  ['persona', SKILLS_PERSONAS_DIR],
  ['lore', SKILLS_LORE_DIR],
])
const PERSONA_SKILL_FILE_RE = /^SKILL(\.[^.]+)?\.md$/i
const MAX_PERSONA_DIAGNOSTIC_FILE_BYTES = 512 * 1024

function readPersonaDiagnosticText(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_PERSONA_DIAGNOSTIC_FILE_BYTES) return ''
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function listPersonaDiagnosticFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && PERSONA_SKILL_FILE_RE.test(entry.name))
      .map(entry => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  } catch {
    return []
  }
}

function getPersonaDocumentName(doc = {}) {
  const metaName = doc.meta && doc.meta.name ? String(doc.meta.name).trim() : ''
  if (metaName) return metaName
  const base = path.basename(doc.file || '', '.md').replace(/^SKILL\.?/i, '')
  return base || ''
}

function getDiagnosticLoreRefs(meta = {}) {
  const refs = []
  for (const field of ['lore', 'lore_refs']) {
    const list = parsePersonaStringList(meta[field])
    for (const item of list) {
      if (item && !refs.includes(item)) refs.push(item)
    }
  }
  return refs
}

function buildPersonaDiagnosticIndexes(documents = []) {
  const loreByName = new Map()
  const docsByName = new Map()
  for (const doc of documents) {
    const name = getPersonaDocumentName(doc)
    if (!name) continue
    if (!docsByName.has(name)) docsByName.set(name, [])
    docsByName.get(name).push(doc)
    if (doc.type === 'lore') loreByName.set(name, doc)
  }
  return { loreByName, docsByName }
}

function addCrossDocumentDiagnostics(documents = [], options = {}) {
  const { loreByName, docsByName } = buildPersonaDiagnosticIndexes(documents)
  for (const [name, docs] of docsByName) {
    if (docs.length <= 1) continue
    for (const doc of docs) {
      doc.diagnostics.push(createPersonaDiagnostic('warning', 'duplicate_persona_name', `存在重复人格/资源名称：${name}。`, { field: 'name' }))
    }
  }
  for (const doc of documents) {
    if (doc.type === 'persona' || doc.type === 'mode' || doc.type === 'core') {
      const refs = getDiagnosticLoreRefs(doc.meta)
      for (const ref of refs) {
        if (!loreByName.has(ref)) {
          doc.diagnostics.push(createPersonaDiagnostic('warning', 'missing_lore_ref', `引用的 lore 不存在：${ref}。`, { field: doc.meta.lore === ref ? 'lore' : 'lore_refs' }))
        }
      }
    }
    if (doc.type === 'lore' && !doc.hasFrontmatter) {
      doc.diagnostics.push(createPersonaDiagnostic('warning', 'lore_missing_frontmatter', 'lore 文档缺少 frontmatter，后续无法可靠按名称引用。'))
    }
    const voiceId = doc.meta.voice_id || doc.meta.voice || ''
    const voiceAssetId = doc.meta.voice_asset_id || ''
    if (doc.type === 'persona' && (voiceId === '__cloned__' || voiceAssetId)) {
      const sample = typeof options.resolveVoiceSampleFile === 'function'
        ? options.resolveVoiceSampleFile(getPersonaDocumentName(doc), voiceAssetId)
        : null
      if (!sample) {
        doc.diagnostics.push(createPersonaDiagnostic('warning', 'missing_voice_asset', '克隆音色样本不存在或大小不符合要求，将回退默认音色。', { field: voiceAssetId ? 'voice_asset_id' : 'voice_id' }))
      }
    }
  }
}

function summarizePersonaDiagnostics(documents = []) {
  const totals = { error: 0, warning: 0, info: 0 }
  for (const doc of documents) {
    for (const item of doc.diagnostics || []) {
      if (totals[item.level] !== undefined) totals[item.level]++
    }
  }
  return {
    totalDocuments: documents.length,
    totals,
    byType: documents.reduce((acc, doc) => {
      acc[doc.type] = (acc[doc.type] || 0) + 1
      return acc
    }, {}),
  }
}

function scanPersonaDocuments(options = {}) {
  const scanDirs = Array.isArray(options.scanDirs) ? options.scanDirs : PERSONA_DIAGNOSTIC_SCAN_DIRS
  const documents = []
  for (const [type, dir] of scanDirs) {
    for (const file of listPersonaDiagnosticFiles(dir)) {
      const content = readPersonaDiagnosticText(file)
      if (!content) {
        documents.push({
          type,
          file,
          schemaVersion: 0,
          hasFrontmatter: false,
          meta: {},
          rawMeta: {},
          body: '',
          diagnostics: [createPersonaDiagnostic('warning', 'unreadable_persona_file', '人格资源文件为空、过大或不可读。')],
          warnings: [],
        })
        continue
      }
      documents.push(parsePersonaDocument(content, { type, file }))
    }
  }
  addCrossDocumentDiagnostics(documents, {
    resolveVoiceSampleFile: options.resolveVoiceSampleFile || resolveVoiceSampleFile,
  })
  for (const doc of documents) doc.warnings = doc.diagnostics
  return {
    ok: !documents.some(doc => doc.diagnostics.some(item => item.level === 'error')),
    documents,
    summary: summarizePersonaDiagnostics(documents),
  }
}

function formatPersonaDiagnosticReport(result = {}) {
  const documents = Array.isArray(result.documents) ? result.documents : []
  const summary = result.summary || summarizePersonaDiagnostics(documents)
  const lines = [
    `人格扫描：${summary.totalDocuments || 0} 个文件，error=${summary.totals?.error || 0} warning=${summary.totals?.warning || 0} info=${summary.totals?.info || 0}`,
  ]
  for (const doc of documents) {
    const diagnostics = doc.diagnostics || []
    if (!diagnostics.length) continue
    lines.push(`- ${doc.type}:${getPersonaDocumentName(doc) || path.basename(doc.file || '')}`)
    for (const item of diagnostics) {
      lines.push(`  [${item.level}] ${item.code}: ${item.message}`)
    }
  }
  return lines.join('\n')
}

module.exports = {
  PERSONA_DIAGNOSTIC_SCAN_DIRS,
  PERSONA_SKILL_FILE_RE,
  MAX_PERSONA_DIAGNOSTIC_FILE_BYTES,
  readPersonaDiagnosticText,
  listPersonaDiagnosticFiles,
  getPersonaDocumentName,
  getDiagnosticLoreRefs,
  buildPersonaDiagnosticIndexes,
  addCrossDocumentDiagnostics,
  summarizePersonaDiagnostics,
  scanPersonaDocuments,
  formatPersonaDiagnosticReport,
}
