const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const AI_ROOT = path.join(ROOT, 'packages', 'koishi-plugin-dongxuelian-ai')
const AI_INDEX = path.join(AI_ROOT, 'lib', 'index.js')
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeText(file, value) {
  mkdirp(path.dirname(file))
  fs.writeFileSync(file, String(value), 'utf8')
}

function writeJson(file, value) {
  writeText(file, JSON.stringify(value))
}

function createStickerFiles(stickerDir) {
  mkdirp(stickerDir)
  for (const name of [
    '\u641e\u7b11.jpg',
    '\u5f00\u5fc3.png',
    '\u618b\u7b11.jpg',
    '\u4f60\u5728\u72d7\u53eb\u4ec0\u4e48.jpg',
    '\u8bf7\u4f60\u5403\u7c91\u7c91.jpg',
    '搞笑.jpg',
    '开心.png',
    '憋笑.jpg',
    '你在狗叫什么.jpg',
    '请你吃粑粑.jpg',
  ]) {
    fs.writeFileSync(path.join(stickerDir, name), ONE_PIXEL_PNG)
  }
}

function createSkillFiles(dataDir) {
  const skillRoot = path.join(dataDir, 'ai-skills')
  for (const sub of ['core', 'modes', 'personas', 'lore']) mkdirp(path.join(skillRoot, sub))
  writeText(path.join(skillRoot, 'core', 'SKILL.core.md'), 'core safety fixture')
  writeText(path.join(skillRoot, 'modes', 'SKILL.friendly.md'), 'friendly mode fixture')
  writeText(path.join(skillRoot, 'lore', 'SKILL.wuwa-lore.md'), 'lore fixture')
  writeText(path.join(skillRoot, 'personas', 'SKILL.测试人格.md'), [
    '---',
    'name: 测试人格',
    'description: test persona',
    '---',
    'persona fixture',
  ].join('\n'))
}

function createTestDataDir(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dongxuelian-ai-test-'))
  mkdirp(dataDir)
  createSkillFiles(dataDir)
  createStickerFiles(path.join(dataDir, 'stickers'))
  for (const dir of ['conversations', 'user-profiles', 'political-handlers', 'ai-event-dumps']) mkdirp(path.join(dataDir, dir))

  writeText(path.join(dataDir, 'ai-openai-key.txt'), options.apiKey || 'sk-test-secret-123456')
  writeText(path.join(dataDir, 'ai-model.txt'), options.model || 'deepseek-v4-flash')
  writeText(path.join(dataDir, 'ai-provider.txt'), options.provider || 'opencode')
  writeText(path.join(dataDir, 'ai-base-url.txt'), options.baseURL || 'https://opencode.ai/zen/go/v1')
  writeText(path.join(dataDir, 'ai-enable-search.txt'), options.searchEnabled ? 'on' : 'off')
  writeText(path.join(dataDir, 'ai-enable-thinking.txt'), options.thinkingEnabled ? 'on' : 'off')
  writeText(path.join(dataDir, 'ai-deepseek-key.txt'), options.deepseekKey || 'sk-test-deepseek')
  writeText(path.join(dataDir, 'ai-dashscope-key.txt'), options.dashscopeKey || 'sk-test-dashscope')
  writeText(path.join(dataDir, 'ai-glm-key.txt'), options.glmKey || 'sk-test-glm')
  writeText(path.join(dataDir, 'ai-mimorium-key.txt'), options.mimoriumKey || 'sk-test-mimo')

  writeJson(path.join(dataDir, 'ai-repeat-enabled.json'), options.repeatEnabled || {})
  writeJson(path.join(dataDir, 'ai-random-whitelist.json'), options.randomWhitelist || [])
  writeJson(path.join(dataDir, 'ai-random-rate.json'), options.randomRate || {})
  writeJson(path.join(dataDir, 'political-detect-enabled.json'), options.politicalDetect || [])
  writeJson(path.join(dataDir, 'summary-whitelist.json'), options.summaryWhitelist || [])
  writeJson(path.join(dataDir, 'ai-user-blacklist.json'), [])
  writeJson(path.join(dataDir, 'video-blacklist.json'), { groups: [], users: [] })

  return {
    dataDir,
    pathFor: (...parts) => path.join(dataDir, ...parts),
    writeText: (relative, value) => writeText(path.join(dataDir, relative), value),
    writeJson: (relative, value) => writeJson(path.join(dataDir, relative), value),
    readText: relative => fs.readFileSync(path.join(dataDir, relative), 'utf8'),
    readJson: relative => JSON.parse(fs.readFileSync(path.join(dataDir, relative), 'utf8')),
    cleanup() {
      for (let i = 0; i < 5; i += 1) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
          return
        } catch (error) {
          if (i === 4) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        }
      }
    },
  }
}

function reloadPlugin() {
  const root = path.resolve(AI_ROOT) + path.sep
  for (const key of Object.keys(require.cache)) {
    const resolved = path.resolve(key)
    if (resolved === path.resolve(AI_ROOT) || resolved.startsWith(root)) delete require.cache[key]
  }
  return require(AI_INDEX)
}

function withDataEnv(dataDir) {
  const previous = process.env.DONGXUELIAN_AI_DATA_DIR
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  return () => {
    if (previous === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = previous
  }
}

module.exports = {
  ROOT,
  AI_ROOT,
  AI_INDEX,
  createTestDataDir,
  reloadPlugin,
  withDataEnv,
  writeText,
  writeJson,
}
