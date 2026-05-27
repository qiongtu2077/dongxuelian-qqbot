/**
 * MODULE: 罕见触发固定语音。
 * 职责: 读取插件资源 MP4 → 转码 WAV 缓存 → 返回可发送音频 Buffer。
 * 边界: 不发送消息、不生成文字、不写对话历史。
 * 状态: WAV 文件缓存落在运行数据目录。
 */
const fs = require('fs')
const path: typeof import('path') = require('path')
const { execFile } = require('child_process')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')

const RARE_VOICE_RATE = 0.5
const RARE_VOICE_ASSET_DIR = path.resolve(__dirname, '..', 'assets')
const RARE_VOICE_PREFERRED_FILE = 'rare-voice.mp4'
const RARE_VOICE_CACHE_DIR = path.join(DATA_DIR, 'rare-voice')
const RARE_VOICE_WAV_CACHE = path.join(RARE_VOICE_CACHE_DIR, 'rare-voice.wav')
const MAX_RARE_VOICE_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_RARE_VOICE_WAV_BYTES = 2 * 1024 * 1024
const CONVERT_TIMEOUT_MS = 15000

/** 判断本次罕见触发是否走固定语音分支。 */
function shouldTriggerRareVoice(meta: { rareConfirmed?: boolean } = {}, random: () => number = Math.random): boolean {
  return Boolean(meta.rareConfirmed) && random() < RARE_VOICE_RATE
}

/** 找到固定语音 MP4；优先固定文件名，否则使用资源目录里唯一的 MP4。 */
function resolveRareVoiceSource(): string | null {
  const preferred = path.join(RARE_VOICE_ASSET_DIR, RARE_VOICE_PREFERRED_FILE)
  if (isUsableSource(preferred)) return preferred

  let entries = []
  try {
    entries = fs.readdirSync(RARE_VOICE_ASSET_DIR)
  } catch { /* non-critical: rare voice asset directory is optional */
    return null
  }
  const mp4Files = entries
    .filter(name => /\.mp4$/i.test(name))
    .map(name => path.join(RARE_VOICE_ASSET_DIR, name))
    .filter(isUsableSource)
  return mp4Files.length === 1 ? mp4Files[0] : null
}

/** 判断源文件是否存在且大小在转码保护范围内。 */
function isUsableSource(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_RARE_VOICE_SOURCE_BYTES
  } catch { /* non-critical: unavailable source falls back to text reply */
    return false
  }
}

/** 判断 WAV 缓存是否可直接复用。 */
function isCacheFresh(sourcePath: string, cachePath: string): boolean {
  try {
    const sourceStat = fs.statSync(sourcePath)
    const cacheStat = fs.statSync(cachePath)
    return cacheStat.isFile() && cacheStat.size > 44 && cacheStat.mtimeMs >= sourceStat.mtimeMs
  } catch { /* non-critical: stale or missing cache will be regenerated */
    return false
  }
}

/** 将 MP4 源文件转成 Koishi record 更稳定接收的 16k 单声道 WAV。 */
function convertMp4ToWav(sourcePath: string, cachePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    } catch { /* non-critical: conversion cache directory unavailable */
      return resolve(false)
    }
    execFile('ffmpeg', ['-y', '-i', sourcePath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', cachePath], { timeout: CONVERT_TIMEOUT_MS }, (err) => {
      if (err) return resolve(false)
      resolve(isUsableWav(cachePath))
    })
  })
}

/** 判断转码产物是否具备基本 WAV 文件特征。 */
function isUsableWav(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 44
  } catch { /* non-critical: unavailable wav falls back to text reply */
    return false
  }
}

/** 准备可发送的固定语音 WAV 缓存路径。 */
async function prepareRareVoiceWav(): Promise<string | null> {
  const sourcePath = resolveRareVoiceSource()
  if (!sourcePath) return null
  if (isCacheFresh(sourcePath, RARE_VOICE_WAV_CACHE)) return RARE_VOICE_WAV_CACHE
  const converted = await convertMp4ToWav(sourcePath, RARE_VOICE_WAV_CACHE)
  return converted ? RARE_VOICE_WAV_CACHE : null
}

/** 读取可发送的罕见固定语音 Buffer；失败时返回 null 交给文字回复回退。 */
async function readRareVoiceAudioBuffer(): Promise<Buffer | null> {
  try {
    const wavPath = await prepareRareVoiceWav()
    if (!wavPath) return null
    const stat = fs.statSync(wavPath)
    if (!stat.isFile() || stat.size <= 44 || stat.size > MAX_RARE_VOICE_WAV_BYTES) return null
    return fs.readFileSync(wavPath)
  } catch { /* non-critical: rare voice send path can fall back to text */
    return null
  }
}

export = {
  shouldTriggerRareVoice,
  readRareVoiceAudioBuffer,
  resolveRareVoiceSource,
  prepareRareVoiceWav,
  RARE_VOICE_RATE,
  RARE_VOICE_ASSET_DIR,
  RARE_VOICE_PREFERRED_FILE,
  RARE_VOICE_WAV_CACHE,
  MAX_RARE_VOICE_WAV_BYTES,
}
