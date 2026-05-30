const fs = require('fs')
const os = require('os')
const path = require('path')

const PLUGIN_PATH = path.resolve(__dirname, '..', 'lib', 'index.js')

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n=== local-video-sender: ${title} ===`)
}

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  OK   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

function reloadPlugin() {
  delete require.cache[PLUGIN_PATH]
  return require(PLUGIN_PATH)
}

function makeCtx() {
  const commands = []
  const logs = []
  return {
    commands,
    logs,
    command(name, desc) {
      const command = {
        name,
        desc,
        action(fn) {
          commands.push({ name, desc, fn })
          return command
        },
      }
      return command
    },
    middleware() {},
    logger(name) {
      const push = (level, args) => logs.push({ level, name, msg: args.map(String).join(' ') })
      return {
        info: (...args) => push('info', args),
        warn: (...args) => push('warn', args),
        error: (...args) => push('error', args),
      }
    },
  }
}

function makeSession(overrides = {}) {
  const sent = []
  return {
    sent,
    userId: '100000000',
    guildId: '10001',
    channelId: '10001',
    isDirect: false,
    content: '',
    async send(message) {
      sent.push(String(message))
      return message
    },
    ...overrides,
  }
}

async function withIsolatedPlugin(fn) {
  const oldEnv = {
    BILI_COOKIES_FILE: process.env.BILI_COOKIES_FILE,
    BILI_WORKDIR: process.env.BILI_WORKDIR,
    BILI_MAX_SIZE_BYTES: process.env.BILI_MAX_SIZE_BYTES,
    BILI_TEST_VIDEO_FILE: process.env.BILI_TEST_VIDEO_FILE,
    DONGXUELIAN_AI_DATA_DIR: process.env.DONGXUELIAN_AI_DATA_DIR,
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-video-sender-'))
  const dataDir = path.join(tmpRoot, 'data')
  process.env.BILI_COOKIES_FILE = path.join(tmpRoot, 'cookies.txt')
  process.env.BILI_WORKDIR = path.join(tmpRoot, 'downloads')
  process.env.BILI_MAX_SIZE_BYTES = '1024'
  process.env.BILI_TEST_VIDEO_FILE = path.join(tmpRoot, 'test-video.mp4')
  process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
  delete require.cache[PLUGIN_PATH]

  try {
    const plugin = reloadPlugin()
    await fn({ plugin, tmpRoot })
  } finally {
    delete require.cache[PLUGIN_PATH]
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

function sampleInfo() {
  return {
    title: 'Demo Video',
    thumbnail: 'https://example.com/thumb.jpg',
    webpage_url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    formats: [
      { format_id: '30064', height: 720, vcodec: 'avc1', acodec: 'none', filesize: 900 },
      { format_id: '30280', vcodec: 'none', acodec: 'mp4a', abr: 132, filesize: 200 },
    ],
  }
}

async function run() {
  section('env config and pure parsing')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const config = plugin.getRuntimeConfig()
    check('cookies path uses env override', config.cookies === path.join(tmpRoot, 'cookies.txt'), JSON.stringify(config))
    check('workdir path uses env override', config.workdir === path.join(tmpRoot, 'downloads'), JSON.stringify(config))
    check('max size uses env override', config.maxSize === 1024, JSON.stringify(config))
    check('test video path uses env override', config.testVideoFile === path.join(tmpRoot, 'test-video.mp4'), JSON.stringify(config))
    check('video blacklist path uses shared data dir', config.videoBlacklistFile === path.join(tmpRoot, 'data', 'video-blacklist.json'), JSON.stringify(config))
    check('file URL helper emits standard file URL', plugin.toFileUrl(path.join(tmpRoot, 'downloads', 'demo.mp4')).startsWith('file:///'), plugin.toFileUrl(path.join(tmpRoot, 'downloads', 'demo.mp4')))
    check('no source hardcoded video blacklist by default', !plugin.isBlacklistedGroup(makeSession({ guildId: '942033342', channelId: '942033342' })))

    const bvUrl = plugin.extractBiliUrl('看看这个 BV1xx411c7mD')
    check('extracts BV id as canonical URL', bvUrl === 'https://www.bilibili.com/video/BV1xx411c7mD', bvUrl)

    const shareUrl = plugin.extractBiliUrl('https://b23.tv/abc123?x=1')
    check('extracts b23 share URL', shareUrl === 'https://b23.tv/abc123?x=1', shareUrl)

    const keys = plugin.buildBiliKeys('BV1xx411c7mD https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=1')
    check('builds normalized BV key', keys.includes('bv:1xx411c7md'), JSON.stringify(keys))
    check('builds normalized URL key', keys.includes('url:www.bilibili.com/video/bv1xx411c7md'), JSON.stringify(keys))
    check('builds shortest BV link for preview', plugin.getShortestBiliUrl(sampleInfo()) === 'https://b23.tv/BV1xx411c7mD', plugin.getShortestBiliUrl(sampleInfo()))
  })

  section('format picking')
  await withIsolatedPlugin(async ({ plugin }) => {
    const picked = plugin.pickFormat(sampleInfo())
    check('prefers explicit 720P candidate', picked && picked.format === '30064+30280', JSON.stringify(picked))
    check('computes split stream size', picked && picked.totalSize === 1100, JSON.stringify(picked))

    const fallback = plugin.pickFormat({
      formats: [
        { format_id: 'v720', height: 720, fps: 30, vcodec: 'avc1', acodec: 'none', filesize: 700 },
        { format_id: 'v480', height: 480, fps: 30, vcodec: 'avc1', acodec: 'none', filesize: 400 },
        { format_id: 'a1', vcodec: 'none', acodec: 'mp4a', abr: 160, filesize: 100 },
      ],
    })
    check('falls back to best 720 split stream', fallback && fallback.format === 'v720+a1', JSON.stringify(fallback))
  })

  section('commands and no-network send path')
  await withIsolatedPlugin(async ({ plugin, tmpRoot }) => {
    const ctx = makeCtx()
    plugin.apply(ctx)
    const testVideo = ctx.commands.find(command => command.name === 'sendtestvideo')
    check('registers sendtestvideo command', !!testVideo)
    const videoSegment = testVideo ? await testVideo.fn({ session: makeSession() }) : ''
    check('sendtestvideo uses env test file', String(videoSegment).includes('test-video.mp4'), String(videoSegment))

    plugin.clearRecentParseHistory()
    let runCalled = false
    const session = makeSession()
    const tooLarge = await plugin.downloadAndSend(
      ctx,
      session,
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => ({
          info: sampleInfo(),
          picked: { format: '30064+30280', label: '720P AVC', totalSize: 2048, height: 720 },
        }),
        run: async () => { runCalled = true },
      }
    )
    check('oversize video returns user-visible refusal', String(tooLarge).includes('太大') && String(tooLarge).includes('B 站'), String(tooLarge))
    check('oversize video sends info before refusal', session.sent.some(item => item.includes('Demo Video')), JSON.stringify(session.sent))
    check('oversize video sends short Bili link before refusal', session.sent.some(item => item.includes('https://b23.tv/BV1xx411c7mD')), JSON.stringify(session.sent))
    check('oversize video does not run downloader', !runCalled)
    check('workdir remains inside temp root', fs.existsSync(path.join(tmpRoot, 'downloads')))

    const dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'video-blacklist.json'), JSON.stringify({ groups: ['10001'], users: [] }), 'utf8')
    check('video blacklist blocks configured group', plugin.isBlacklistedGroup(makeSession({ guildId: '10001', channelId: '10001' })))
    fs.writeFileSync(path.join(dataDir, 'video-blacklist.json'), JSON.stringify({ groups: [], users: ['100000000'] }), 'utf8')
    check('video blacklist reloads and blocks configured user', plugin.isBlacklistedGroup(makeSession({ guildId: '10002', channelId: '10002', userId: '100000000' })))
    fs.writeFileSync(path.join(dataDir, 'video-blacklist.json'), JSON.stringify({ groups: [], users: [] }), 'utf8')
    check('video blacklist reloads cleared file', !plugin.isBlacklistedGroup(makeSession({ guildId: '10002', channelId: '10002', userId: '100000000' })))

    plugin.clearRecentParseHistory()
    let probeCount = 0
    const duplicateSession = makeSession()
    await plugin.downloadAndSend(
      ctx,
      duplicateSession,
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => {
          probeCount += 1
          return {
            info: sampleInfo(),
            picked: { format: '30064+30280', label: '720P AVC', totalSize: 2048, height: 720 },
          }
        },
      }
    )
    await plugin.downloadAndSend(
      ctx,
      duplicateSession,
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => {
          probeCount += 1
          return {
            info: sampleInfo(),
            picked: { format: '30064+30280', label: '720P AVC', totalSize: 2048, height: 720 },
          }
        },
      }
    )
    check('duplicate parse skips second probe', probeCount === 1, `probeCount=${probeCount}`)

    plugin.clearRecentParseHistory()
    let failedProbeCount = 0
    const failedFirst = await plugin.downloadAndSend(
      ctx,
      makeSession(),
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => {
          failedProbeCount += 1
          throw new Error('probe failed')
        },
      }
    )
    const failedSecond = await plugin.downloadAndSend(
      ctx,
      makeSession(),
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => {
          failedProbeCount += 1
          throw new Error('probe failed')
        },
      }
    )
    check('probe failure can be retried immediately', failedProbeCount === 2, `failedProbeCount=${failedProbeCount}`)
    check('probe failure keeps user-visible error', String(failedFirst).includes('Failed to probe') && String(failedSecond).includes('Failed to probe'), JSON.stringify({ failedFirst, failedSecond }))

    plugin.clearRecentParseHistory()
    let previewProbeCount = 0
    const previewFailSession = makeSession({
      async send() {
        const error = new Error('retcode: 1200 risk control')
        error.retcode = 1200
        throw error
      },
    })
    const previewFailure = await plugin.downloadAndSend(
      ctx,
      previewFailSession,
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => {
          previewProbeCount += 1
          return {
            info: sampleInfo(),
            picked: { format: '30064+30280', label: '720P AVC', totalSize: 2048, height: 720 },
          }
        },
        run: async () => { throw new Error('downloader should not run after preview send failure') },
      }
    )
    const previewRetry = await plugin.downloadAndSend(
      ctx,
      makeSession(),
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'BV1xx411c7mD',
      {
        probeVideo: async () => {
          previewProbeCount += 1
          return {
            info: sampleInfo(),
            picked: { format: '30064+30280', label: '720P AVC', totalSize: 2048, height: 720 },
          }
        },
      }
    )
    check('preview send failure returns controlled message', String(previewFailure).includes('Failed to send video preview'), String(previewFailure))
    check('preview send failure is logged and retry is not blocked', previewProbeCount === 2 && ctx.logs.some(log => log.msg.includes('preview send failed')) && String(previewRetry).includes('太大'), JSON.stringify({ previewProbeCount, logs: ctx.logs, previewRetry }))
  })

  section('boundary and edge cases')
  await withIsolatedPlugin(async ({ plugin }) => {
    var noUrl = plugin.extractBiliUrl('今天天气不错')
    check('boundary: non-Bili text returns null', noUrl === null, JSON.stringify(noUrl))

    var emptyFormat = plugin.pickFormat({ formats: [] })
    check('boundary: empty formats returns null', emptyFormat === null, JSON.stringify(emptyFormat))

    var noVideoFormat = plugin.pickFormat({ formats: [{ format_id: 'a1', vcodec: 'none', acodec: 'mp4a', abr: 128 }] })
    check('boundary: audio-only format returns null', noVideoFormat === null, JSON.stringify(noVideoFormat))

    var shortUrl = plugin.extractBiliUrl('BV1xx411c7mD')
    check('boundary: bare BV id extracts as canonical URL', shortUrl === 'https://www.bilibili.com/video/BV1xx411c7mD', shortUrl)
  })

  console.log(`\n=== local-video-sender summary ===`)
  console.log(`  passed: ${passed}`)
  console.log(`  failed: ${failed}`)
  if (failed) process.exitCode = 1
}

if (require.main === module) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { run }
