/**
 * MODULE: 表情包学习/发送旁路诊断（shadow，仅日志）。
 * 职责: 复现“收到图是否会进入观察池”和“回复时会挑哪张种子表情”的决策现场。
 * 边界: 不写真正表情库、不调 VLM、不发送图片、不改 prompt、不改概率。
 */
const crypto = require('crypto')
const fsp = require('fs/promises')
const path: typeof import('path') = require('path')
const { DATA_DIR, STICKER_DIR } = require('../core/constants') as typeof import('../core/constants')

type StickerDict = Record<string, unknown>
type StickerShadowDecision = string

interface StickerSegment extends StickerDict {
  type?: string
  attributes?: StickerDict
  attrs?: StickerDict
  data?: StickerDict
  children?: StickerSegment[]
  elements?: StickerSegment[]
  content?: unknown
}

interface StickerSession {
  content?: string
  guildId?: string
  channelId?: string
  userId?: string
  username?: string
  selfId?: string
  messageId?: string
  author?: { id?: string }
  bot?: { selfId?: string }
}

interface StickerVisualInfo {
  kind: string
  hasVisual: boolean
  hasImage: boolean
  hasMface: boolean
  hasFace: boolean
  hasVideo: boolean
  hasUrl: boolean
  hasFileRef: boolean
  hasEmbed: boolean
  hasFileMessage: boolean
  isGif: boolean
  stickerLike: boolean
  ext: string
  refHash: string
  segmentTypes: string[]
}

interface StickerVisualRef {
  type: string
  url: string
  file: string
}

interface StickerShadowInput extends StickerDict {
  session?: StickerSession
  analyzed?: { hasVisual?: boolean; hasEmbed?: boolean; hasFile?: boolean }
  content?: string
  segments?: StickerSegment[]
  channelKey?: string
  userId?: string
  selfId?: string
  messageId?: string
  now?: number
  minOccurrences?: number
  minContributors?: number
  personaName?: string
  sendOptions?: { stickerShadowContext?: { personaName?: string; affectDiagnostic?: AffectDiagnostic } }
  replyText?: string
  reply?: string
  isRandom?: boolean
  affectDiagnostic?: AffectDiagnostic
}

interface AffectDiagnostic {
  mood?: string
  recommendedMode?: string
  blockers?: string[]
  outputs?: {
    emoji?: { allowed?: boolean }
  }
}

interface SeedIndexEntry {
  fileHash: string
  labelHash: string
  labelSample: string
  ext: string
  size: number
}

interface SeedIndex {
  seedDirHash: string
  seedCount: number
  stickers: SeedIndexEntry[]
}

interface ScoredSeed extends SeedIndexEntry {
  score: number
  reasons: string[]
}

interface StickerShadowLogOptions {
  file?: string
  rootDir?: string
  loggedAt?: number
  seedDir?: string
  limit?: number
}

const STICKER_SHADOW_VERSION = 1
const STICKER_SHADOW_LOG_DIR = path.join(DATA_DIR, 'sticker-diagnostics')
const STICKER_SHADOW_LOG_MAX_BYTES = 2 * 1024 * 1024
const STICKER_SHADOW_MAX_SEED_FILES = 200
const STICKER_SHADOW_MAX_CANDIDATES = 5
const STICKER_SHADOW_ALLOWED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

const STICKER_SHADOW_DECISIONS = Object.freeze({
  skipNoVisual: 'skip_no_visual',
  skipAssistant: 'skip_assistant_message',
  skipBuiltinFace: 'skip_builtin_face',
  skipGif: 'skip_gif_until_vetter_policy',
  skipEmbed: 'skip_embed_or_file',
  skipMissingRef: 'skip_missing_image_ref',
  observePending: 'observe_pending_if_enabled',
  sendSkipEmpty: 'skip_empty_reply',
  sendNoCandidate: 'no_seed_candidate',
  sendMarkerNoCandidate: 'no_seed_candidate_for_marker',
  sendAffectBlocked: 'would_pick_but_affect_blocks',
  sendExplicit: 'would_send_seed_if_enabled',
  sendProbabilityGate: 'would_enter_probability_gate_if_enabled',
})

const STICKER_SHADOW_REPLY_HINTS = Object.freeze([
  { re: /哈哈|笑死|搞笑|好笑|绷|乐|草/, tags: ['搞笑', '憋笑', '开心'] },
  { re: /开心|高兴|喜欢|好耶|牛|厉害/, tags: ['开心', '喜欢', '厉害'] },
  { re: /哭|难过|寄了|不想活|急|委屈/, tags: ['哭哭', '难过', '急哭', '寄了'] },
  { re: /无语|汗|尬|离谱|懵/, tags: ['无语', '无语流汗', '懵逼'] },
  { re: /生气|红温|气|打你|欠揍/, tags: ['小生气', '红温', '连续打你', '群友欠揍'] },
  { re: /摸鱼|摆烂|考试|不及格/, tags: ['摸鱼', '摆烂', '考试不及格'] },
])

const STICKER_SHADOW_MOOD_HINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  playful: ['搞笑', '憋笑', '开心'],
  comfort: ['哭哭', '难过', '喜欢'],
  serious: [],
  neutral: [],
  refuse: [],
})

let stickerShadowLogChain: Promise<unknown> = Promise.resolve()

function ignoreStickerShadowRotationFailure(error: unknown): void {
  void error
}

function stickerShadowHashValue(value: unknown = '', length: number = 12): string {
  const text = String(value == null ? '' : value).trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, Math.max(6, Math.min(32, Number(length) || 12)))
}

function stickerShadowSanitizeSample(value: unknown = '', maxLength: number = 160): string {
  return String(value == null ? '' : value)
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/file:\/\/\S+/gi, '<file>')
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, '<local-path>')
    .replace(/\[CQ:(image|img|mface|video|file),[^\]]+\]/gi, '[CQ:$1]')
    .replace(/<(img|image|mface|video|file)\b[^>]*>/gi, '<$1>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(20, Math.min(1000, Number(maxLength) || 160)))
}

function stickerShadowNormalizeAtom(value: unknown = '', maxLength: number = 40): string {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, Math.max(4, Math.min(120, Number(maxLength) || 40)))
}

function stickerShadowFormatList(values: unknown[] = [], fallback: string = 'none'): string {
  const list = Array.isArray(values) ? values.map(item => stickerShadowNormalizeAtom(item, 40)).filter(Boolean) : []
  return list.length ? list.join(',') : fallback
}

function stickerShadowSegmentData(segment: StickerSegment = {}): StickerDict {
  return Object.assign({}, segment.attributes || {}, segment.attrs || {}, segment.data || {})
}

function stickerShadowSegmentChildren(segment: StickerSegment = {}): StickerSegment[] {
  const data = stickerShadowSegmentData(segment)
  for (const value of [data.content, data.children, data.elements, segment.children, segment.elements, segment.content]) {
    if (Array.isArray(value)) return value as StickerSegment[]
  }
  return []
}

function stickerShadowFlattenSegments(segments: StickerSegment[] = [], out: StickerSegment[] = [], depth: number = 0): StickerSegment[] {
  if (!Array.isArray(segments) || depth > 4) return out
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue
    out.push(segment)
    stickerShadowFlattenSegments(stickerShadowSegmentChildren(segment), out, depth + 1)
  }
  return out
}

function stickerShadowExtractContentAttr(content: string = '', attr: string = ''): string {
  const re = new RegExp(`${attr}=["']([^"']+)["']`, 'i')
  const match = String(content || '').match(re)
  return match ? match[1] : ''
}

function stickerShadowExtractCqValue(content: string = '', key: string = ''): string {
  const re = new RegExp(`${key}=([^,\\]]+)`, 'i')
  const match = String(content || '').match(re)
  return match ? match[1] : ''
}

function stickerShadowGuessExt(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || '').split(/[?#]/)[0]
    const ext = path.extname(text).toLowerCase()
    if (STICKER_SHADOW_ALLOWED_EXTS.has(ext)) return ext.slice(1)
  }
  return ''
}

function stickerShadowInferVisual(input: StickerShadowInput = {}): StickerVisualInfo {
  const analyzed = input.analyzed || {}
  const content = String(input.content || input.session?.content || '')
  const segments = stickerShadowFlattenSegments(input.segments || [])
  const segmentTypes = [...new Set(segments.map(seg => String(seg?.type || '').trim()).filter(Boolean))].slice(0, 16)
  const typeSet = new Set(segmentTypes)
  const refs: StickerVisualRef[] = []

  for (const segment of segments) {
    const type = String(segment?.type || '')
    if (!['image', 'img', 'mface', 'face', 'video'].includes(type)) continue
    const data = stickerShadowSegmentData(segment)
    refs.push({
      type,
      url: String(data.url || data.src || data.href || ''),
      file: String(data.file || data.id || data.file_id || data.fileId || data.name || ''),
    })
  }

  if (/\[CQ:(?:image|img|mface|face|video),/i.test(content) || /<(?:img|image|mface|face|video)\b/i.test(content)) {
    refs.push({
      type: (content.match(/\[CQ:(image|img|mface|face|video),/i) || content.match(/<(img|image|mface|face|video)\b/i) || [])[1] || 'content',
      url: stickerShadowExtractContentAttr(content, 'src') || stickerShadowExtractContentAttr(content, 'url') || stickerShadowExtractCqValue(content, 'url'),
      file: stickerShadowExtractContentAttr(content, 'file') || stickerShadowExtractCqValue(content, 'file'),
    })
  }

  const refText = refs.map(ref => [ref.type, ref.url, ref.file].join(':')).join('|')
  const hasImage = typeSet.has('image') || typeSet.has('img') || /\[CQ:(?:image|img),|<(?:img|image)\b/i.test(content)
  const hasMface = typeSet.has('mface') || /\[CQ:mface,|<mface\b|QQ表情包/i.test(content)
  const hasFace = typeSet.has('face') || /\[CQ:face,|<face\b|QQ表情：/i.test(content)
  const hasVideo = typeSet.has('video') || /\[CQ:video,|<video\b/i.test(content)
  const hasUrl = refs.some(ref => /^https?:\/\//i.test(ref.url)) || /https?:\/\//i.test(content)
  const hasFileRef = refs.some(ref => !!ref.file) || /\bfile=|file:\/\//i.test(content)
  const ext = stickerShadowGuessExt(refText, content)
  const isGif = ext === 'gif' || /gif/i.test(refText)
  const stickerLike = hasMface || /Qzone|Emoji|Sticker|mface/i.test(content) || (isGif && !hasVideo)
  const hasVisual = !!(analyzed.hasVisual || hasImage || hasMface || hasFace || hasVideo)
  let kind = 'none'
  if (hasMface) kind = 'qq_mface'
  else if (hasFace && !hasImage && !hasVideo) kind = 'qq_face'
  else if (hasVideo) kind = 'video_visual'
  else if (isGif) kind = 'gif_image'
  else if (hasImage) kind = 'image'
  else if (hasVisual) kind = 'visual_unknown'

  return {
    kind,
    hasVisual,
    hasImage,
    hasMface,
    hasFace,
    hasVideo,
    hasUrl,
    hasFileRef,
    hasEmbed: !!analyzed.hasEmbed,
    hasFileMessage: !!analyzed.hasFile,
    isGif,
    stickerLike,
    ext,
    refHash: stickerShadowHashValue(refText || content),
    segmentTypes,
  }
}

function buildStickerShadowIngestPlan(input: StickerShadowInput = {}): StickerDict {
  const session = input.session || {}
  const channelKey = String(input.channelKey || session.guildId || session.channelId || '').trim()
  const userId = String(input.userId || session.userId || session.author?.id || session.username || '').trim()
  const selfId = String(input.selfId || session.selfId || session.bot?.selfId || '').trim()
  const messageId = String(input.messageId || session.messageId || '').trim()
  const visual = stickerShadowInferVisual(input)
  const sourceRole = selfId && userId && selfId === userId ? 'assistant' : 'user'
  const reasons: string[] = []
  let decision: StickerShadowDecision = STICKER_SHADOW_DECISIONS.observePending

  if (!visual.hasVisual) {
    decision = STICKER_SHADOW_DECISIONS.skipNoVisual
    reasons.push('no_visual_feature')
  } else if (sourceRole === 'assistant') {
    decision = STICKER_SHADOW_DECISIONS.skipAssistant
    reasons.push('assistant_output_not_learning_source')
  } else if (visual.hasEmbed || visual.hasFileMessage) {
    decision = STICKER_SHADOW_DECISIONS.skipEmbed
    reasons.push(visual.hasEmbed ? 'embed_message' : 'file_message')
  } else if (visual.kind === 'qq_face') {
    decision = STICKER_SHADOW_DECISIONS.skipBuiltinFace
    reasons.push('built_in_face_has_no_image_asset')
  } else if (visual.isGif) {
    decision = STICKER_SHADOW_DECISIONS.skipGif
    reasons.push('gif_policy_requires_later_review')
  } else if (!visual.hasUrl && !visual.hasFileRef && !visual.refHash) {
    decision = STICKER_SHADOW_DECISIONS.skipMissingRef
    reasons.push('missing_replayable_image_reference')
  } else {
    reasons.push(visual.stickerLike ? 'sticker_like_visual' : 'normal_image_observed')
  }

  const wouldObserve = decision === STICKER_SHADOW_DECISIONS.observePending
  return {
    type: 'sticker_shadow_ingest_v1',
    version: STICKER_SHADOW_VERSION,
    ts: Number(input.now) || Date.now(),
    mode: 'shadow_only',
    prompt: 'unchanged',
    send: 'unchanged',
    channelHash: stickerShadowHashValue(channelKey),
    userHash: stickerShadowHashValue(userId),
    messageHash: stickerShadowHashValue(messageId),
    sourceRole,
    contentHash: stickerShadowHashValue(input.content || session.content || ''),
    contentSample: stickerShadowSanitizeSample(input.content || session.content || '', 180),
    visual,
    decision,
    reasons,
    thresholds: {
      minOccurrences: Math.max(1, Number(input.minOccurrences) || 2),
      minContributors: Math.max(1, Number(input.minContributors) || 2),
    },
    simulated: {
      wouldWritePending: wouldObserve,
      wouldIncrementOccurrences: wouldObserve,
      wouldCallVlmNow: false,
      wouldCallVlmAfterThreshold: wouldObserve,
      wouldPromoteNow: false,
      wouldSend: false,
      wouldMutatePrompt: false,
    },
  }
}

function formatStickerShadowIngestDiagnostic(plan: StickerDict = {}): string {
  const visual = (plan.visual && typeof plan.visual === 'object' ? plan.visual : {}) as Partial<StickerVisualInfo>
  const simulated = (plan.simulated && typeof plan.simulated === 'object' ? plan.simulated : {}) as {
    wouldWritePending?: boolean
    wouldCallVlmNow?: boolean
    wouldCallVlmAfterThreshold?: boolean
  }
  const reasons = Array.isArray(plan.reasons) ? plan.reasons : []
  return [
    'sticker_shadow_ingest',
    `v=${Math.max(0, Math.floor(Number(plan.version) || 0))}`,
    `decision=${stickerShadowNormalizeAtom(plan.decision || 'unknown', 60)}`,
    `channel=${plan.channelHash || 'none'}`,
    `user=${plan.userHash || 'none'}`,
    `message=${plan.messageHash || 'none'}`,
    `kind=${stickerShadowNormalizeAtom(visual.kind || 'none', 30)}`,
    `stickerLike=${visual.stickerLike === true}`,
    `ref=${visual.refHash || 'none'}`,
    `segments=${stickerShadowFormatList(visual.segmentTypes || [])}`,
    `pending=${simulated.wouldWritePending === true}`,
    `vlmNow=${simulated.wouldCallVlmNow === true}`,
    `vlmAfterThreshold=${simulated.wouldCallVlmAfterThreshold === true}`,
    `reasons=${stickerShadowFormatList(reasons)}`,
    'mode=shadow_only',
    'prompt=unchanged',
    'send=unchanged',
  ].join(' ')
}

function stickerShadowExtractMarkers(replyText: string = ''): string[] {
  const markers: string[] = []
  const re = /\[图:(.+?)\]/g
  let match
  while ((match = re.exec(String(replyText || '')))) {
    const marker = stickerShadowNormalizeAtom(match[1], 40)
    if (marker) markers.push(marker)
  }
  return markers.slice(0, 8)
}

function stickerShadowDeriveQueryAtoms(replyText: string = '', affectDiagnostic: AffectDiagnostic = {}): string[] {
  const text = String(replyText || '')
  const atoms: string[] = []
  for (const item of STICKER_SHADOW_REPLY_HINTS) {
    if (item.re.test(text)) atoms.push(...item.tags)
  }
  const mood = stickerShadowNormalizeAtom(affectDiagnostic?.mood || '', 20)
  if (mood && STICKER_SHADOW_MOOD_HINTS[mood]) atoms.push(...STICKER_SHADOW_MOOD_HINTS[mood])
  return [...new Set(atoms.map(item => stickerShadowNormalizeAtom(item, 30)).filter(Boolean))].slice(0, 12)
}

async function loadStickerShadowSeedIndex(options: StickerShadowLogOptions = {}): Promise<SeedIndex> {
  const seedDir = options.seedDir || STICKER_DIR
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || STICKER_SHADOW_MAX_SEED_FILES))
  let entries: Array<{ name: string; isFile(): boolean }> = []
  try {
    entries = await fsp.readdir(seedDir, { withFileTypes: true })
  } catch { /* non-critical: missing seed directory means no sticker candidates */
    return { seedDirHash: stickerShadowHashValue(seedDir), seedCount: 0, stickers: [] }
  }
  const stickers: SeedIndexEntry[] = []
  for (const entry of entries.slice(0, limit)) {
    if (!entry || !entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!STICKER_SHADOW_ALLOWED_EXTS.has(ext)) continue
    const filePath = path.join(seedDir, entry.name)
    let size = 0
    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) continue
      size = stat.size
    } catch { /* non-critical: individual seed files can disappear during scan */
      continue
    }
    const label = stickerShadowNormalizeAtom(path.basename(entry.name, ext), 60)
    stickers.push({
      fileHash: stickerShadowHashValue(entry.name),
      labelHash: stickerShadowHashValue(label),
      labelSample: label,
      ext: ext.slice(1),
      size,
    })
  }
  return {
    seedDirHash: stickerShadowHashValue(seedDir),
    seedCount: stickers.length,
    stickers,
  }
}

function stickerShadowScoreSeed(seed: Partial<SeedIndexEntry> = {}, context: { markers?: string[]; queryAtoms?: string[]; replyText?: string } = {}): { score: number; reasons: string[] } {
  const label = String(seed.labelSample || '')
  const markers = context.markers || []
  const atoms = context.queryAtoms || []
  const replyText = String(context.replyText || '')
  const reasons = []
  let score = 0

  for (const marker of markers) {
    if (!marker) continue
    if (label === marker) {
      score += 100
      reasons.push('explicit_marker_exact')
    } else if (label.includes(marker) || marker.includes(label)) {
      score += 72
      reasons.push('explicit_marker_partial')
    }
  }

  if (!markers.length) {
    if (label && replyText.includes(label)) {
      score += 45
      reasons.push('reply_contains_label')
    }
    for (const atom of atoms) {
      if (!atom) continue
      if (label.includes(atom) || atom.includes(label)) {
        score += 28
        reasons.push('query_atom_match')
      }
    }
  }

  return { score, reasons: [...new Set(reasons)] }
}

async function buildStickerShadowSendPlan(input: StickerShadowInput = {}, options: StickerShadowLogOptions = {}): Promise<StickerDict> {
  const session = input.session || {}
  const channelKey = String(input.channelKey || session.guildId || session.channelId || '').trim()
  const userId = String(input.userId || session.userId || session.author?.id || session.username || '').trim()
  const messageId = String(input.messageId || session.messageId || '').trim()
  const personaName = stickerShadowNormalizeAtom(input.personaName || input.sendOptions?.stickerShadowContext?.personaName || '', 60)
  const replyText = String(input.replyText || input.reply || '')
  const affectDiagnostic = input.affectDiagnostic || input.sendOptions?.stickerShadowContext?.affectDiagnostic || null
  const markers = stickerShadowExtractMarkers(replyText)
  const queryAtoms = stickerShadowDeriveQueryAtoms(replyText, affectDiagnostic || {})
  const seedIndex = await loadStickerShadowSeedIndex(options)
  const scored: ScoredSeed[] = []

  for (const seed of seedIndex.stickers) {
    const scoredSeed = stickerShadowScoreSeed(seed, { markers, queryAtoms, replyText })
    if (scoredSeed.score <= 0) continue
    scored.push({
      fileHash: seed.fileHash,
      labelHash: seed.labelHash,
      labelSample: seed.labelSample,
      ext: seed.ext,
      size: seed.size,
      score: scoredSeed.score,
      reasons: scoredSeed.reasons,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.labelHash.localeCompare(b.labelHash))
  const candidates = scored.slice(0, STICKER_SHADOW_MAX_CANDIDATES).map((item, index) => ({ rank: index + 1, ...item }))
  const best = candidates[0] || null
  const affectEmojiAllowed = affectDiagnostic ? affectDiagnostic?.outputs?.emoji?.allowed === true : null
  const explicitMarker = markers.length > 0
  const autoCandidate = !explicitMarker && !!best
  let decision: StickerShadowDecision = STICKER_SHADOW_DECISIONS.sendNoCandidate
  const reasons: string[] = []

  if (!stickerShadowSanitizeSample(replyText, 20)) {
    decision = STICKER_SHADOW_DECISIONS.sendSkipEmpty
    reasons.push('empty_reply')
  } else if (explicitMarker && !best) {
    decision = STICKER_SHADOW_DECISIONS.sendMarkerNoCandidate
    reasons.push('explicit_marker_unmatched')
  } else if (!best) {
    decision = STICKER_SHADOW_DECISIONS.sendNoCandidate
    reasons.push('no_seed_match')
  } else if (affectEmojiAllowed === false) {
    decision = STICKER_SHADOW_DECISIONS.sendAffectBlocked
    reasons.push('affect_router_blocks_emoji')
  } else if (explicitMarker) {
    decision = STICKER_SHADOW_DECISIONS.sendExplicit
    reasons.push('explicit_marker_would_send')
  } else {
    decision = STICKER_SHADOW_DECISIONS.sendProbabilityGate
    reasons.push('reply_keyword_would_enter_existing_probability_gate')
  }

  return {
    type: 'sticker_shadow_send_v1',
    version: STICKER_SHADOW_VERSION,
    ts: Number(input.now) || Date.now(),
    mode: 'shadow_only',
    prompt: 'unchanged',
    send: 'unchanged',
    channelHash: stickerShadowHashValue(channelKey),
    userHash: stickerShadowHashValue(userId),
    messageHash: stickerShadowHashValue(messageId),
    personaHash: stickerShadowHashValue(personaName),
    personaSample: personaName,
    replyHash: stickerShadowHashValue(replyText),
    replySample: stickerShadowSanitizeSample(replyText, 220),
    replyLength: replyText.length,
    randomTriggered: !!input.isRandom,
    markers: markers.map(marker => ({ hash: stickerShadowHashValue(marker), sample: marker })),
    queryAtoms: queryAtoms.map(atom => ({ hash: stickerShadowHashValue(atom), sample: atom })),
    affect: affectDiagnostic ? {
      mood: stickerShadowNormalizeAtom(affectDiagnostic.mood || 'neutral', 30),
      emojiAllowed: affectEmojiAllowed,
      recommendedMode: stickerShadowNormalizeAtom(affectDiagnostic.recommendedMode || '', 30),
      blockers: Array.isArray(affectDiagnostic.blockers) ? affectDiagnostic.blockers.map(item => stickerShadowNormalizeAtom(item, 50)).filter(Boolean).slice(0, 8) : [],
    } : null,
    seedIndex: {
      seedDirHash: seedIndex.seedDirHash,
      seedCount: seedIndex.seedCount,
    },
    candidates,
    decision,
    reasons,
    probabilityGate: autoCandidate ? {
      source: 'reply.js_auto_keyword_shadow',
      probability: 0.3,
      evaluated: false,
      note: 'shadow_does_not_roll_random',
    } : null,
    simulated: {
      wouldCallSearch: false,
      wouldCallVlm: false,
      wouldSendIfEnabled: decision === STICKER_SHADOW_DECISIONS.sendExplicit,
      wouldEnterProbabilityGate: decision === STICKER_SHADOW_DECISIONS.sendProbabilityGate,
      sent: false,
      wouldMutatePrompt: false,
    },
  }
}

function formatStickerShadowSendDiagnostic(plan: StickerDict = {}): string {
  const best = Array.isArray(plan.candidates) && plan.candidates.length ? plan.candidates[0] as Partial<ScoredSeed> : null
  const seedIndex = (plan.seedIndex && typeof plan.seedIndex === 'object' ? plan.seedIndex : {}) as { seedCount?: number }
  const affect = (plan.affect && typeof plan.affect === 'object' ? plan.affect : {}) as { emojiAllowed?: boolean | null }
  const probabilityGate = (plan.probabilityGate && typeof plan.probabilityGate === 'object' ? plan.probabilityGate : null) as { source?: string } | null
  const simulated = (plan.simulated && typeof plan.simulated === 'object' ? plan.simulated : {}) as {
    wouldSendIfEnabled?: boolean
    wouldEnterProbabilityGate?: boolean
  }
  const reasons = Array.isArray(plan.reasons) ? plan.reasons : []
  return [
    'sticker_shadow_send',
    `v=${Math.max(0, Math.floor(Number(plan.version) || 0))}`,
    `decision=${stickerShadowNormalizeAtom(plan.decision || 'unknown', 60)}`,
    `channel=${plan.channelHash || 'none'}`,
    `user=${plan.userHash || 'none'}`,
    `persona=${plan.personaHash || 'none'}`,
    `random=${plan.randomTriggered === true}`,
    `markers=${Array.isArray(plan.markers) ? plan.markers.length : 0}`,
    `atoms=${Array.isArray(plan.queryAtoms) ? plan.queryAtoms.length : 0}`,
    `seed=${seedIndex.seedCount || 0}`,
    `candidates=${Array.isArray(plan.candidates) ? plan.candidates.length : 0}`,
    `best=${best ? best.labelHash : 'none'}`,
    `bestScore=${best ? best.score : 0}`,
    `affectEmoji=${affect.emojiAllowed === null || affect.emojiAllowed === undefined ? 'unknown' : String(affect.emojiAllowed)}`,
    `gate=${probabilityGate ? probabilityGate.source : 'none'}`,
    `wouldSend=${simulated.wouldSendIfEnabled === true}`,
    `wouldGate=${simulated.wouldEnterProbabilityGate === true}`,
    `reasons=${stickerShadowFormatList(reasons)}`,
    'mode=shadow_only',
    'prompt=unchanged',
    'send=unchanged',
  ].join(' ')
}

function sanitizeStickerShadowLogPlan(plan: StickerDict = {}): StickerDict {
  const clone = JSON.parse(JSON.stringify(plan || {}))
  if (clone.contentSample) clone.contentSample = stickerShadowSanitizeSample(clone.contentSample, 180)
  if (clone.replySample) clone.replySample = stickerShadowSanitizeSample(clone.replySample, 220)
  if (clone.personaSample) clone.personaSample = stickerShadowNormalizeAtom(clone.personaSample, 60)
  if (Array.isArray(clone.markers)) clone.markers = clone.markers.slice(0, 8)
  if (Array.isArray(clone.queryAtoms)) clone.queryAtoms = clone.queryAtoms.slice(0, 12)
  if (Array.isArray(clone.candidates)) clone.candidates = clone.candidates.slice(0, STICKER_SHADOW_MAX_CANDIDATES)
  return clone
}

function stickerShadowDate(ts: number = Date.now()): string {
  const date = new Date(Number(ts) || Date.now())
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getStickerShadowLogFile(ts: number = Date.now(), rootDir: string = STICKER_SHADOW_LOG_DIR): string {
  return path.join(rootDir || STICKER_SHADOW_LOG_DIR, `sticker-shadow-${stickerShadowDate(ts)}.jsonl`)
}

function buildStickerShadowLogEvent(plan: StickerDict = {}, options: StickerShadowLogOptions = {}): StickerDict {
  return {
    loggedAt: Number(options.loggedAt) || Date.now(),
    type: plan.type || 'sticker_shadow_unknown',
    version: Number(plan.version) || STICKER_SHADOW_VERSION,
    mode: 'shadow_only',
    plan: sanitizeStickerShadowLogPlan(plan),
  }
}

async function appendStickerShadowLog(plan: StickerDict = {}, options: StickerShadowLogOptions = {}): Promise<unknown> {
  const event = buildStickerShadowLogEvent(plan, options)
  const file = options.file || getStickerShadowLogFile(Number(plan.ts || event.loggedAt), options.rootDir)
  const entry = JSON.stringify(event) + '\n'
  const stickerShadowWriteTask = async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile() && stat.size > STICKER_SHADOW_LOG_MAX_BYTES) {
        await fsp.rename(file, `${file}.${Date.now()}.old`).catch(ignoreStickerShadowRotationFailure)
      }
    } catch { /* non-critical: log rotation stat/rename failure should not block diagnostics append */
    }
    await fsp.appendFile(file, entry, 'utf8')
    return { file, event }
  }
  stickerShadowLogChain = stickerShadowLogChain.then(stickerShadowWriteTask, stickerShadowWriteTask)
  return stickerShadowLogChain
}

export = {
  STICKER_SHADOW_VERSION,
  STICKER_SHADOW_LOG_DIR,
  STICKER_SHADOW_LOG_MAX_BYTES,
  STICKER_SHADOW_DECISIONS,
  stickerShadowHashValue,
  stickerShadowSanitizeSample,
  stickerShadowInferVisual,
  buildStickerShadowIngestPlan,
  formatStickerShadowIngestDiagnostic,
  loadStickerShadowSeedIndex,
  buildStickerShadowSendPlan,
  formatStickerShadowSendDiagnostic,
  getStickerShadowLogFile,
  buildStickerShadowLogEvent,
  appendStickerShadowLog,
}
